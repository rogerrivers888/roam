// Fetching a picture from somewhere that is not Wikimedia, safely.
//
// The atlas harvest never needed this: Wikimedia renders a thumbnail at any
// width we ask for and tells us how big it came out, so `sources/harvest.js`
// downloads a known JPEG from a known host and is done. A logo on a
// restaurant's own server and a street-level frame on KartaView give us neither
// courtesy — whatever is at that URL is what we get, at whatever size it is.
//
// So this module does the three things the harvest got for free:
//
//   * a bounded fetch — a timeout, a byte ceiling, one redirect chain, and a
//     User-Agent that says who we are, because a venue's own server is somebody
//     small paying for their own bandwidth;
//   * a real content sniff, because a server that answers `image/jpeg` with an
//     HTML error page is common and a 404 page stored as a logo is worse than
//     no logo at all;
//   * the actual pixel dimensions, read out of the file's own header, because
//     `image_assets.width` is meant to be true and nothing here can resize.
//
// There is no image processing in the API — no sharp, no canvas — and this file
// deliberately does not add one. What a source gives us is what we store.

const TIMEOUT_MS = 8000;
const MAX_BYTES = 3_000_000;

export const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; place picture; rogerrivers@gmail.com)';

/**
 * What this file actually is, from its first bytes rather than from what the
 * server claimed. Returns null for anything that is not a raster image we can
 * hand to an <img>, which is how an HTML error page gets thrown away.
 *
 * SVG is deliberately excluded. A logo is very often an SVG and it would be the
 * sharpest thing on the card, but an SVG is a document: it can carry script and
 * can fetch remote references, and serving one from our own origin makes it our
 * problem. A 180px apple-touch-icon PNG is enough for a 56px tile.
 */
export function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF89a' || buf.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  return null;
}

/**
 * How big it is, in pixels, read from the file's own header.
 *
 * Each format states its size in a fixed place near the front, so this is a few
 * lines of pointer arithmetic rather than a decode. JPEG is the awkward one: the
 * size lives in a start-of-frame marker that can sit after any number of other
 * segments, so the segment chain has to be walked. Returns nulls rather than
 * throwing — a picture whose dimensions we could not read is still a picture,
 * and `width`/`height` are nullable columns.
 */
export function dimensions(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const kind = buf.subarray(12, 16).toString('ascii');
      // Lossy: the 14-bit dimensions sit after the VP8 frame tag and sync code.
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      // Lossless: 14 bits each, packed across four bytes after the signature.
      if (kind === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      // Extended: the canvas size, minus one, little-endian over three bytes.
      if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      return { width: null, height: null };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        // Standalone markers carry no length; everything else does.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0…SOF15, excluding the four that are not start-of-frame at all.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* a truncated or unusual header is not worth an exception */ }
  return { width: null, height: null };
}

/**
 * Fetch one picture.
 *
 * Returns `{ body, mime, bytes, width, height }`, or null for anything that did
 * not answer, answered too big, or answered with something that is not an
 * image. Never throws: a source that is down means this place has no picture
 * this time, and the ladder simply moves on.
 */
export async function fetchPicture(url, { maxBytes = MAX_BYTES, timeout = TIMEOUT_MS } = {}) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA, accept: 'image/*' } });
    if (!res.ok) return null;
    // Believe the length when it is offered, so an oversized file is refused
    // before it is transferred rather than after.
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > maxBytes) return null;
    const mime = sniff(body);
    if (!mime) return null;
    const { width, height } = dimensions(body, mime);
    return { body, mime, bytes: body.length, width, height, url: res.url || url };
  } catch { return null; } finally { clearTimeout(timer); }
}

/** One page of HTML, bounded the same way `sources/site.js` bounds its own read. */
export async function fetchHtml(url, { maxBytes = 1_500_000, timeout = TIMEOUT_MS } = {}) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok) return null;
    if (!/text\/html|xhtml/i.test(res.headers.get('content-type') || '')) return null;
    return { url: res.url || url, html: (await res.text()).slice(0, maxBytes) };
  } catch { return null; } finally { clearTimeout(timer); }
}
