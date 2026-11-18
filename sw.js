'use strict';

// Bump VERSION on any deploy that changes cached app files (vendor/, core.js, app.js, styles.css, index.html).
const VERSION = 'vpf-v19';
const DATA_TTL_MS = 7 * 24 * 60 * 60 * 1000; // weekly data: served from cache for up to a week
const SCOPE = self.registration.scope;       // works on user.github.io/<repo>/ as well as on a custom domain
const abs = p => new URL(p, SCOPE).href;

const APP_SHELL = [
  './', 'index.html', 'styles.css', 'core.js', 'app.js', 'manifest.json', 'parking_zones.geojson',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/leaflet-maplibre-gl.js',
  'icons/icon-192.png', 'icons/icon-512.png',
].map(abs);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache =>
      // allSettled: one missing file must not abort the whole install
      Promise.allSettled(APP_SHELL.map(url => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

async function dataStrategy(request, url) {
  const cache = await caches.open(VERSION);
  const key = new Request(url.origin + url.pathname);
  const bypass = url.searchParams.has('fresh');
  const cached = await cache.match(key);

  if (cached && !bypass) {
    const fetchedAt = Number(cached.headers.get('x-sw-fetched-at') || 0);
    if (Date.now() - fetchedAt < DATA_TTL_MS) return cached;
  }
  try {
    const net = await fetch(key, { cache: 'no-cache' });
    if (net.ok) {
      const headers = new Headers(net.headers);
      headers.set('x-sw-fetched-at', String(Date.now()));
      await cache.put(key, new Response(await net.clone().blob(), { status: net.status, statusText: net.statusText, headers }));
    }
    return net;
  } catch (err) {
    if (cached) return cached; // offline: stale data beats no data
    throw err;
  }
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const net = await fetch(request);
    if (net.ok) cache.put(request, net.clone());
    return net;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const net = await fetch(request);
  if (net.ok) cache.put(request, net.clone());
  return net;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // map tiles, City API, Nominatim: straight to network

  const path = url.pathname;
  if (/\/data\/[^/]+\.json$/.test(path)) event.respondWith(dataStrategy(request, url));
  else if (/\/vendor\//.test(path) || /\/icons\//.test(path)) event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request)); // html/js/css: new deploys show up on next load
});
