const CACHE_NAME = 'aqueous-v59';
const urlsToCache = [
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './mascot.png',
  './badge-96.png',
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

// Fetch: network first, fallback to cache
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Activate: clean old caches and claim all clients immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

const NOTIF_TAG = 'aqueous-active';
let notifShown = false;

// Handle messages from app
self.addEventListener('message', event => {
  if (!event.data) return;

  if (event.data.type === 'TIMER_STATUS') {
    const isNew = event.data.isNew || !notifShown;
    const options = {
      body: event.data.body,
      tag: NOTIF_TAG,
      badge: './badge-96.png',
      requireInteraction: true,
      silent: !isNew,
      renotify: isNew,
      data: { action: 'open_summary' }
    };
    if (isNew) {
      options.vibrate = [100];
    }
    self.registration.showNotification('Active', options);
    notifShown = true;
  }

  if (event.data.type === 'TIMER_CLEAR_ALL') {
    self.registration.getNotifications().then(notifications => {
      notifications.forEach(n => n.close());
    });
    notifShown = false;
  }
});

// Handle notification tap — open app on Summary
self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      if (windowClients.length > 0) {
        windowClients[0].focus();
        windowClients[0].postMessage({ type: 'OPEN_SUMMARY' });
      } else {
        clients.openWindow('./?view=summary');
      }
    })
  );
});
