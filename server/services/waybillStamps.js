const axios = require('axios');
const db = require('../db/init');

// Когда накладную сформировали - в полях заказа этого нет. Kaspi пишет момент генерации
// только внутрь самого PDF, в /CreationDate. Оттуда его и читаем: это единственный способ
// разложить день на вывозы, если накладные печатают в кабинете Kaspi, а не через наш
// сервис (тогда assembly_batches пуст, и группировать нечем).
//
// Штамп не равен времени скачивания: Kaspi отдаёт уже сгенерированный PDF, и время в нём
// остаётся тем, когда накладную сделали. Проверено: файлы, скачанные в 17:28, несли 13:07.

// Один заказ - два обращения к Kaspi (свежая ссылка, затем PDF), поэтому пулом
const CONCURRENCY = 6;

// Больше за раз не берём: обработчик Vercel живёт ограниченное время, а прочитанные
// штампы всё равно сохраняются - следующий вызов продолжит с того же места
const DEFAULT_LIMIT = 60;

/**
 * `/CreationDate (D:20260910171715+05'00')` → Date.
 * Смещение в штампе указано (+05'00' для Алматы), поэтому собираем момент по нему,
 * а не по часовому поясу сервера - на Vercel он UTC, и без этого время уехало бы на 5 часов.
 */
function parseCreationDate(pdf) {
  const head = pdf.toString('latin1');
  const match = head.match(/\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})([+-]\d{2})'?(\d{2})?/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, tzHour, tzMinute = '00'] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzHour}:${tzMinute}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Дочитывает штампы у заказов, где их ещё нет или где накладную переформировали.
 * Возвращает, сколько прочитано и сколько осталось - интерфейсу есть что показать,
 * если заказов много и одного вызова не хватило.
 */
async function refreshStamps(syncService, { limit = DEFAULT_LIMIT } = {}) {
  const targets = await db.query(
    `SELECT id, order_code, kaspi_order_id, store_id,
            raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber' AS waybill_number
     FROM orders
     WHERE raw_data->'attributes'->'kaspiDelivery'->>'waybill' IS NOT NULL
       -- Смотрим только живую часть: у отгруженных и отменённых вывоз уже не собирают
       AND stage NOT IN ('cancelled', 'delivered', 'completed')
       AND (
         waybill_made_at IS NULL
         OR waybill_stamped_number IS DISTINCT FROM raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber'
       )
     ORDER BY ship_date DESC NULLS LAST, id DESC
     LIMIT $1`,
    [limit]
  );

  if (targets.rows.length === 0) return { read: 0, failed: 0, remaining: 0 };

  let cursor = 0;
  let read = 0;
  let failed = 0;

  const worker = async () => {
    while (cursor < targets.rows.length) {
      const order = targets.rows[cursor++];
      const store = syncService?.services?.[order.store_id];
      if (!store) {
        failed++;
        continue;
      }

      try {
        // Ссылка на накладную у Kaspi недолговечная - берём свежую, как это делает
        // и сборка архива в routes/batches.js
        const details = await store.service.getOrderDetails(order.kaspi_order_id);
        const url = details?.attributes?.kaspiDelivery?.waybill;
        if (!url) {
          failed++;
          continue;
        }

        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: { 'X-Auth-Token': store.service.apiToken }
        });
        const pdf = Buffer.from(response.data);
        const madeAt = parseCreationDate(pdf);
        if (!madeAt) {
          failed++;
          continue;
        }

        await db.query(
          'UPDATE orders SET waybill_made_at = $1, waybill_stamped_number = $2 WHERE id = $3',
          [madeAt, order.waybill_number || null, order.id]
        );
        read++;
      } catch {
        failed++;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const left = await db.query(
    `SELECT COUNT(*)::int AS n FROM orders
     WHERE raw_data->'attributes'->'kaspiDelivery'->>'waybill' IS NOT NULL
       AND stage NOT IN ('cancelled', 'delivered', 'completed')
       AND (waybill_made_at IS NULL
            OR waybill_stamped_number IS DISTINCT FROM raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber')`
  );

  return { read, failed, remaining: left.rows[0].n };
}

module.exports = { parseCreationDate, refreshStamps };
