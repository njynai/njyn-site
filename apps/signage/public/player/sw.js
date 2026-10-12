// Offline support for the player. The player's own files are network-first so
// updates land on the next load; media is cache-first and pre-downloaded when
// the manifest changes, so playback survives losing the connection.

const SHELL_CACHE = 'signage-shell-v1';
const MEDIA_CACHE = 'signage-media-v1';
const SHELL = ['./', 'index.html', 'player.css', 'player.js', 'schedule.js', 'widgets.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (![SHELL_CACHE, MEDIA_CACHE].includes(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/media/')) e.respondWith(media(e.request, url));
  else if (url.pathname.startsWith('/player/')) e.respondWith(shell(e.request));
});

async function shell(request) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(SHELL_CACHE)).put(request, res.clone());
    return res;
  } catch {
    return (await caches.match(request, { ignoreSearch: true })) || Response.error();
  }
}

const mediaKey = (url) => new Request(url.origin + url.pathname);

async function media(request, url) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(mediaKey(url));
  if (cached) return request.headers.has('range') ? sliceRange(cached, request.headers.get('range')) : cached;
  return fetch(request); // not downloaded yet: stream from the server meanwhile
}

// <video> asks for byte ranges; answer them from the cached full file.
async function sliceRange(response, range) {
  const blob = await response.blob();
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return new Response(blob, { status: 200, headers: response.headers });
  let start, end;
  if (m[1] === '') { start = Math.max(blob.size - Number(m[2]), 0); end = blob.size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? blob.size - 1 : Math.min(Number(m[2]), blob.size - 1); }
  if (start >= blob.size || start > end) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'content-type': response.headers.get('content-type') || 'application/octet-stream',
      'content-range': `bytes ${start}-${end}/${blob.size}`,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
    },
  });
}

// Download every file the manifest uses and drop the ones it no longer uses.
let syncing = Promise.resolve();
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'sync-media') return;
  syncing = syncing.then(() => syncMedia(e.data.urls)).catch((err) => console.warn('media sync', err));
  e.waitUntil(syncing);
});

async function syncMedia(urls) {
  const cache = await caches.open(MEDIA_CACHE);
  const wanted = new Set(urls.map((u) => mediaKey(new URL(u, location.origin)).url));
  for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
  for (const u of wanted) {
    if (await cache.match(u)) continue;
    try {
      const res = await fetch(u);
      if (res.ok && res.status === 200) await cache.put(u, res);
    } catch (err) {
      console.warn('could not cache', u, err); // retried on the next manifest change or reload
    }
  }
}
