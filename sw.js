const CACHE_NAME = 'aqueous-v11';
const urlsToCache = [
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './mascot.png',
  './mascot-explosive.mp4',
  './mascot-rasta.mp4',
  './mascot-sad.mp4',
  './mascot-excited.mp4',
  './mascot-sexy.mp4',
  './mascot-wise.mp4',
  './mascot-mexican.mp4'
];

// Install: cache all essential files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch: network first, fallback to cache (ensures updates show immediately)
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Update cache with fresh version
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});
