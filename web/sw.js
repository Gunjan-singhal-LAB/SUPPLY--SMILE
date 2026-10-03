// Supply Smile service worker: makes the app installable and quick to open.
// It keeps a copy of the app's own files (pages, styles, scripts, icons). Clinic data is never cached:
// it always comes live from the database, so everyone sees the same stock.
const CACHE = 'supplysmile-3.0.0-firebase';
const SHELL = ['count.html', 'css/app.css', 'css/login.css', 'home.html', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon.svg', 'import.html', 'index.html', 'item.html', 'items.html', 'js/backend.js', 'js/common.js', 'js/config.js', 'js/fb-core.js', 'js/fb-inventory.js', 'js/dashboard.js', 'js/smile-loader.js', 'kits.html', 'login.html', 'manifest.webmanifest', 'reorder.html', 'reports.html', 'settings.html', 'setup.html', 'stock-in.html', 'stock-out.html', 'suppliers.html', 'use.html', 'vendor/bootstrap-icons/bootstrap-icons.min.css', 'vendor/bootstrap-icons/fonts/bootstrap-icons.woff', 'vendor/bootstrap-icons/fonts/bootstrap-icons.woff2', 'vendor/bootstrap/bootstrap.bundle.min.js', 'vendor/bootstrap/bootstrap.min.css', 'vendor/chartjs/chart.umd.js', 'vendor/jspdf/jspdf.plugin.autotable.min.js', 'vendor/jspdf/jspdf.umd.min.js', 'vendor/xlsx/xlsx.full.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.json')) return;   // database calls go straight to Firebase
  const fresh = req.mode === 'navigate' || url.pathname.endsWith('/js/config.js');
  if (fresh) {                                                           // pages: newest first, saved copy if offline
    e.respondWith(fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('login.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {                            // files: saved copy now, refresh in background
    const net = fetch(req).then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return res; });
    return hit || net;
  }));
});
