/*
 * Roam's service worker: the part that makes the app open at all with no signal.
 *
 * The device's copy of the household's data lives in IndexedDB and is managed
 * by the app (src/offline/cache.ts). This file is only about the app itself —
 * the bundle, the fonts, the icons — because none of that is any use in a
 * pocket if the page cannot load in the first place.
 *
 * Two rules it must not break:
 *   • Nothing from /api is cached here. Every API answer is subject to a licence
 *     (Technical Constraints §4) and the decision about which ones may be kept
 *     is made in one place, offline/policy.ts, not twice.
 *   • Place photos are licensed content streamed through the API and are never
 *     stored, here or anywhere.
 */

const VERSION = 'roam-shell-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

// The document itself, so a cold start with no signal still has something to
// open. Everything else is cached as it is first used.
const PRECACHE = ['/', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(PRECACHE.map((p) => c.add(new Request(p, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isAsset = (url) =>
  /\.(js|css|woff2?|ttf|otf|png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname)
  || url.hostname === 'fonts.googleapis.com'
  || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  // Anything the API says is the app's business, not the shell's.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  // The page itself: try the network so a deploy is picked up, fall back to the
  // copy so a tunnel is not a blank screen.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/', { ignoreSearch: true }).then((hit) => hit || Response.error())),
    );
    return;
  }

  // The bundle, the fonts, the icons: serve what we have and quietly refresh it,
  // because the file names carry their own hash and never change underneath us.
  if (isAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const live = fetch(request)
          .then((res) => {
            if (res && (res.ok || res.type === 'opaque')) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(request, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit);
        return hit || live;
      }),
    );
  }
});

// The app asks for the newest worker when the household taps "update".
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
