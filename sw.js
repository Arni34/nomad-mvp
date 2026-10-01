// Офлайн-кэш: после первого визита NOMAD открывается вообще без интернета.
// Стратегия: отдаём из кэша сразу, а в фоне обновляем кэш, если сеть есть.
// Меняйте версию при каждом релизе: так открытые страницы узнают об обновлении сразу.
const CACHE = 'nomad-v4';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'src/app.js', 'src/util.js', 'src/protocol.js', 'src/sbd.js', 'src/sim.js', 'src/messenger.js',
];

self.addEventListener('install', e => {
  // cache: 'reload' — берём свежие файлы мимо HTTP-кэша, иначе новая версия может закэшироваться старой
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request)
      .then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; })
      .catch(() => hit || Response.error());
    return hit || fresh;
  }));
});
