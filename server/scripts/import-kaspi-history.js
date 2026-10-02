// Разовая заливка истории заказов Kaspi за 2025-2026 в боевую базу.
//
// Зачем: синхронизация умеет смотреть назад только на 14 дней (ограничение фильтра Kaspi),
// поэтому в базе лежали заказы с августа 2026. Саму историю Kaspi хранит - её можно забрать,
// двигая то же 14-дневное окно в прошлое, что и делают скрипты выгрузки. Этот скрипт кладёт
// выгруженное в обычные orders / order_items, чтобы «Аналитика» и «Архив» показывали два
// года без единой правки кода.
//
// Данные берутся из двух JSONL, снятых с Kaspi:
//   --orders  строки вида { storeId, store, id, a: <attributes заказа> }
//   --entries строки вида { id, st, d, cx, it: [{ n, s, c, q, p }] }
//
// ОТКАТ. Каждая вставленная строка пишется в журнал history_import с меткой партии,
// поэтому заливку можно снять целиком: `node import-kaspi-history.js --rollback <batch>`.
// Удаляются только те заказы, которые добавил именно этот запуск: существующие строки
// не трогаются (вставка идёт через ON CONFLICT DO NOTHING), и в журнал они не попадают.
//
// Запуск:
//   node server/scripts/import-kaspi-history.js --orders <файл> --entries <файл>          # показать план
//   node server/scripts/import-kaspi-history.js --orders <файл> --entries <файл> --apply  # залить
//   node server/scripts/import-kaspi-history.js --rollback <batch>                        # снять
//   node server/scripts/import-kaspi-history.js --batches                                 # список партий

const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const { transformKaspiOrder } = require('../services/orderProcessor');

const BATCH = 500;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(name);

const readJsonl = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const placeholders = (rows, cols) =>
  Array.from({ length: rows }, (_, r) =>
    `(${Array.from({ length: cols }, (_, c) => `$${r * cols + c + 1}`).join(',')})`
  ).join(',');

// Тот же хеш, что считает синхронизация: иначе она сочтёт каждый исторический заказ
// изменившимся и перепишет все 39 тысяч строк при первом же запуске.
const rawHashOf = (kaspiOrder) =>
  crypto.createHash('md5')
    .update(JSON.stringify(kaspiOrder, (k, v) => (k === 'waybill' ? undefined : v)))
    .digest('hex');

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Нет DATABASE_URL');
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

async function ensureLog(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS history_import (
      batch          text        NOT NULL,
      order_id       integer     NOT NULL,
      kaspi_order_id varchar(100) NOT NULL,
      imported_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (batch, order_id)
    )`);
}

async function listBatches(db) {
  await ensureLog(db);
  const { rows } = await db.query(`
    SELECT batch, count(*)::int AS orders, min(imported_at) AS started, max(imported_at) AS finished
    FROM history_import GROUP BY batch ORDER BY min(imported_at)`);
  if (!rows.length) return console.log('Залитых партий нет.');
  console.table(rows.map((r) => ({
    партия: r.batch, заказов: r.orders,
    начата: r.started.toISOString().slice(0, 19).replace('T', ' '),
  })));
}

async function rollback(db, batch) {
  await ensureLog(db);
  const { rows: [stat] } = await db.query(
    `SELECT count(*)::int AS n FROM history_import WHERE batch = $1`, [batch]);
  if (!stat.n) throw new Error(`Партия "${batch}" в журнале не найдена`);

  console.log(`Откат партии ${batch}: ${stat.n} заказов`);
  await db.query('BEGIN');
  try {
    const items = await db.query(
      `DELETE FROM order_items WHERE order_id IN (SELECT order_id FROM history_import WHERE batch = $1)`, [batch]);
    const orders = await db.query(
      `DELETE FROM orders WHERE id IN (SELECT order_id FROM history_import WHERE batch = $1)`, [batch]);
    await db.query(`DELETE FROM history_import WHERE batch = $1`, [batch]);
    await db.query('COMMIT');
    console.log(`Удалено: заказов ${orders.rowCount}, позиций ${items.rowCount}`);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

async function run(db, ordersFile, entriesFile, apply) {
  const batch = 'history-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const orders = readJsonl(ordersFile);
  const entries = new Map(readJsonl(entriesFile).map((e) => [e.id, e.it]));
  console.log(`Выгрузка: заказов ${orders.length}, из них с позициями ${entries.size}`);

  const { rows: [before] } = await db.query(`SELECT count(*)::int AS n FROM orders`);
  const { rows: [sz] } = await db.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS s`);
  console.log(`Сейчас в базе: заказов ${before.n}, размер ${sz.s}`);

  if (!apply) {
    const stages = {};
    for (const o of orders) {
      const t = transformKaspiOrder({ id: o.id, attributes: o.a }, o.storeId);
      stages[t.stage] = (stages[t.stage] || 0) + 1;
    }
    console.log('Стадии, которые получат заказы:', JSON.stringify(stages));
    console.log('\nЭто предварительный просмотр. Для заливки добавьте --apply');
    return;
  }

  await ensureLog(db);
  let inserted = 0, skipped = 0, items = 0;

  for (const part of chunk(orders, BATCH)) {
    const values = [];
    for (const o of part) {
      const kaspiOrder = { id: o.id, attributes: o.a };
      const t = transformKaspiOrder(kaspiOrder, o.storeId);
      values.push(
        t.store_id, t.kaspi_order_id, t.order_code, t.status, t.state, t.stage,
        t.delivery_date, t.ship_date, t.order_date, t.urgency,
        JSON.stringify(kaspiOrder), rawHashOf(kaspiOrder)
      );
    }

    await db.query('BEGIN');
    try {
      // DO NOTHING, а не DO UPDATE: живые заказы ведёт синхронизация, и перезаписать их
      // historical-снимком значило бы откатить их состояние на момент выгрузки.
      const res = await db.query(
        `INSERT INTO orders (store_id, kaspi_order_id, order_code, status, state, stage,
                             delivery_date, ship_date, order_date, urgency, raw_data, raw_hash)
         VALUES ${placeholders(part.length, 12)}
         ON CONFLICT (kaspi_order_id) DO NOTHING
         RETURNING id, kaspi_order_id`,
        values
      );
      inserted += res.rowCount;
      skipped += part.length - res.rowCount;

      if (res.rowCount) {
        const logValues = [];
        for (const r of res.rows) logValues.push(batch, r.id, r.kaspi_order_id);
        await db.query(
          `INSERT INTO history_import (batch, order_id, kaspi_order_id)
           VALUES ${placeholders(res.rowCount, 3)} ON CONFLICT DO NOTHING`,
          logValues
        );

        // Позиции - только для заказов, которые эта вставка действительно создала.
        const itemRows = [];
        for (const r of res.rows) {
          for (const it of entries.get(r.kaspi_order_id) || []) {
            if (!it.s) continue;
            itemRows.push([
              r.id, it.s, it.s, it.n || it.c || 'Товар', it.q || 1, null,
              // Полный entry из Kaspi мы не сохраняли - кладём те же поля в его форме,
              // потому что аналитика читает отсюда attributes.totalPrice.
              JSON.stringify({ attributes: {
                quantity: it.q || 1, totalPrice: it.p || 0,
                offer: { code: it.s, name: it.n }, category: { title: it.c }
              } })
            ]);
          }
        }
        for (const ipart of chunk(itemRows, BATCH)) {
          const iv = [];
          for (const row of ipart) iv.push(...row);
          const ir = await db.query(
            `INSERT INTO order_items (order_id, product_code, sku, name, quantity, image_url, raw_data)
             VALUES ${placeholders(ipart.length, 7)}
             ON CONFLICT (order_id, product_code) DO NOTHING`,
            iv
          );
          items += ir.rowCount;
        }
      }
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      console.error(`Пачка упала, откатил её: ${e.message}`);
      throw e;
    }

    if ((inserted + skipped) % 5000 < BATCH) {
      console.log(`  ${inserted + skipped}/${orders.length} — вставлено ${inserted}, пропущено ${skipped}`);
    }
  }

  const { rows: [after] } = await db.query(`SELECT count(*)::int AS n FROM orders`);
  const { rows: [sz2] } = await db.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS s`);
  console.log(`\nГотово. Партия: ${batch}`);
  console.log(`Вставлено заказов ${inserted}, пропущено как уже существующие ${skipped}, позиций ${items}`);
  console.log(`Заказов в базе: ${before.n} -> ${after.n}, размер базы: ${sz.s} -> ${sz2.s}`);
  console.log(`\nОткатить: node server/scripts/import-kaspi-history.js --rollback ${batch}`);
}

(async () => {
  const db = connect();
  await db.connect();
  try {
    if (has('--batches')) return await listBatches(db);
    const back = arg('--rollback');
    if (back) return await rollback(db, back);
    const o = arg('--orders'), e = arg('--entries');
    if (!o || !e) {
      console.log('Укажите --orders <файл> и --entries <файл>, либо --rollback <batch>, либо --batches');
      process.exitCode = 1;
      return;
    }
    await run(db, o, e, has('--apply'));
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
