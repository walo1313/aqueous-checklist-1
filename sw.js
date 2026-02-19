const CACHE_NAME = 'aqueous-v15';
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

// Handle timer notification updates from app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'TIMER_UPDATE') {
    self.registration.showNotification(event.data.title, {
      body: event.data.body,
      tag: 'aqueous-timer',
      renotify: true,
      silent: true,
      icon: './icon-192.png',
      badge: './icon-192.png',
      requireInteraction: true,
      ongoing: true,
      actions: [
        { action: 'pause_all', title: '⏸ Pause All' },
        { action: 'open', title: '📋 Open' }
      ]
    });
  }
  if (event.data && event.data.type === 'TIMER_CLEAR') {
    self.registration.getNotifications({ tag: 'aqueous-timer' }).then(notifications => {
      notifications.forEach(n => n.close());
    });
  }
});

// Handle notification clicks and action buttons
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Send action to the app
      if (action === 'pause_all') {
        windowClients.forEach(client => {
          client.postMessage({ type: 'PAUSE_ALL_TIMERS' });
        });
        // Also focus the app
        if (windowClients.length > 0) {
          windowClients[0].focus();
        }
      } else {
        // Default: open or focus the app
        if (windowClients.length > 0) {
          windowClients[0].focus();
        } else {
          clients.openWindow('./');
        }
      }
    })
  );
});
