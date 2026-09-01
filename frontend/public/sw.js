// Service Worker для обработки push-уведомлений

// Слушать push-события
self.addEventListener('push', function(event) {
  console.log('📬 Push event received:', event);

  if (!event.data) {
    console.log('No data in push event');
    return;
  }

  let notificationData = {
    title: 'Kaspi Orders',
    body: 'New notification',
    icon: '/icon-192x192.png',
    badge: '/badge-72x72.png',
    tag: 'kaspi-orders'
  };

  try {
    const data = event.data.json();
    notificationData.title = data.title || notificationData.title;
    notificationData.body = data.message || notificationData.body;
    notificationData.data = data.data || {};
  } catch (e) {
    notificationData.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(notificationData.title, {
      body: notificationData.body,
      icon: notificationData.icon,
      badge: notificationData.badge,
      tag: notificationData.tag,
      data: notificationData.data,
      requireInteraction: false
    })
  );
});

// Слушать клики по уведомлениям
self.addEventListener('notificationclick', function(event) {
  console.log('📲 Notification clicked:', event.notification.tag);

  event.notification.close();

  // Открыть окно приложения
  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(function(clientList) {
      // Если окно уже открыто, фокусируем его
      for (const client of clientList) {
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      // Если окно не открыто, открываем новое
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// Обработка install события
self.addEventListener('install', function(event) {
  console.log('🔧 Service Worker installing');
  self.skipWaiting();
});

// Обработка activate события
self.addEventListener('activate', function(event) {
  console.log('✓ Service Worker activated');
  event.waitUntil(clients.claim());
});
