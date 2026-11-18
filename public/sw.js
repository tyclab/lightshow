// Network-first shell cache for server outages. Never cache live api/ or socket.io/ traffic.
// Every path is the worker's own scope, so a proxy may serve the app under a path prefix.

// v3: the TycStation icons and stylesheet, no webfont.
const CACHE = 'lightshow-shell-v3';
const SCOPE = new URL(self.registration.scope);
const SHELL = [
  './',
  'style.css',
  'app.bundle.js',
  'theme.js',
  'auth.js',
  'toast.js',
  'manifest.webmanifest',
  'favicon.svg',
  'icons/icon-192.png',
].map((p) => new URL(p, SCOPE).href);

// The page's chunks, named by their content: the build lists them (every
// load after this one caches whatever a newer build has, as it fetches them).
async function chunks() {
  const res = await fetch(new URL('chunks/index.json', SCOPE), { cache: 'no-store' });
  const list = res.ok ? await res.json() : [];
  return Array.isArray(list)
    ? list.filter((p) => typeof p === 'string' && p.startsWith('chunks/')).map((p) => new URL(p, SCOPE).href)
    : [];
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then(async (cache) => {
      await cache.addAll(SHELL);
      await cache.addAll(await chunks());
    })
    .catch(() => { /* a missing file must not stop the worker installing */ })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Nothing outside the app's own scope, such as the page that frames it.
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const path = url.pathname.slice(SCOPE.pathname.length);
  if (path.startsWith('api/') || path.startsWith('socket.io/')) return;

  event.respondWith(fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Any page of the app is the app.
    if (request.mode === 'navigate') return (await caches.match(SCOPE.href)) || Response.error();
    return Response.error();
  }));
});
