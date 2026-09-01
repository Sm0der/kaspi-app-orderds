const db = require('../db/init');

class NotificationService {
  // Сохранить subscription для push-уведомлений
  async subscribeUser(endpoint, auth, p256dh) {
    try {
      await db.query(
        `INSERT INTO push_subscriptions (endpoint, auth, p256dh, subscribed_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (endpoint) DO UPDATE SET subscribed_at = NOW()`,
        [endpoint, auth, p256dh]
      );
      console.log('✓ User subscribed for push notifications');
    } catch (error) {
      console.error('Error saving subscription:', error);
      throw error;
    }
  }

  // Удалить subscription
  async unsubscribeUser(endpoint) {
    try {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
      console.log('✓ User unsubscribed from push notifications');
    } catch (error) {
      console.error('Error unsubscribing:', error);
    }
  }

  // Отправить push-уведомление всем подписчикам
  async notifyAll(title, message, data = {}) {
    // В реальном приложении нужна библиотека web-push для отправки
    // Сейчас сохраняем в БД для демонстрации

    try {
      const subscriptions = await db.query(
        'SELECT endpoint FROM push_subscriptions WHERE active = true'
      );

      console.log(`📢 Sending ${title} to ${subscriptions.rows.length} subscribers`);

      // TODO: Интегрировать web-push для реальной отправки push-уведомлений
      // import webpush from 'web-push';
      // const vapidKeys = { ... };
      // for (const sub of subscriptions.rows) {
      //   await webpush.sendNotification(sub, JSON.stringify({ title, message, data }));
      // }

      // Пока логируем в таблицу notifications
      await db.query(
        `INSERT INTO notifications (title, message, data, sent_count)
         VALUES ($1, $2, $3, $4)`,
        [title, message, JSON.stringify(data), subscriptions.rows.length]
      );
    } catch (error) {
      console.error('Error sending notifications:', error);
    }
  }

  // Уведомить о новых срочных заказах
  async notifyUrgentOrders(orders) {
    if (orders.length === 0) return;

    const ordersText = orders
      .map(o => `#${o.kaspi_order_id} (${o.store_name})`)
      .join(', ');

    await this.notifyAll(
      '🚨 Срочные заказы!',
      `Появилось ${orders.length} заказов к отгрузке сегодня: ${ordersText}`,
      { urgentOrderCount: orders.length, orders: orders.map(o => o.kaspi_order_id) }
    );
  }

  // Уведомить о ежедневной сводке (в 9 утра по времени магазина)
  async notifyDailySummary(stats) {
    await this.notifyAll(
      '📊 Ежедневная сводка заказов',
      `Сегодня: ${stats.todaysOrders} заказов (${stats.urgentOrders} срочных)`,
      { stats }
    );
  }

  // Получить все уведомления
  async getNotifications(limit = 20) {
    const result = await db.query(
      `SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

module.exports = new NotificationService();
