const axios = require('axios');
const db = require('../db/init');

// Когда накладную сформировали - в полях заказа этого нет. Kaspi пишет момент генерации
// только внутрь самого PDF, в /CreationDate. Оттуда его и читаем: это единственный способ
// разложить день на вывозы, если накладные печатают в кабинете Kaspi, а не через наш
// сервис (тогда assembly_batches пуст, и группировать нечем).
//
// Штамп не равен времени скачивания: Kaspi отдаёт уже сгенерированный PDF, и время в нём
// остаётся тем, когда накладную сделали. Проверено: файлы, скачанные в 17:28, несли 13:07.
//
// Окно для чтения закрывается. Накладная доступна, пока заказ лежит на складе; после
// передачи курьеру (у нас стадия shipping) тот же адрес отдаёт 404, и так навсегда -
// проверено 06.10.2026 на 40 заказах: скачался ровно один, единственный в стадии packed,
// все 26 отгруженных ответили 404, включая те, чей штамп мы успели прочитать раньше.
// Поэтому неудачу запоминаем (waybill_stamp_failed_at) и отгруженный заказ больше не
// трогаем: иначе «Прочитать» каждый раз перебирает одни и те же безнадёжные заказы,
// счётчик не двигается и кнопка выглядит сломанной.

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

// Заказы, у которых штамп ещё имеет смысл читать. Стадии перечисляем через IN, а не
// NOT IN: список закрыт, множество то же, но по нему работает индекс (39 тысяч строк).
// Повторная попытка - не раньше чем через 15 минут: накладная у Kaspi появляется
// до 3 минут, так что первая неудача по свежему заказу ещё ничего не значит.
const READABLE = `
  raw_data->'attributes'->'kaspiDelivery'->>'waybill' IS NOT NULL
  AND stage IN ('new', 'accepted', 'packed')
  AND (waybill_made_at IS NULL
       OR waybill_stamped_number IS DISTINCT FROM raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber')
  AND (waybill_stamp_failed_at IS NULL OR waybill_stamp_failed_at < NOW() - INTERVAL '15 minutes')`;

// Заказы, по которым штамп уже не прочитать: уехали, не успев отдать накладную.
const LOST = `
  raw_data->'attributes'->'kaspiDelivery'->>'waybill' IS NOT NULL
  AND stage = 'shipping'
  AND waybill_made_at IS NULL`;

/**
 * Дочитывает штампы у заказов, где их ещё нет или где накладную переформировали.
 * Возвращает, сколько прочитано, сколько не вышло и сколько осталось - интерфейсу есть
 * что показать, если заказов много и одного вызова не хватило. Отдельно отдаём lost:
 * это не «осталось дочитать», это «уже не прочитаем никогда», и предлагать нажать
 * кнопку ещё раз из-за них нельзя.
 */
async function refreshStamps(syncService, { limit = DEFAULT_LIMIT } = {}) {
  const targets = await db.query(
    `SELECT id, order_code, kaspi_order_id, store_id,
            raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber' AS waybill_number
     FROM orders
     WHERE ${READABLE}
     ORDER BY ship_date DESC NULLS LAST, id DESC
     LIMIT $1`,
    [limit]
  );

  let read = 0;
  let failed = 0;

  if (targets.rows.length > 0) {
    let cursor = 0;

    // Неудачу помечаем, чтобы следующий заход не начинался с тех же заказов
    const markFailed = (id) =>
      db.query('UPDATE orders SET waybill_stamp_failed_at = NOW() WHERE id = $1', [id]);

    const worker = async () => {
      while (cursor < targets.rows.length) {
        const order = targets.rows[cursor++];
        const store = syncService?.services?.[order.store_id];
        if (!store) {
          failed++;
          await markFailed(order.id);
          continue;
        }

        try {
          // Ссылка на накладную у Kaspi недолговечная - берём свежую, как это делает
          // и сборка архива в routes/batches.js
          const details = await store.service.getOrderDetails(order.kaspi_order_id);
          const url = details?.attributes?.kaspiDelivery?.waybill;
          if (!url) {
            failed++;
            await markFailed(order.id);
            continue;
          }

          const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: store.service.authHeaders()
          });
          const pdf = Buffer.from(response.data);
          const madeAt = parseCreationDate(pdf);
          if (!madeAt) {
            failed++;
            await markFailed(order.id);
            continue;
          }

          await db.query(
            `UPDATE orders
             SET waybill_made_at = $1, waybill_stamped_number = $2, waybill_stamp_failed_at = NULL
             WHERE id = $3`,
            [madeAt, order.waybill_number || null, order.id]
          );
          read++;
        } catch {
          failed++;
          await markFailed(order.id);
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  return { read, failed, ...(await countPending()) };
}

// Сколько ещё можно дочитать и сколько потеряно безвозвратно.
// Двумя запросами, а не одним с COUNT(*) FILTER: у FILTER нет WHERE, и Postgres обязан
// пройти все 39 тысяч строк, распаковывая jsonb. С отдельным WHERE работает индекс
// по стадии, и оба счётчика считаются по сотне строк вместо всей таблицы.
async function countPending() {
  const [left, lost] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE ${READABLE}`),
    db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE ${LOST}`)
  ]);
  return { remaining: left.rows[0].n, lost: lost.rows[0].n };
}

module.exports = { parseCreationDate, refreshStamps, countPending };
