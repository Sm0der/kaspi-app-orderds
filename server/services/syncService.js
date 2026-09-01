const db = require('../db/init');
const KaspiService = require('./kaspiService');
const { transformKaspiOrder, transformOrderEntries, classifyByUrgency } = require('./orderProcessor');

class SyncService {
  constructor() {
    this.services = {}; // { storeId: KaspiService }
  }

  addStore(storeId, apiToken, storeName) {
    this.services[storeId] = {
      service: new KaspiService(apiToken),
      name: storeName,
      lastSync: null
    };
  }

  // Синхронизировать заказы для одного магазина
  async syncStore(storeId) {
    const kaspiService = this.services[storeId];
    if (!kaspiService) {
      throw new Error(`Store ${storeId} not configured`);
    }

    console.log(`\n🔄 Syncing store: ${kaspiService.name} (${storeId})`);

    try {
      // Получить ВСЕ заказы из Kaspi API постранично (за 14 дней может быть >100 заказов)
      const pageSize = 100;
      let pageNumber = 0;
      let allOrders = [];
      let totalCount = null;

      while (true) {
        const ordersData = await kaspiService.service.getOrders(pageNumber, pageSize);
        const pageOrders = ordersData.orders || [];
        allOrders = allOrders.concat(pageOrders);
        totalCount = ordersData.meta?.totalCount ?? totalCount;

        if (pageOrders.length < pageSize || allOrders.length >= (totalCount || allOrders.length)) {
          break;
        }
        pageNumber++;
      }

      console.log(`📦 Received ${allOrders.length}${totalCount ? ` / ${totalCount}` : ''} orders from Kaspi`);

      let syncedCount = 0;
      let errorCount = 0;

      // Сохранить или обновить каждый заказ
      for (const kaspiOrder of allOrders) {
        try {
          const order = transformKaspiOrder(kaspiOrder, storeId);

          // Проверить, существует ли заказ
          const existing = await db.query(
            'SELECT id FROM orders WHERE kaspi_order_id = $1',
            [order.kaspi_order_id]
          );

          let orderId;
          let hasItems = false;

          if (existing.rows.length > 0) {
            // Обновить
            orderId = existing.rows[0].id;
            await db.query(
              `UPDATE orders
               SET status = $1, state = $2, stage = $3, order_code = $4, delivery_date = $5, urgency = $6, raw_data = $7, updated_at = NOW()
               WHERE id = $8`,
              [order.status, order.state, order.stage, order.order_code, order.delivery_date, order.urgency, JSON.stringify(order.raw_data), orderId]
            );

            const itemCheck = await db.query(
              'SELECT 1 FROM order_items WHERE order_id = $1 LIMIT 1',
              [orderId]
            );
            hasItems = itemCheck.rows.length > 0;
          } else {
            // Создать новый
            const insertResult = await db.query(
              `INSERT INTO orders (store_id, kaspi_order_id, order_code, status, state, stage, delivery_date, urgency, raw_data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               RETURNING id`,
              [order.store_id, order.kaspi_order_id, order.order_code, order.status, order.state, order.stage, order.delivery_date, order.urgency, JSON.stringify(order.raw_data)]
            );
            orderId = insertResult.rows[0].id;

            console.log(`✨ New order: ${order.order_code || kaspiOrder.id}`);
          }

          // Товары запрашиваем отдельным вызовом один раз на заказ (состав заказа не меняется
          // после оформления) - так со временем собирается полный каталог товаров магазина,
          // не тратя лимит API на заказы, которые уже когда-то были синхронизированы
          if (!hasItems) {
            const entries = await kaspiService.service.getOrderEntries(kaspiOrder.id);
            const items = transformOrderEntries(entries);
            for (const item of items) {
              await db.query(
                `INSERT INTO order_items (order_id, product_code, sku, name, quantity, image_url, raw_data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (order_id, product_code) DO UPDATE SET
                   quantity = EXCLUDED.quantity,
                   image_url = EXCLUDED.image_url,
                   raw_data = EXCLUDED.raw_data`,
                [orderId, item.product_code, item.sku, item.name, item.quantity, item.image_url, JSON.stringify(item.raw_data)]
              );

              // Каталог товаров (один-ко-многим: товар -> позиции в заказах).
              // Не трогаем товары, загруженные импортом ('import'), чтобы не затирать
              // их эталонные данные данными из конкретного заказа.
              if (item.sku) {
                await db.query(
                  `INSERT INTO products (store_id, sku, name, image_url, source)
                   VALUES ($1, $2, $3, $4, 'order')
                   ON CONFLICT (store_id, sku) DO UPDATE SET
                     name = EXCLUDED.name,
                     image_url = COALESCE(products.image_url, EXCLUDED.image_url),
                     updated_at = NOW()
                   WHERE products.source = 'order'`,
                  [order.store_id, item.sku, item.name, item.image_url]
                );
              }
            }
          }

          syncedCount++;
        } catch (error) {
          errorCount++;
          console.error(`❌ Error processing order ${kaspiOrder.id}:`, error.message);
        }
      }

      // Логировать результаты синхронизации
      await db.query(
        `INSERT INTO sync_history (store_id, status, message, synced_count, error_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [storeId, 'success', `Synced from Kaspi API`, syncedCount, errorCount]
      );

      this.services[storeId].lastSync = new Date();

      console.log(`✓ Sync complete: ${syncedCount} synced, ${errorCount} errors`);
      return { syncedCount, errorCount };
    } catch (error) {
      console.error(`❌ Sync failed for store ${storeId}:`, error.message);

      await db.query(
        `INSERT INTO sync_history (store_id, status, message, error_count)
         VALUES ($1, $2, $3, $4)`,
        [storeId, 'error', error.message, 1]
      );

      throw error;
    }
  }

  // Синхронизировать все магазины
  async syncAll() {
    console.log('\n🌍 Starting global sync...');
    const results = {};

    for (const [storeId, config] of Object.entries(this.services)) {
      try {
        results[storeId] = await this.syncStore(storeId);
      } catch (error) {
        results[storeId] = { error: error.message };
      }
    }

    return results;
  }

  // Запустить периодическую синхронизацию
  startCron(intervalMinutes = 15) {
    console.log(`\n⏱️  Starting cron: sync every ${intervalMinutes} minutes`);

    // Сразу первый раз
    this.syncAll().catch(err => console.error('Initial sync error:', err));

    // Потом по расписанию
    setInterval(() => {
      this.syncAll().catch(err => console.error('Cron sync error:', err));
    }, intervalMinutes * 60 * 1000);
  }

  // Получить статистику последней синхронизации
  async getLastSyncStatus() {
    const result = await db.query(`
      SELECT store_id, status, message, synced_count, created_at
      FROM sync_history
      ORDER BY created_at DESC
      LIMIT 10
    `);

    return result.rows;
  }
}

module.exports = SyncService;
