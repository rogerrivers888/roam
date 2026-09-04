// The Wikimedia projects, read as a gazetteer and a picture library.
//
// Three endpoints, no key, no account, no bill (the owner asked whether he had
// to set anything up: for everything in this file, he does not):
//
//   query.wikidata.org   SPARQL. What is in a county, how notable it is, where
//                        it is, what it is called, what type of thing it is.
//                        Data is CC0.
//   wikimedia.org/api    Pageviews. How many people looked an article up over
//                        the last twelve months, which is the only signal here
//                        that measures interest rather than completeness.
//   commons.wikimedia.org/w/api.php
//                        The photographs, and — the part that matters — their
//                        licence, their creator and the page where both are
//                        stated, which is the attribution URL Roam has to keep
//                        and show.
//
// What we owe them in return is set out in the Wikimedia User-Agent policy:
// identify yourself, give a contact, and do not hammer it. `UA` names Roam and
// carries a URL; `paced()` keeps every caller to one request at a time with a
// gap; and nothing here runs on a household's request — the harvest is a back
// office job, so a slow Wikidata query never makes a screen wait.
//
// Two things this file deliberately does not do:
//
//   * It never downloads an image whose licence it could not read. `may_store`
//     comes back false and the caller drops it, because "we could not tell" and
//     "it is free" are different answers and only one of them is safe.
//   * It never asks Wikimedia for an arbitrary thumbnail width. Their renderer
//     serves a fixed set of buckets and 400px is not one of them (it answers
//     400 Bad Request); the API tells us the URL of the nearest bucket it will
//     serve, and that is the URL we fetch.

const SPARQL = 'https://query.wikidata.org/sparql';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
const PAGEVIEWS = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';

/**
 * Who we are. The Wikimedia policy asks for a real contact, and a bot that does
 * not give one gets blocked without warning — so this is not cosmetic.
 */
export const UA = 'RoamBot/1.0 (https://web-production-afce9.up.railway.app; roam atlas harvest; rogerrivers@gmail.com)';

const SPARQL_TIMEOUT = 60_000;   // WDQS's own ceiling is 60s; a county takes ~2s
const API_TIMEOUT = 20_000;
const GAP_MS = 120;              // ~8 requests a second, well inside anything they ask for

let queue = Promise.resolve();

/**
 * One request at a time, with a gap.
 *
 * Serial rather than a token bucket because the harvest is not in a hurry: a
 * county is a couple of hundred requests and the whole United Kingdom runs
 * overnight. Being unambiguously polite is worth more than being fast, since
 * the cost of getting this wrong is Wikimedia blocking the Railway IP.
 */
function paced(fn) {
  const run = queue.then(async () => {
    const out = await fn();
    await new Promise((r) => setTimeout(r, GAP_MS));
    return out;
  });
  queue = run.catch(() => {});
  return run;
}

async function getJson(url, { timeout = API_TIMEOUT, accept = 'application/json' } = {}) {
  return paced(async () => {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const why = (await res.text().catch(() => '')).slice(0, 200);
      throw Object.assign(new Error(`${new URL(url).hostname} ${res.status}: ${why}`), { status: res.status });
    }
    return res.json();
  });
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

/**
 * Run a SPARQL query.
 *
 * `hint:Query hint:optimizer "None"` appears in every query below and is the
 * difference between two seconds and a timeout. WDQS's planner reorders a
 * `wdt:P131*` walk into something pathological; told to run the clauses in the
 * order they are written — county first, then the articles — it is fast.
 */
export async function sparql(query) {
  const url = `${SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const data = await getJson(url, { timeout: SPARQL_TIMEOUT, accept: 'application/sparql-results+json' });
  return (data?.results?.bindings ?? []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = v.value;
    return out;
  });
}

const qid = (uri) => (uri ? String(uri).split('/').pop() : null);

/**
 * The roots of "somewhere to go".
 *
 * Chosen for what a family would call a day out, not for taxonomic tidiness.
 * A restaurant is not here on purpose — the owner: "I don't care about
 * restaurant images… with restaurants it's more about reviews and the menus."
 */
export const ATTRACTION_ROOTS = {
  Q570116: 'landmark',   // tourist attraction
  Q33506: 'museum',      // museum
  Q207694: 'arts',       // art museum
  Q22698: 'outdoors',    // park
  Q1107656: 'outdoors',  // garden
  Q167346: 'outdoors',   // botanical garden
  Q473972: 'outdoors',   // protected area
  Q179049: 'outdoors',   // nature reserve
  Q1802963: 'outdoors',  // beach
  Q35509: 'outdoors',    // cave
  Q34038: 'outdoors',    // waterfall
  Q23413: 'heritage',    // castle
  Q16560: 'heritage',    // palace
  Q2087181: 'heritage',  // historic house museum
  Q839954: 'heritage',   // archaeological site
  Q4989906: 'heritage',  // monument
  Q38720: 'heritage',    // windmill
  // Churches were the largest hole in the first version of this list: nothing
  // in the tree above put Canterbury Cathedral in Kent, which is the county's
  // best-known place to go. Parish churches come in with them and stay out of
  // the published set on their score rather than by being unlisted, which is
  // the right way round — a village church that people actually visit should be
  // able to earn its place.
  Q16970: 'heritage',    // church building (cathedrals and abbeys are under it)
  Q2977: 'heritage',     // cathedral
  Q44613: 'heritage',    // monastery
  Q4663971: 'heritage',  // abbey
  Q1497375: 'heritage',  // pilgrimage site
  Q39715: 'landmark',    // lighthouse
  Q12280: 'landmark',    // bridge
  Q15897166: 'landmark', // pier
  Q179700: 'arts',       // statue
  Q24354: 'arts',        // theatre building
  Q1060829: 'arts',      // concert hall
  Q43501: 'animals',     // zoo
  Q2281788: 'animals',   // aquarium
  Q194195: 'family',     // amusement park
  Q420962: 'family',     // heritage railway
  Q1251750: 'family',    // distillery (and by subclass, breweries with a tour)
  Q1076486: 'active',    // sports venue
  Q1777138: 'active',    // race track
};

/**
 * Every Wikidata type that descends from one of those roots — about 5,300 of
 * them — with the root it came from, so each can be given a Roam category.
 *
 * Asked once and cached in `place_kinds`, because a subclass tree does not
 * change between Tuesdays and because doing this per county would put the
 * traversal inside every query and make each one take half a minute.
 */
export async function attractionKinds() {
  const roots = Object.keys(ATTRACTION_ROOTS).map((q) => `wd:${q}`).join(' ');
  const rows = await sparql(`
    SELECT ?type ?root WHERE {
      VALUES ?root { ${roots} }
      ?type wdt:P279* ?root .
    }`);
  const byType = new Map();
  for (const r of rows) {
    const t = qid(r.type); const root = qid(r.root);
    // A type under two roots takes the first, which is the order above: the
    // specific roots come before the general ones so a zoo stays an animals
    // place rather than becoming a generic landmark.
    if (!byType.has(t)) byType.set(t, { qid: t, rootQid: root, category: ATTRACTION_ROOTS[root] ?? 'landmark' });
  }
  return [...byType.values()];
}

/**
 * Everything notable inside an administrative area that has an English
 * Wikipedia article.
 *
 * Deliberately broad, and filtered afterwards against `place_kinds`. Asking
 * Wikidata to do the filtering means a subclass traversal inside the walk,
 * which took 24 seconds and returned 15 rows for Berkshire where this returns
 * 400 in two — and missed Legoland, because the query planner and the truth
 * disagree about what an amusement park is.
 *
 * `sitelinks > 1` is the floor: an item with one sitelink is an article on one
 * wiki and nothing else, and there are hundreds of thousands of them.
 *
 * The row limit is high because a row is not an item: an item comes back once
 * per heritage designation it holds, so a county of listed buildings uses
 * several rows each. At 600 Kent truncated to 516 items and lost Canterbury
 * Cathedral before anything had a chance to rank it.
 */
export async function areaCandidates(regionQid, { limit = 3000, minSitelinks = 1 } = {}) {
  const rows = await sparql(`
    SELECT ?item ?itemLabel ?desc ?sitelinks ?img ?article ?lat ?lng ?osm ?commonsCat ?site ?heritageLabel
           (MAX(?visitorsRaw) AS ?visitors) (SAMPLE(?operator) AS ?operatorAny)
           (GROUP_CONCAT(DISTINCT STRAFTER(STR(?type), "entity/"); separator=",") AS ?types) WHERE {
      hint:Query hint:optimizer "None" .
      ?item wdt:P131* wd:${regionQid} ; wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks > ${minSitelinks})
      ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
      ?item wdt:P31 ?type .
      OPTIONAL { ?item wdt:P18 ?img }
      OPTIONAL { ?item wdt:P402 ?osm }
      OPTIONAL { ?item wdt:P373 ?commonsCat }
      OPTIONAL { ?item wdt:P856 ?site }
      # Two properties that say a place is open to the public rather than merely
      # notable. Visitors per year is the strongest signal there is — nobody
      # publishes a visitor count for a house you cannot go into — and an
      # operator is the National Trust, a council or a company running it as
      # somewhere people go. Without these the ranking puts John Lennon's former
      # house above Legoland, which is how it behaved before they were added.
      OPTIONAL { ?item wdt:P1174 ?visitorsRaw }
      OPTIONAL { ?item wdt:P137 ?operator }
      OPTIONAL { ?item wdt:P1435 ?heritage . ?heritage rdfs:label ?heritageLabel FILTER(lang(?heritageLabel) = "en") }
      OPTIONAL { ?item p:P625/psv:P625 ?co . ?co wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng . }
      OPTIONAL { ?item schema:description ?desc FILTER(lang(?desc) = "en") }
      ?item rdfs:label ?itemLabel . FILTER(lang(?itemLabel) = "en")
    }
    GROUP BY ?item ?itemLabel ?desc ?sitelinks ?img ?article ?lat ?lng ?osm ?commonsCat ?site ?heritageLabel
    ORDER BY DESC(?sitelinks) LIMIT ${limit}`);

  const byItem = new Map();
  for (const r of rows) {
    const id = qid(r.item);
    const existing = byItem.get(id);
    // The same item comes back once per heritage designation; keep the first
    // and merge the type lists rather than letting a Grade I listed building
    // outrank itself twice.
    if (existing) {
      existing.kinds = [...new Set([...existing.kinds, ...String(r.types || '').split(',').filter(Boolean)])];
      if (!existing.heritage && r.heritageLabel) existing.heritage = r.heritageLabel;
      continue;
    }
    byItem.set(id, {
      wikidataId: id,
      name: r.itemLabel,
      description: r.desc ?? null,
      sitelinks: Number(r.sitelinks) || 0,
      imageFile: r.img ? decodeURIComponent(String(r.img).split('/').pop()).replace(/_/g, ' ') : null,
      wikipediaUrl: r.article ?? null,
      wikipediaTitle: r.article ? decodeURIComponent(String(r.article).split('/wiki/').pop()).replace(/_/g, ' ') : null,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      osmRef: r.osm ?? null,
      commonsCategory: r.commonsCat ?? null,
      website: r.site ?? null,
      heritage: r.heritageLabel ?? null,
      visitorsPerYear: r.visitors != null ? Number(r.visitors) || null : null,
      hasOperator: Boolean(r.operatorAny),
      kinds: String(r.types || '').split(',').filter(Boolean),
    });
  }
  return [...byItem.values()];
}

// ---------------------------------------------------------------------------
// Wikipedia: the interest signal, and the description
// ---------------------------------------------------------------------------

const monthsAgo = (n) => {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};
const stamp = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * How many people read this article in the last twelve months, human traffic
 * only (`user`, which excludes crawlers and Wikipedia's own bots).
 *
 * Returns null rather than 0 when the API has no data: an article created last
 * month has no year of views, and scoring it as "nobody looked" would bury
 * every new attraction for a year.
 */
export async function pageviewsYear(title) {
  const path = encodeURIComponent(String(title).replace(/ /g, '_'));
  const url = `${PAGEVIEWS}/${path}/monthly/${stamp(monthsAgo(12))}/${stamp(monthsAgo(1))}`;
  try {
    const data = await getJson(url);
    const items = data?.items ?? [];
    if (!items.length) return null;
    return items.reduce((n, i) => n + (i.views || 0), 0);
  } catch (err) {
    if (err.status === 404) return null;   // no data for this title, which is not an error
    throw err;
  }
}

/** The opening paragraphs, CC BY-SA, to be shown with a credit and a link. */
export async function articleExtract(title) {
  const p = new URLSearchParams({
    action: 'query', prop: 'extracts', titles: title, exintro: '1', explaintext: '1',
    exsentences: '4', format: 'json', redirects: '1', origin: '*',
  });
  const data = await getJson(`${WIKIPEDIA}?${p}`);
  const page = Object.values(data?.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  return (page.extract || '').trim() || null;
}

// Wikipedia articles carry the site's own furniture as well as photographs:
// maps, flags, edit pencils, the Commons logo, featured-article stars. None of
// them is a picture of the place.
const CHROME = /^File:(Commons-logo|Cscr-featured|OOjs|Red pog|Blue pog|Green pog|Pending-protection|Wikisource|Wikiquote|Wiktionary|Question book|Ambox|Edit-|Symbol |Semi-protection|Loudspeaker|Sound-icon|Folder|Nuvola|Crystal |Gnome-|Increase2?|Decrease2?|Steady2?|Flag of|Coat of arms|Arms of|Location map|.* location map|.*locator map|.*UK location map)/i;
const NOT_A_PHOTO = /\.(svg|png|gif|tif|tiff|webp|ogv|ogg|pdf|djvu|xcf)$/i;

/**
 * The pictures an article actually uses, in the order the editors put them.
 *
 * A better source of a gallery than the Commons category, which is a filing
 * system rather than a selection: Category:Windsor Castle contains a photograph
 * of a Kia Sorento. What is *in the article* has been through an editor.
 */
export async function articleImages(title, { limit = 24 } = {}) {
  const p = new URLSearchParams({
    action: 'query', prop: 'images', titles: title, imlimit: String(limit * 2),
    format: 'json', redirects: '1', origin: '*',
  });
  const data = await getJson(`${WIKIPEDIA}?${p}`);
  const page = Object.values(data?.query?.pages ?? {})[0];
  return (page?.images ?? [])
    .map((i) => i.title)
    .filter((t) => !CHROME.test(t) && !NOT_A_PHOTO.test(t))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Commons: the pictures, and the terms they come under
// ---------------------------------------------------------------------------

const stripTags = (html) => (html ? String(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null : null);
const firstHref = (html) => {
  const m = html && String(html).match(/href="([^"]+)"/);
  if (!m) return null;
  return m[1].startsWith('//') ? `https:${m[1]}` : m[1];
};

/**
 * Licences that permit keeping the bytes and republishing them.
 *
 * An allow-list, not a deny-list. Commons carries plenty that looks free and is
 * not — fair-use logos, "non-commercial only", images with a `Restrictions`
 * note about trademark or personality rights — and the failure mode of a
 * deny-list is that the one we did not think of gets stored.
 */
const STORABLE = [
  /^cc[ -]?by([ -]sa)?([ -][0-9.]+)?$/i,
  /^cc[ -]?0/i, /^cc0/i,
  /^public domain/i, /^pd[- ]/i, /^no restrictions$/i,
  /^attribution$/i,
  /^ogl/i,                                   // UK Open Government Licence
  /^gfdl/i,                                  // usually dual-licensed with CC BY-SA
];
const NEVER = /non[- ]commercial|nc\b|no derivative|nd\b|fair use|copyright|all rights reserved/i;

function readLicence(meta = {}) {
  const short = stripTags(meta.LicenseShortName?.value) || stripTags(meta.UsageTerms?.value) || null;
  const restrictions = stripTags(meta.Restrictions?.value) || null;
  const terms = stripTags(meta.UsageTerms?.value) || null;
  const permitted =
    Boolean(short) &&
    STORABLE.some((re) => re.test(short.trim())) &&
    !NEVER.test(short) &&
    !NEVER.test(terms || '') &&
    // Commons' own warning field. "trademarked" or "personality" means the
    // licence covers the copyright and something else does not; we do not take
    // those, because the whole promise of this library is that everything in it
    // is safe to put on a card.
    !restrictions;
  return {
    licence: short || 'unknown',
    licenceUrl: meta.LicenseUrl?.value ?? null,
    usageTerms: terms,
    restrictions,
    // CC0 and public domain ask for nothing; everything else asks to be
    // credited, and Commons says which in a field of its own.
    attributionRequired: /^(cc[ -]?0|cc0|public domain|pd[- ])/i.test(short || '')
      ? false
      : String(meta.AttributionRequired?.value ?? 'true') !== 'false',
    mayStore: permitted,
  };
}

/**
 * Everything about a set of Commons files — the licence, the creator, the page
 * that states both, and a URL for a thumbnail at roughly the width asked for.
 *
 * Batched fifty at a time because that is the API's limit for `titles`, and one
 * request per width because `iiurlwidth` takes a single value.
 */
export async function fileDetails(titles, { widths = [20, 500, 960] } = {}) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    for (const [n, width] of widths.entries()) {
      const p = new URLSearchParams({
        action: 'query', prop: 'imageinfo', titles: batch.join('|'),
        // The metadata only has to come back once; the other passes are only
        // after a thumbnail URL.
        iiprop: n === 0 ? 'url|size|mime|extmetadata' : 'url|size',
        iiurlwidth: String(width), iiextmetadatafilter:
          'LicenseShortName|LicenseUrl|UsageTerms|AttributionRequired|Restrictions|Artist|Credit|ImageDescription|ObjectName|DateTimeOriginal',
        format: 'json', redirects: '1', origin: '*',
      });
      const data = await getJson(`${COMMONS}?${p}`);
      // `normalized`/`redirects` mean the title we asked for is not always the
      // title that comes back; keep both so the caller can match either.
      const alias = new Map();
      for (const r of [...(data?.query?.normalized ?? []), ...(data?.query?.redirects ?? [])]) alias.set(r.to, r.from);

      for (const page of Object.values(data?.query?.pages ?? {})) {
        const info = page.imageinfo?.[0];
        if (!info) continue;
        const key = page.title;
        let row = out.get(key);
        if (!row) {
          const meta = info.extmetadata ?? {};
          const artistHtml = meta.Artist?.value ?? null;
          const licence = readLicence(meta);
          row = {
            title: key,
            askedAs: alias.get(key) ?? key,
            descriptionUrl: (info.descriptionurl || '').split('?')[0] || null,
            originalUrl: (info.url || '').split('?')[0] || null,
            width: info.width ?? null,
            height: info.height ?? null,
            mime: info.mime ?? null,
            creator: stripTags(artistHtml),
            creatorUrl: firstHref(artistHtml),
            caption: stripTags(meta.ImageDescription?.value)?.slice(0, 600) ?? null,
            objectName: stripTags(meta.ObjectName?.value) ?? null,
            ...licence,
            thumbs: {},
          };
          out.set(key, row);
        }
        if (info.thumburl) {
          row.thumbs[width] = {
            url: info.thumburl.split('?')[0],
            width: info.thumbwidth ?? null,
            height: info.thumbheight ?? null,
          };
        }
      }
    }
  }
  return out;
}

/** Fetch the bytes of one thumbnail. Returns null rather than throwing on a 404. */
export async function fetchImage(url) {
  return paced(async () => {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://commons.wikimedia.org/' },
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    // A Wikimedia error page comes back as HTML with a 200 in some caches;
    // storing that as a JPEG is how a library fills up with 2KB of markup.
    if (!type.startsWith('image/')) return null;
    return { mime: type.split(';')[0], body: Buffer.from(await res.arrayBuffer()) };
  });
}
