// Service worker: guarda la "carcasa" de la app para abrirla sin conexión,
// y sirve las teselas de mapa que se guardaron con "Preparar salida sin cobertura".
// Los datos (clima, citas, fotos) siempre se piden en directo a la red.
const CACHE = "setometro-v3";
const TILES = "setometro-tiles";
const SHELL = ["./", "index.html", "app.js", "especies.js", "icon.svg", "manifest.webmanifest",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
const TILE_HOSTS = /^https:\/\/([abc]\.tile\.opentopomap\.org|tile\.openstreetmap\.org|server\.arcgisonline\.com)\//;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = e.request.url;
  if (TILE_HOSTS.test(url)) {
    // teselas: primero la red; si no hay cobertura, la copia guardada (con cualquier subdominio a/b/c)
    const key = url.replace(/\/\/[abc]\.tile\.opentopomap\.org/, "//a.tile.opentopomap.org");
    e.respondWith(fetch(e.request).catch(() => caches.open(TILES).then(c => c.match(key)).then(r => r || Response.error())));
    return;
  }
  const u = new URL(url);
  const isShell = u.origin === location.origin || url.startsWith("https://unpkg.com/leaflet@1.9.4/");
  if (!isShell) return;
  // primero la red (para recibir mejoras), y si no hay conexión, la copia guardada
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
