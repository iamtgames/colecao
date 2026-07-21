const CACHE = 'iamt-colecao-v1';
const SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia: para navegação (abrir a página), tenta rede e cai pro cache se ficar offline.
// Para o resto, deixa passar normal (não intercepta imagens externas de capas).
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.mode === 'navigate'){
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
  }
});
