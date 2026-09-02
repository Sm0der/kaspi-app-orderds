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

  // Обработать один заказ: сохранить/обновить его и (если ещё не делали) подтянуть состав.
  // Вынесено отдельно, чтобы syncStore мог гонять это параллельно пулом воркеров.
  async processOrder(kaspiOrder, storeId, kaspiService) {
    const order = transformKaspiOrder(kaspiOrder, storeId);

    // Один запрос вместо "проверить существование, потом insert или update" - меньше round-trip'ов
    // к БД, что особенно важно на serverless, где сеть до БД - основная часть задержки.
    // (xmax = 0) - стандартный postgres-трюк: true для только что вставленной строки.
    const upsert = await db.query(
      `INSERT INTO orders (store_id, kaspi_order_id, order_code, status, state, stage, delivery_date, order_date, urgency, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (kaspi_order_id) DO UPDATE SET
         status = EXCLUDED.status, state = EXCLUDED.state, stage = EXCLUDED.stage,
         order_code = EXCLUDED.order_code, delivery_date = EXCLUDED.delivery_date,
         order_date = COALESCE(orders.order_date, EXCLUDED.order_date),
         urgency = EXCLUDED.urgency, raw_data = EXCLUDED.raw_data, updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [order.store_id, order.kaspi_order_id, order.order_code, order.status, order.state, order.stage, order.delivery_date, order.order_date, order.urgency, JSON.stringify(order.raw_data)]
    );
    const orderId = upsert.rows[0].id;
    const isNew = upsert.rows[0].inserted;

    if (isNew) {
      console.log(`✨ New order: ${order.order_code || kaspiOrder.id}`);
    }

    // Товары запрашиваем отдельным вызовом один раз на заказ (состав заказа не меняется
    // после оформления) - так со временем собирается полный каталог товаров магазина,
    // не тратя лимит API на заказы, которые уже когда-то были синхронизированы
    let hasItems = !isNew;
    if (!isNew) {
      const itemCheck = await db.query('SELECT 1 FROM order_items WHERE order_id = $1 LIMIT 1', [orderId]);
      hasItems = itemCheck.rows.length > 0;
    }

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

      // Архивные заказы (доставлено/отменено) в Kaspi уже не поменяются - если такой заказ
      // у нас уже сохранён в БД со всеми позициями, повторно тянуть его (запрос состава,
      // upsert) на каждой синхронизации незачем. Kaspi всё равно отдаёт его в списке (фильтр
      // только по дате создания, без "изменено с..."), но мы можем сразу отсеять то, что нам
      // точно не нужно обновлять, одним batch-запросом в БД вместо N отдельных проверок.
      // order_date IS NOT NULL тоже обязателен: иначе заказ, который уже архивный, но ещё
      // ни разу не получал order_date (например добавили колонку после того, как он уже был
      // синхронизирован), навсегда останется без даты создания - его же больше никогда не
      // обработает processOrder(), который её проставляет.
      const orderIds = allOrders.map(o => o.id);
      const archivedCheck = orderIds.length > 0
        ? await db.query(
            `SELECT o.kaspi_order_id
             FROM orders o
             WHERE o.kaspi_order_id = ANY($1)
               AND o.stage IN ('completed', 'cancelled')
               AND o.order_date IS NOT NULL
               AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)`,
            [orderIds]
          )
        : { rows: [] };
      const alreadyArchived = new Set(archivedCheck.rows.map(r => r.kaspi_order_id));
      const ordersToProcess = allOrders.filter(o => !alreadyArchived.has(o.id));

      console.log(`📥 Skipping ${alreadyArchived.size} already-archived orders, processing ${ordersToProcess.length}`);

      // Обрабатываем заказы параллельно (пул воркеров), а не строго по одному - на serverless
      // (Vercel) синхронизация ограничена по времени выполнения, и с тысячей+ заказов
      // последовательная обработка (запрос к Kaspi API за составом + несколько запросов в БД
      // на каждый заказ) в это время физически не укладывается. Каждый заказ по-прежнему
      // независим и идемпотентен (upsert), поэтому обрыв на середине не портит данные -
      // следующий запуск просто продолжит с того, что не успело обработаться.
      const CONCURRENCY = 15;
      let syncedCount = alreadyArchived.size;
      let errorCount = 0;
      let cursor = 0;

      const worker = async () => {
        while (cursor < ordersToProcess.length) {
          const kaspiOrder = ordersToProcess[cursor++];
          try {
            await this.processOrder(kaspiOrder, storeId, kaspiService);
            syncedCount++;
          } catch (error) {
            errorCount++;
            console.error(`❌ Error processing order ${kaspiOrder.id}:`, error.message);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ordersToProcess.length) }, worker));

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
