const CACHE = 'boodschappen-v33';
const STATIC = ['./manifest.json', './logo.svg', './styles.css', './app.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // index.html, styles.css en app.js → altijd network-first zodat updates
  // direct zichtbaar zijn. Val terug op cache alleen als volledig offline.
  if (url.pathname === '/' || url.pathname.endsWith('/index.html')
      || url.pathname.endsWith('/styles.css') || url.pathname.endsWith('/app.js')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Prijsdata → network-first, val terug op cache bij offline.
  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Overige assets (logo, manifest) → cache-first.
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }))
  );
});

// ── PUSH-MELDINGEN (prijsalerts) ──
self.addEventListener('push', e => {
  let data = { title: '📉 Prijsalert', body: 'Een gevolgd product is in prijs veranderd.', url: '/' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './logo.svg',
      badge: './logo.svg',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
