const CACHE_NAME = 'aqueous-v110';
const urlsToCache = [
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './mascot.png',
  './badge-96.png',
  './notif-icon-96.png',
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

const NOTIF_TAG_PREFIX = 'aqueous-station-';
const NOTIF_GROUP = 'aqueous-timers';
let activeStationIds = new Set();

// Handle messages from app
self.addEventListener('message', event => {
  if (!event.data) return;

  if (event.data.type === 'TIMER_STATIONS') {
    const stationList = event.data.stations || [];
    const newStationIds = new Set(event.data.newStationIds || []);
    const currentIds = new Set(stationList.map(s => s.id));

    // Close notifications for stations no longer active
    self.registration.getNotifications().then(notifs => {
      notifs.forEach(n => {
        const sid = n.data && n.data.stationId;
        if (sid && !currentIds.has(sid)) n.close();
      });
    });

    // Show/update one notification per station
    stationList.forEach(s => {
      const tag = NOTIF_TAG_PREFIX + s.id;
      const isNew = newStationIds.has(s.id);
      const body = s.ingredients.map(i => '• ' + i).join('\n');

      const options = {
        body,
        tag,
        icon: './badge-96.png',
        badge: './badge-96.png',
        requireInteraction: true,
        silent: !isNew,
        renotify: isNew,
        group: NOTIF_GROUP,
        data: { stationId: s.id, action: 'open_summary' }
      };
      if (isNew) options.vibrate = [80];

      self.registration.showNotification('\u{1F468}\u{200D}\u{1F373} ' + s.name, options);
    });

    activeStationIds = currentIds;
  }

  if (event.data.type === 'TIMER_CLEAR_ALL') {
    self.registration.getNotifications().then(n => n.forEach(n => n.close()));
    activeStationIds.clear();
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
