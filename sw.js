// geo.json (Kartenpunkte) wird nicht vorab geladen, aber beim ersten Abruf gespeichert (Offline-Ersatz).
// Netz zuerst (damit Updates sofort ankommen), Cache als Offline-Ersatz. API, Logos, Kacheln und Streams gehen immer direkt ins Netz.
// Bei jeder App-Änderung die Nummer erhöhen: Dann gilt beim nächsten Start die neue Version.
const CACHE = 'weltradio-v2';
const FILES = ['./', 'index.html', 'theme.js', 'style.css', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => fetch(f, { cache: 'no-cache' }).then(r => { if (r.ok) return c.put(f, r); }).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter(k => k !== CACHE);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim(); // die offene App lädt sich selbst neu, sobald nichts spielt (app.js: controllerchange)
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 'no-cache' = immer beim Server nachfragen; bei schlechtem Netz nach 4 s die gespeicherte Fassung nehmen.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req.url, { cache: 'no-cache' }).then(r => { if (r.ok) cache.put(req.url, r.clone()); return r; });
    const fallback = () => cache.match(req.url, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? cache.match('./') : undefined));
    net.catch(() => {});
    const timeout = new Promise(res => setTimeout(res, 4000)).then(fallback);
    try {
      const r = await Promise.race([net, timeout]);
      return r || await net;
    } catch {
      return (await fallback()) || Response.error();
    }
  })());
});
