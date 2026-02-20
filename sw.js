const CACHE_NAME = 'aqueous-v55';
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

// Track active notification tags to detect new vs update
let activeTimerTags = new Set();

// Handle timer notification updates from app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'TIMER_UPDATE_ALL') {
    const timers = event.data.timers || [];
    const newTags = new Set();

    timers.forEach(t => {
      const tag = `aqueous-t-${t.key}`;
      newTags.add(tag);
      const isNew = !activeTimerTags.has(tag);

      const options = {
        body: t.time,
        tag,
        badge: './badge-96.png',
        requireInteraction: true,
        // CRITICAL: never re-notify on updates — prevents vibration/badge pop
        silent: true,
        renotify: false,
        data: { timerKey: t.key, timerType: t.type, running: t.running },
        actions: [
          { action: 'toggle_pause', title: t.running ? 'Pause' : 'Resume' },
          { action: 'done', title: 'Done' }
        ]
      };

      // Only vibrate + sound on the very first appearance of this timer
      if (isNew) {
        options.vibrate = [100];
        options.silent = false;
        options.renotify = true;
      }

      self.registration.showNotification(t.name, options);
    });

    // Close notifications for timers that no longer exist
    if (activeTimerTags.size > 0) {
      self.registration.getNotifications().then(notifications => {
        notifications.forEach(n => {
          if (n.tag && n.tag.startsWith('aqueous-t-') && !newTags.has(n.tag)) {
            n.close();
          }
        });
      });
    }

    activeTimerTags = newTags;
  }

  if (event.data && event.data.type === 'TIMER_CLEAR_ALL') {
    self.registration.getNotifications().then(notifications => {
      notifications.forEach(n => {
        if (n.tag && n.tag.startsWith('aqueous-t-')) n.close();
      });
    });
    activeTimerTags = new Set();
  }
});

// Handle notification clicks and action buttons
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;
  const data = event.notification.data || {};
  const timerKey = data.timerKey;
  const timerType = data.timerType;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      if (action === 'toggle_pause' && timerKey) {
        windowClients.forEach(client => {
          client.postMessage({ type: 'TOGGLE_PAUSE_TIMER', timerKey, timerType });
        });
      } else if (action === 'done' && timerKey) {
        windowClients.forEach(client => {
          client.postMessage({ type: 'DONE_TIMER', timerKey, timerType });
        });
      } else {
        // Default tap: open or focus the app
        if (windowClients.length > 0) {
          windowClients[0].focus();
        } else {
          clients.openWindow('./');
        }
      }
    })
  );
});
