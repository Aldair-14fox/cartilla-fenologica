/* Service worker de la Cartilla Fenológica.
 *
 * Estrategia:
 *  - Shell de la app (HTML/CSS/JS/iconos): cache-first con precarga en install.
 *    El operario abre la app en el campo sin señal y arranca al instante.
 *  - /api/*: nunca se cachea. Si falla, falla — el cliente ya tiene su copia
 *    local en IndexedDB y reintenta el sync después.
 */
var VERSION = "v1";
var SHELL_CACHE = "cartilla-shell-" + VERSION;

var SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) {
          return k.indexOf("cartilla-shell-") === 0 && k !== SHELL_CACHE;
        }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // datos: siempre a la red

  // Navegaciones: red primero para recoger despliegues nuevos, con el shell
  // cacheado como respaldo inmediato cuando no hay señal.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put("/index.html", copy); });
          return res;
        })
        .catch(function () {
          return caches.match("/index.html").then(function (hit) {
            return hit || new Response("Sin conexión", { status: 503, headers: { "Content-Type": "text/plain" } });
          });
        })
    );
    return;
  }

  // Estáticos: cache primero, y se revalida en segundo plano.
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(SHELL_CACHE).then(function (c) { c.put(req, res); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === "basic") {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
