const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Проверить поддержку Service Workers
export function isPushNotificationSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Регистрация Service Worker
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.log('Service Workers not supported');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/'
    });
    console.log('✓ Service Worker registered');
    return registration;
  } catch (error) {
    console.error('Service Worker registration failed:', error);
    return null;
  }
}

// Подписать на push-уведомления
export async function subscribeToPushNotifications(vapidPublicKey) {
  if (!isPushNotificationSupported()) {
    console.log('Push notifications not supported');
    return null;
  }

  // Запросить разрешение
  if (Notification.permission === 'denied') {
    console.log('Notifications permission denied');
    return null;
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('Notifications permission not granted');
      return null;
    }
  }

  try {
    const registration = await navigator.serviceWorker.ready;

    // Создать subscription
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
    });

    // Отправить subscription на сервер
    const response = await fetch(`${API_URL}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });

    if (response.ok) {
      console.log('✓ Subscribed to push notifications');
      return subscription;
    } else {
      console.error('Failed to subscribe to push notifications');
      return null;
    }
  } catch (error) {
    console.error('Error subscribing to push notifications:', error);
    return null;
  }
}

// Отписать от push-уведомлений
export async function unsubscribeFromPushNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      // Отправить unsubscribe на сервер
      await fetch(`${API_URL}/api/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint })
      });

      // Удалить subscription
      await subscription.unsubscribe();
      console.log('✓ Unsubscribed from push notifications');
      return true;
    }
  } catch (error) {
    console.error('Error unsubscribing from push notifications:', error);
  }
  return false;
}

// Проверить, подписан ли пользователь
export async function isPushSubscribed() {
  if (!isPushNotificationSupported()) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return !!subscription;
  } catch (error) {
    console.error('Error checking push subscription:', error);
    return false;
  }
}

// Вспомогательная функция для преобразования VAPID ключа
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Получить историю уведомлений
export async function getNotificationHistory(limit = 20) {
  try {
    const response = await fetch(`${API_URL}/api/push/notifications?limit=${limit}`);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error('Error fetching notification history:', error);
  }
  return null;
}

// Отправить тестовое уведомление (для разработки)
export async function sendTestNotification() {
  try {
    const response = await fetch(`${API_URL}/api/push/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (response.ok) {
      console.log('✓ Test notification sent');
      return true;
    }
  } catch (error) {
    console.error('Error sending test notification:', error);
  }
  return false;
}
