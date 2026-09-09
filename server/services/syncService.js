const crypto = require('crypto');
const db = require('../db/init');
const KaspiService = require('./kaspiService');
const { transformKaspiOrder, transformOrderEntries } = require('./orderProcessor');

// Больше 100 Kaspi всё равно не отдаёт: на page[size]=200 и 500 приходит те же 100 (проверено)
const KASPI_PAGE_SIZE = 100;
// После того как записи в БД стали пачками, всё время синка - это выкачивание списка из Kaspi.
// Замер: одна страница ~1с, все 11 страниц разом - 2.6с и ни одного 429. Поэтому берём весь
// список одной волной; 12 хватает на 1200 заказов, а ретраи на 429 остаются подстраховкой.
const PAGE_CONCURRENCY = 12;
// Состав заказа запрашивается только для заказов, которых ещё нет в БД, - таких обычно единицы
const ENTRIES_CONCURRENCY = 15;
// Сколько строк отправляем в БД одним INSERT-ом. Главная статья расходов синка - не сами
// запросы, а сетевая задержка до Postgres, поэтому один запрос на 100 строк несравнимо
// дешевле, чем 100 запросов по строке.
const DB_BATCH_SIZE = 100;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Пул воркеров: выполняет fn для всех элементов, но не больше limit одновременно.
// Ошибку первого упавшего элемента пробрасываем наверх, но только после того, как
// остановятся все воркеры - иначе оставшиеся промисы падали бы уже "в никуда"
// (unhandled rejection), пока Promise.all уже отверг общий результат.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError = null;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
        cursor = items.length; // продолжать разбор очереди уже незачем
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
  return results;
}

// Kaspi при каждом запросе выдаёт новую подписанную ссылку на накладную
// (attributes.kaspiDelivery.waybill) - сам заказ при этом не менялся. Если считать хеш
// вместе с ней, "изменившимися" выглядят почти все отгруженные заказы (проверено: 82 из
// 100 на двух запросах подряд). Поэтому из хеша её выкидываем; в raw_data она остаётся.
// waybillNumber - другое поле, оно стабильное и значимое, его не трогаем.
function hashableJson(kaspiOrder) {
  return JSON.stringify(kaspiOrder, (key, value) => (key === 'waybill' ? undefined : value));
}

// Плейсхолдеры вида ($1,$2,$3),($4,$5,$6) для многострочного INSERT
function buildPlaceholders(rowCount, columnCount) {
  return Array.from({ length: rowCount }, (_, row) =>
    `(${Array.from({ length: columnCount }, (_, col) => `$${row * columnCount + col + 1}`).join(',')})`
  ).join(',');
}

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

  // Забрать весь список заказов из Kaspi. Первую страницу берём отдельно - из её meta
  // узнаём общее количество и дальше тянем оставшиеся страницы параллельно, а не по одной
  // (при ~1100 заказах это 11 последовательных запросов против 1 + пары параллельных волн).
  async fetchAllOrders(kaspiService, storeId) {
    // Сколько всего страниц - известно только из meta первой страницы, но ждать её отдельно
    // дорого: запрос к Kaspi занимает секунды, и это лишний последовательный шаг. Поэтому
    // количество страниц предсказываем по своей же базе (число заказов за то же окно в 14
    // дней) с запасом и запрашиваем их все разом. Запрос в БД рядом с функцией стоит
    // миллисекунды, а экономит целый круг до Kaspi. Если не угадали - до-качиваем остаток.
    const expected = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM orders
       WHERE store_id = $1 AND order_date >= NOW() - INTERVAL '14 days'`,
      [storeId]
    );
    const expectedPages = Math.min(
      PAGE_CONCURRENCY,
      Math.max(1, Math.ceil((expected.rows[0].count + KASPI_PAGE_SIZE) / KASPI_PAGE_SIZE))
    );

    const orders = [];
    const seenPages = new Set();
    let totalCount = null;

    const loadPages = async (pageNumbers) => {
      const pages = await mapLimit(pageNumbers, PAGE_CONCURRENCY, (pageNumber) =>
        kaspiService.service.getOrders(pageNumber, KASPI_PAGE_SIZE)
      );
      pageNumbers.forEach((pageNumber, i) => {
        seenPages.add(pageNumber);
        orders.push(...(pages[i].orders || []));
        if (pages[i].meta?.totalCount != null) totalCount = pages[i].meta.totalCount;
      });
    };

    await loadPages(Array.from({ length: expectedPages }, (_, i) => i));

    // Заказов оказалось больше, чем мы ожидали - добираем оставшиеся страницы
    if (typeof totalCount === 'number') {
      const totalPages = Math.ceil(totalCount / KASPI_PAGE_SIZE);
      while (seenPages.size < totalPages) {
        const missing = [];
        for (let p = 0; p < totalPages && missing.length < PAGE_CONCURRENCY; p++) {
          if (!seenPages.has(p)) missing.push(p);
        }
        if (missing.length === 0) break;
        await loadPages(missing);
      }
      return { orders, totalCount };
    }

    // Kaspi не прислал meta.totalCount - идём по страницам, пока не придёт неполная.
    // Молча синхронизировать только то, что успели запросить, нельзя.
    let pageNumber = seenPages.size;
    let lastPageLength = KASPI_PAGE_SIZE;
    while (lastPageLength === KASPI_PAGE_SIZE) {
      const page = await kaspiService.service.getOrders(pageNumber++, KASPI_PAGE_SIZE);
      const pageOrders = page.orders || [];
      orders.push(...pageOrders);
      lastPageLength = pageOrders.length;
    }

    return { orders, totalCount: orders.length };
  }

  // Синхронизировать заказы для одного магазина
  async syncStore(storeId) {
    const kaspiService = this.services[storeId];
    if (!kaspiService) {
      throw new Error(`Store ${storeId} not configured`);
    }

    const startedAt = Date.now();
    console.log(`\n🔄 Syncing store: ${kaspiService.name} (${storeId})`);

    try {
      const { orders: fetchedOrders, totalCount } = await this.fetchAllOrders(kaspiService, storeId);

      // На всякий случай убираем дубли: один и тот же заказ не должен попасть в батч дважды -
      // postgres не даст ON CONFLICT DO UPDATE тронуть одну строку два раза в одном запросе.
      const uniqueOrders = [...new Map(
        fetchedOrders.filter(o => o?.id).map(o => [o.id, o])
      ).values()];

      console.log(`📦 Received ${uniqueOrders.length}${totalCount ? ` / ${totalCount}` : ''} orders from Kaspi`);

      // Одним запросом узнаём про все заказы сразу: есть ли они у нас, каким было содержимое
      // (raw_hash) и подтянут ли состав. Раньше на это уходило по отдельному SELECT-у на заказ.
      const existing = new Map();
      if (uniqueOrders.length > 0) {
        const known = await db.query(
          `SELECT o.kaspi_order_id, o.id, o.raw_hash, o.urgency, o.ship_date,
                  (o.order_date IS NOT NULL) AS has_order_date,
                  EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id) AS has_items
           FROM orders o
           WHERE o.kaspi_order_id = ANY($1)`,
          [uniqueOrders.map(o => o.id)]
        );
        for (const row of known.rows) existing.set(row.kaspi_order_id, row);
      }

      // Kaspi отдаёт все заказы за 14 дней целиком - фильтра "изменённые с ..." у него нет.
      // Поэтому отличаем изменившиеся сами: считаем хеш присланного JSON и сверяем с сохранённым.
      // Между двумя синхронизациями реально меняются единицы заказов, остальные можно не трогать
      // вообще - ни записи в БД, ни запроса состава. urgency сверяем отдельно: она зависит от
      // текущей даты, а не от данных Kaspi (вчерашнее "предстоит" сегодня становится "сегодня").
      const toUpsert = [];
      const needItems = [];
      let unchangedCount = 0;

      for (const kaspiOrder of uniqueOrders) {
        const order = transformKaspiOrder(kaspiOrder, storeId);
        const rawHash = crypto.createHash('md5').update(hashableJson(kaspiOrder)).digest('hex');
        const prev = existing.get(order.kaspi_order_id);

        const needsWrite = !prev
          || prev.raw_hash !== rawHash
          || prev.urgency !== order.urgency
          || !prev.has_order_date
          // ship_date появилась позже остальных полей: у заказов, синхронизированных до неё,
          // хеш совпадает и без этой проверки строка никогда бы не перезаписалась.
          || (order.ship_date && !prev.ship_date);
        const missingItems = !prev || !prev.has_items;

        if (!needsWrite && !missingItems) {
          unchangedCount++;
          continue;
        }
        // Полный JSON сериализуем только для тех, кого реально пишем
        if (needsWrite) toUpsert.push({ order, rawHash, rawJson: JSON.stringify(kaspiOrder) });
        if (missingItems) needItems.push({ kaspiOrderId: order.kaspi_order_id, orderId: prev?.id ?? null });
      }

      console.log(`📥 Unchanged: ${unchangedCount}, to update: ${toUpsert.length}, need items: ${needItems.length}`);

      // Пишем заказы пачками по DB_BATCH_SIZE строк за запрос
      const idByKaspiId = new Map();
      const ORDER_COLUMNS = 12;
      for (const batch of chunk(toUpsert, DB_BATCH_SIZE)) {
        const values = [];
        for (const { order, rawHash, rawJson } of batch) {
          values.push(
            order.store_id, order.kaspi_order_id, order.order_code, order.status, order.state,
            order.stage, order.delivery_date, order.ship_date, order.order_date, order.urgency,
            rawJson, rawHash
          );
        }

        const upserted = await db.query(
          `INSERT INTO orders (store_id, kaspi_order_id, order_code, status, state, stage,
                               delivery_date, ship_date, order_date, urgency, raw_data, raw_hash)
           VALUES ${buildPlaceholders(batch.length, ORDER_COLUMNS)}
           ON CONFLICT (kaspi_order_id) DO UPDATE SET
             status = EXCLUDED.status, state = EXCLUDED.state, stage = EXCLUDED.stage,
             order_code = EXCLUDED.order_code, delivery_date = EXCLUDED.delivery_date,
             ship_date = EXCLUDED.ship_date,
             order_date = COALESCE(orders.order_date, EXCLUDED.order_date),
             urgency = EXCLUDED.urgency, raw_data = EXCLUDED.raw_data,
             raw_hash = EXCLUDED.raw_hash, updated_at = NOW()
           RETURNING id, kaspi_order_id`,
          values
        );
        for (const row of upserted.rows) idByKaspiId.set(row.kaspi_order_id, row.id);
      }

      // Состав заказа в Kaspi не меняется после оформления, поэтому запрашиваем его один раз
      // за всю жизнь заказа - только для тех, у кого позиций в БД ещё нет.
      let errorCount = 0;
      const itemTargets = needItems
        .map(target => ({ ...target, orderId: target.orderId ?? idByKaspiId.get(target.kaspiOrderId) ?? null }))
        .filter(target => target.orderId);

      const fetchedEntries = await mapLimit(itemTargets, ENTRIES_CONCURRENCY, async (target) => {
        try {
          const entries = await kaspiService.service.getOrderEntries(target.kaspiOrderId);
          return { orderId: target.orderId, items: transformOrderEntries(entries) };
        } catch (error) {
          errorCount++;
          console.error(`❌ Error fetching entries for ${target.kaspiOrderId}:`, error.message);
          return null;
        }
      });

      // Позиции и каталог товаров тоже пишем пачками. Дубли внутри пачки убираем заранее -
      // ON CONFLICT DO UPDATE не может обновить одну и ту же строку дважды в одном запросе.
      const itemRows = [];
      const seenItems = new Set();
      const productRows = new Map();

      for (const result of fetchedEntries) {
        if (!result) continue;
        for (const item of result.items) {
          const itemKey = `${result.orderId}|${item.product_code}`;
          if (seenItems.has(itemKey)) continue;
          seenItems.add(itemKey);
          itemRows.push({ orderId: result.orderId, ...item });

          if (item.sku) {
            productRows.set(`${storeId}|${item.sku}`, { sku: item.sku, name: item.name, image_url: item.image_url });
          }
        }
      }

      const ITEM_COLUMNS = 7;
      for (const batch of chunk(itemRows, DB_BATCH_SIZE)) {
        const values = [];
        for (const item of batch) {
          values.push(
            item.orderId, item.product_code, item.sku, item.name,
            item.quantity, item.image_url, JSON.stringify(item.raw_data)
          );
        }
        await db.query(
          `INSERT INTO order_items (order_id, product_code, sku, name, quantity, image_url, raw_data)
           VALUES ${buildPlaceholders(batch.length, ITEM_COLUMNS)}
           ON CONFLICT (order_id, product_code) DO UPDATE SET
             quantity = EXCLUDED.quantity,
             image_url = EXCLUDED.image_url,
             raw_data = EXCLUDED.raw_data`,
          values
        );
      }

      // Каталог товаров (один товар -> много позиций в заказах). Товары, загруженные импортом
      // ('import'), не трогаем, чтобы не затирать эталонные данные данными из заказа.
      const PRODUCT_COLUMNS = 5;
      for (const batch of chunk([...productRows.values()], DB_BATCH_SIZE)) {
        const values = [];
        for (const product of batch) {
          values.push(storeId, product.sku, product.name, product.image_url, 'order');
        }
        await db.query(
          `INSERT INTO products (store_id, sku, name, image_url, source)
           VALUES ${buildPlaceholders(batch.length, PRODUCT_COLUMNS)}
           ON CONFLICT (store_id, sku) DO UPDATE SET
             name = EXCLUDED.name,
             image_url = COALESCE(products.image_url, EXCLUDED.image_url),
             updated_at = NOW()
           WHERE products.source = 'order'`,
          values
        );
      }

      const durationMs = Date.now() - startedAt;
      const syncedCount = uniqueOrders.length;
      const message = `Synced ${syncedCount} orders in ${(durationMs / 1000).toFixed(1)}s ` +
        `(updated ${toUpsert.length}, unchanged ${unchangedCount}, items for ${itemTargets.length})`;

      await db.query(
        `INSERT INTO sync_history (store_id, status, message, synced_count, error_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [storeId, 'success', message, syncedCount, errorCount]
      );

      this.services[storeId].lastSync = new Date();

      console.log(`✓ ${message}, errors ${errorCount}`);
      return {
        syncedCount,
        errorCount,
        updatedCount: toUpsert.length,
        unchangedCount,
        durationMs
      };
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

  // Синхронизировать все магазины. Магазины независимы (свой токен, свои заказы), поэтому
  // идут параллельно - общее время равно самому долгому магазину, а не их сумме.
  async syncAll() {
    console.log('\n🌍 Starting global sync...');

    const entries = await Promise.all(
      Object.keys(this.services).map(async (storeId) => {
        try {
          return [storeId, await this.syncStore(storeId)];
        } catch (error) {
          return [storeId, { error: error.message }];
        }
      })
    );

    return Object.fromEntries(entries);
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
