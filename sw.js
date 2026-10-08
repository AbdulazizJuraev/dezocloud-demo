// DezoCloud xizmat ishchisi (Service Worker): offlayn ishlash.
//  - ilova qobig'i (HTML/CSS/JS/belgilar): internet bor bo'lsa yangisi, yo'q bo'lsa saqlangani
//  - kutubxona ro'yxati (API): internet bor bo'lsa yangisi, yo'q bo'lsa oxirgi ko'rilgani
//  - eskizlar: tez ochilishi va offlayn ko'rinishi uchun saqlanadi
//  - "Offlayn saqlash" bosilgan fayllar to'liq ko'rinadi (video ham, Range bilan)
const V = 'v3';
const C_SHELL = 'dc-shell-' + V;
const C_API = 'dc-api-' + V;
const C_THUMBS = 'dc-thumbs-' + V;
const C_OFFLINE = 'dc-offline';                 // versiyaga bog'liq emas: foydalanuvchi saqlagan fayllar

const SHELL = [
  '/offline.html', '/css/app.css', '/js/app.js', '/js/util.js', '/js/uploader.js', '/js/viewer.js', '/js/exif.js',
  '/logo-light.png', '/logo-dark.png', '/favicon.png', '/favicon-32.png', '/apple-touch-icon.png', '/manifest.webmanifest',
];
// Offlayn ham ko'rsatiladigan API manzillari (faqat o'qish)
const API_OK = /^\/api\/(me|stats|albums|places|trash|storage|limits|plans|media)$/;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(C_SHELL);
    await Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== C_SHELL && k !== C_API && k !== C_THUMBS && k !== C_OFFLINE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

const okToCache = (r) => r && r.ok && !r.redirected && r.type === 'basic';

async function networkFirst(req, cacheName, { timeout = 0 } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const res = await (timeout ? Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout))]) : fetch(req));
    if (okToCache(res)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);   // eng eskilari (kiritilish tartibida)
}

async function thumb(req) {
  const cache = await caches.open(C_THUMBS);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (okToCache(res)) { cache.put(req, res.clone()).then(() => trim(C_THUMBS, 4000)); }
    return res;
  }).catch(() => null);
  if (hit) { net.catch(() => {}); return hit; }          // tez: saqlangani, orqada yangilanadi
  return (await net) || new Response('', { status: 504 });
}

// To'liq fayl: offlayn saqlangan bo'lsa shundan (Range bilan), aks holda tarmoqdan
async function file(req) {
  const cache = await caches.open(C_OFFLINE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (!hit) return fetch(req);
  const range = req.headers.get('Range');
  if (!range) return hit;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const blob = await hit.blob();
  const size = blob.size;
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }   // "bytes=-500"
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function navigate(req) {
  const cache = await caches.open(C_SHELL);
  try {
    const res = await fetch(req);
    if (okToCache(res) && new URL(req.url).pathname === '/') cache.put('/', res.clone());
    return res;
  } catch {
    const hit = (await cache.match(req)) || (await cache.match('/')) || (await cache.match('/offline.html'));
    return hit || new Response('Internet yo\'q', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;

  if (p.startsWith('/f/')) return void e.respondWith(file(req));
  if (p.startsWith('/t/')) return void e.respondWith(thumb(req));
  if (API_OK.test(p)) return void e.respondWith(networkFirst(req, C_API, { timeout: 8000 }));
  if (p.startsWith('/api/') || p.startsWith('/s/') || p.startsWith('/v/') || p === '/sw.js') return;   // faqat tarmoq
  if (req.mode === 'navigate') return void e.respondWith(navigate(req));
  e.respondWith(networkFirst(req, C_SHELL));
});
