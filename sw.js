const CACHE_NAME = 'aqueous-v62';
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

const NOTIF_TAG_PREFIX = 'aqueous-timer-';
let activeTimerIds = new Set();

function formatTimeSW(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Handle messages from app
self.addEventListener('message', event => {
  if (!event.data) return;

  if (event.data.type === 'TIMER_SYNC') {
    const timers = event.data.timers || [];
    const isNew = event.data.isNew;
    const newIds = new Set(timers.map(t => t.id));

    // Close notifications for timers that no longer exist
    self.registration.getNotifications().then(notifs => {
      notifs.forEach(n => {
        const id = n.data && n.data.timerId;
        if (id && !newIds.has(id)) n.close();
      });
    });

    // Show/update notification for each timer
    timers.forEach(t => {
      const tag = NOTIF_TAG_PREFIX + t.id;
      const timeStr = formatTimeSW(Math.abs(t.seconds));
      const title = t.label;
      const body = t.overtime ? `−${timeStr} (overtime)` : timeStr;
      const isNewTimer = isNew || !activeTimerIds.has(t.id);

      const actions = t.running
        ? [{ action: 'pause', title: '⏸ Pause' }, { action: 'done', title: '✅ Done' }]
        : [{ action: 'resume', title: '▶ Resume' }, { action: 'done', title: '✅ Done' }];

      const options = {
        body,
        tag,
        badge: './badge-96.png',
        requireInteraction: true,
        silent: !isNewTimer,
        renotify: isNewTimer,
        actions,
        data: { timerId: t.id, action: 'open_summary' }
      };
      if (isNewTimer) options.vibrate = [100];

      self.registration.showNotification(title, options);
    });

    activeTimerIds = newIds;
  }

  if (event.data.type === 'TIMER_CLEAR_ALL') {
    self.registration.getNotifications().then(n => n.forEach(n => n.close()));
    activeTimerIds.clear();
  }
});

// Handle notification tap and action buttons
self.addEventListener('notificationclick', event => {
  const timerId = event.notification.data && event.notification.data.timerId;
  const action = event.action;

  if (action && timerId) {
    // User clicked an action button (pause/resume/done)
    event.notification.close();
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
        const msg = { type: 'TIMER_ACTION', timerId, action };
        if (windowClients.length > 0) {
          windowClients[0].postMessage(msg);
        }
      })
    );
  } else {
    // User tapped the notification body — open app on Summary
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
  }
});
