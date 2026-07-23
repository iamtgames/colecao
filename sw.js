const CACHE = 'iamt-colecao-v2';
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

// Estratégia: para navegação (abrir a página), tenta rede primeiro (sempre a
// versão mais nova) e, se der certo, atualiza o cache de fallback com essa
// resposta fresca — antes o cache só era preenchido uma vez na instalação e
// nunca mais era renovado, o que fazia o fallback offline ficar desatualizado
// pra sempre. Só cai pro cache se a rede falhar (ex: sem internet).
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.mode === 'navigate'){
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(res => {
          const copia = res.clone();
          caches.open(CACHE).then(cache => cache.put('./index.html', copia)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
  }
});
