const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');

// POST /api/push/subscribe - Подписать устройство на push-уведомления
router.post('/subscribe', async (req, res, next) => {
  try {
    const { subscription } = req.body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    const { endpoint, keys } = subscription;

    await notificationService.subscribeUser(endpoint, keys.auth, keys.p256dh);

    res.json({ success: true, message: 'Subscribed to push notifications' });
  } catch (error) {
    next(error);
  }
});

// POST /api/push/unsubscribe - Отписать устройство
router.post('/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint required' });
    }

    await notificationService.unsubscribeUser(endpoint);

    res.json({ success: true, message: 'Unsubscribed from push notifications' });
  } catch (error) {
    next(error);
  }
});

// GET /api/push/notifications - Получить историю уведомлений
router.get('/notifications', async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const notifications = await notificationService.getNotifications(limit);

    res.json({
      count: notifications.length,
      notifications
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/push/test - Отправить тестовое уведомление
router.post('/test', async (req, res, next) => {
  try {
    await notificationService.notifyAll(
      '🧪 Тестовое уведомление',
      'Система push-уведомлений работает!'
    );

    res.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
