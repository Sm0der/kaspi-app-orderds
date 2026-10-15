// Еженедельный отчёт владельцу: деньги, маржа, товары, карточки, логистика, дыры в данных.
//
//   node scripts/weekly-report.js                      # прошлая полная неделя (пн-вс)
//   node scripts/weekly-report.js --week=2026-10-06    # неделя, в которую попадает дата
//   node scripts/weekly-report.js --last7              # последние 7 дней, а не календарная неделя
//   node scripts/weekly-report.js --out=путь.html      # куда положить (по умолчанию reports/)
//
// Неделя считается ПОНЕДЕЛЬНИК-ВОСКРЕСЕНЬЕ по Алматы. День заказа берём из epoch
// creationDate, а не из order_date: у старых заказов там UTC, у новых алматинская
// полночь (см. CLAUDE.md). Везде ::text, иначе node-pg сдвинет дату на сутки.
//
// Сравниваем не с одним прошлым, а с тремя: прошлая неделя, средняя из четырёх
// предыдущих и та же неделя год назад. Одна неделя сама по себе ничего не говорит -
// у мебели сильная сезонность, и падение на 20% может быть и обвалом, и вторником.
//
// Деньги считаем до чистых: выручка − комиссия 11,75% − ФАКТИЧЕСКАЯ доставка из заказа
// (deliveryCostForSeller) − себестоимость технолога. Доставка у Kaspi одна на заказ,
// между позициями многотоварного заказа делим её по доле в сумме. Себестоимость есть
// не у всех артикулов, поэтому в отчёте всегда стоит покрытие: по какой доле выручки
// прибыль посчитана честно, а по какой неизвестна.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const { calculate } = require('../services/costingMath');

const COMMISSION = 0.1175;

const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith('--' + name + '='));
  return found ? found.slice(name.length + 3) : null;
};
const has = (name) => process.argv.includes('--' + name);

// ── даты ──────────────────────────────────────────────────────────────────────
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const mondayOf = (s) => { const d = new Date(s + 'T00:00:00Z'); const dw = (d.getUTCDay() + 6) % 7; return addDays(s, -dw); };
const RU_MONTH = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const RU_DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const human = (s) => { const d = new Date(s + 'T00:00:00Z'); return d.getUTCDate() + ' ' + RU_MONTH[d.getUTCMonth()]; };
const dow = (s) => RU_DOW[(new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7];

// ── числа ─────────────────────────────────────────────────────────────────────
const num = (v) => Number(v) || 0;
const m = (v) => Math.round(num(v)).toLocaleString('ru-RU');
const pct = (v, total) => (total ? (num(v) / num(total)) * 100 : 0);
const delta = (now, was) => (was ? ((num(now) - num(was)) / Math.abs(num(was))) * 100 : null);
const sign = (v, digits = 0) => (v === null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(digits) + '%');

// ── SQL-кирпичи ───────────────────────────────────────────────────────────────
// День и деньги заказа одним выражением: повторять его в каждом запросе дороже,
// чем ошибиться в одном месте из пяти.
const ORDER_DAY = `((to_timestamp((o.raw_data->'attributes'->>'creationDate')::bigint / 1000)
                     AT TIME ZONE 'Asia/Almaty')::date)`;
const ORDER_TOTAL = `(o.raw_data->'attributes'->>'totalPrice')::numeric`;
const ORDER_SHIP = `COALESCE((o.raw_data->'attributes'->>'deliveryCostForSeller')::numeric, 0)`;
const ITEM_QTY = `COALESCE((oi.raw_data->'attributes'->>'quantity')::int, oi.quantity, 1)`;
const ITEM_SUM = `COALESCE((oi.raw_data->'attributes'->>'totalPrice')::numeric, 0)`;
const CARD_ID = `convert_from(decode(oi.raw_data->'relationships'->'product'->'data'->>'id', 'base64'), 'UTF8')`;

// Себестоимость кода технолога — теми же формулами, что и раздел «Себестоимость».
// Код без спецификации считаем НЕИЗВЕСТНЫМ: пустая спецификация вернула бы одни тарифы
// (~3000 ₸) и прибыль вышла бы почти равной выручке.
async function costByProductId() {
  const { rows: products } = await db.query('SELECT * FROM cost_products');
  const { rows: lines } = await db.query(`
    SELECT pi.product_id, pi.quantity, pi.price, i.kind, i.counts_as
    FROM cost_product_items pi JOIN cost_items i ON i.id = pi.item_id`);
  const byProduct = new Map();
  for (const l of lines) {
    if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
    byProduct.get(l.product_id).push(l);
  }
  return new Map(products.map((p) => {
    const own = byProduct.get(p.id) || [];
    return [p.id, { code: p.code, name: p.name, cost: own.length ? calculate(p, own).cost : null }];
  }));
}

// ── срезы периода ─────────────────────────────────────────────────────────────
// Итог по деньгам за период: заказы, выручка, доставка, отмены, предзаказы.
async function totals(from, to) {
  const { rows } = await db.query(
    `SELECT s.name AS store,
            COUNT(*) FILTER (WHERE o.stage <> 'cancelled')::int AS orders,
            COALESCE(SUM(${ORDER_TOTAL}) FILTER (WHERE o.stage <> 'cancelled'), 0)::numeric AS revenue,
            COALESCE(SUM(${ORDER_SHIP}) FILTER (WHERE o.stage <> 'cancelled'), 0)::numeric AS ship,
            COUNT(*) FILTER (WHERE o.stage = 'cancelled')::int AS cancelled,
            COALESCE(SUM(${ORDER_TOTAL}) FILTER (WHERE o.stage = 'cancelled'), 0)::numeric AS cancelled_sum,
            COUNT(*) FILTER (WHERE o.stage <> 'cancelled'
                             AND (o.raw_data->'attributes'->>'preOrder')::boolean IS NOT TRUE)::int AS in_stock,
            COUNT(*) FILTER (WHERE o.stage <> 'cancelled'
                             AND o.raw_data->'attributes'->>'deliveryMode' = 'DELIVERY_LOCAL')::int AS local_delivery,
            -- рассрочка: Kaspi зовёт её PAY_WITH_CREDIT, а не CREDIT
            COUNT(*) FILTER (WHERE o.stage <> 'cancelled'
                             AND o.raw_data->'attributes'->>'paymentMode' = 'PAY_WITH_CREDIT')::int AS credit,
            COALESCE(SUM(${ORDER_TOTAL}) FILTER (WHERE o.stage <> 'cancelled'
                     AND o.raw_data->'attributes'->>'paymentMode' = 'PAY_WITH_CREDIT'), 0)::numeric AS credit_sum,
            COUNT(*) FILTER (WHERE o.raw_data->'attributes'->>'status' = 'RETURNED')::int AS returned
     FROM orders o JOIN stores s ON s.id = o.store_id
     WHERE ${ORDER_DAY} BETWEEN $1::date AND $2::date
     GROUP BY 1 ORDER BY revenue DESC`,
    [from, to]
  );
  for (const r of rows) {
    r.revenue = num(r.revenue); r.ship = num(r.ship);
    r.cancelled_sum = num(r.cancelled_sum); r.credit_sum = num(r.credit_sum);
  }
  const all = rows.reduce((a, r) => ({
    store: 'Оба магазина',
    orders: a.orders + r.orders, revenue: a.revenue + r.revenue, ship: a.ship + r.ship,
    cancelled: a.cancelled + r.cancelled, cancelled_sum: a.cancelled_sum + r.cancelled_sum,
    in_stock: a.in_stock + r.in_stock, local_delivery: a.local_delivery + r.local_delivery,
    credit: a.credit + r.credit, credit_sum: a.credit_sum + r.credit_sum,
    returned: a.returned + r.returned,
  }), { orders: 0, revenue: 0, ship: 0, cancelled: 0, cancelled_sum: 0, in_stock: 0, local_delivery: 0, credit: 0, credit_sum: 0, returned: 0 });
  all.avg = all.orders ? all.revenue / all.orders : 0;
  for (const r of rows) r.avg = r.orders ? r.revenue / r.orders : 0;

  // Сроки рассрочки: 12 и 24 месяца — это совсем другой покупатель, чем предоплата.
  const { rows: terms } = await db.query(
    `SELECT COALESCE(o.raw_data->'attributes'->>'creditTerm', 'предоплата') AS term,
            COUNT(*)::int AS n, COALESCE(SUM(${ORDER_TOTAL}), 0)::numeric AS sum
     FROM orders o
     WHERE o.stage <> 'cancelled' AND ${ORDER_DAY} BETWEEN $1::date AND $2::date
     GROUP BY 1 ORDER BY n DESC`,
    [from, to]
  );
  return { stores: rows, all, terms: terms.map((t) => ({ ...t, sum: num(t.sum) })) };
}

// Выручка по дням — для графика и для профиля дней недели.
async function daily(from, to) {
  const { rows } = await db.query(
    `SELECT ${ORDER_DAY}::text AS d,
            COUNT(*)::int AS orders,
            COALESCE(SUM(${ORDER_TOTAL}), 0)::numeric AS revenue
     FROM orders o
     WHERE o.stage <> 'cancelled' AND ${ORDER_DAY} BETWEEN $1::date AND $2::date
     GROUP BY 1 ORDER BY 1`,
    [from, to]
  );
  const byDay = new Map(rows.map((r) => [r.d, r]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = byDay.get(d);
    out.push({ d, dow: dow(d), orders: r ? r.orders : 0, revenue: r ? num(r.revenue) : 0 });
  }
  return out;
}

// Позиции по КАРТОЧКЕ, а не по паре «магазин + артикул»: товар переезжает между нашими
// двумя витринами с новым артикулом, и счёт по артикулу показал бы смерть там, где
// просто сменилась витрина (проверено на переезде 9-10.10.2026).
async function items(from, to, costs) {
  const { rows } = await db.query(
    `WITH ord AS (
       SELECT o.id, o.store_id, ${ORDER_TOTAL} AS total, ${ORDER_SHIP} AS ship
       FROM orders o
       WHERE o.stage <> 'cancelled' AND ${ORDER_DAY} BETWEEN $1::date AND $2::date
     )
     SELECT ${CARD_ID} AS card_id,
            MAX(COALESCE(p.name, oi.name)) AS name,
            STRING_AGG(DISTINCT s.name, ' + ') AS stores,
            SUM(${ITEM_QTY})::int AS qty,
            SUM(${ITEM_SUM})::numeric AS revenue,
            SUM(ord.ship * CASE WHEN ord.total > 0 THEN ${ITEM_SUM} / ord.total ELSE 0 END)::numeric AS ship,
            COUNT(DISTINCT ord.id)::int AS orders,
            MAX(p.cost_product_id)::int AS cost_product_id,
            MAX(oi.raw_data->'attributes'->'category'->>'title') AS category
     FROM order_items oi
     JOIN ord ON ord.id = oi.order_id
     JOIN stores s ON s.id = ord.store_id
     LEFT JOIN products p ON p.store_id = ord.store_id AND p.sku = oi.sku
     WHERE oi.raw_data->'relationships'->'product'->'data'->>'id' IS NOT NULL
     GROUP BY 1`,
    [from, to]
  );
  for (const r of rows) {
    r.qty = Number(r.qty); r.revenue = num(r.revenue); r.ship = num(r.ship);
    const c = r.cost_product_id ? costs.get(r.cost_product_id) : null;
    r.code = c ? c.code : null;
    r.unit_cost = c && c.cost !== null ? c.cost : null;
    r.cost = r.unit_cost !== null ? r.unit_cost * r.qty : null;
    r.commission = r.revenue * COMMISSION;
    r.net = r.cost === null ? null : r.revenue - r.commission - r.ship - r.cost;
    r.per_unit = r.net === null || !r.qty ? null : r.net / r.qty;
    r.markup = r.cost === null || !r.revenue ? null : ((r.revenue - r.cost) / r.revenue) * 100;
  }
  return rows.sort((a, b) => b.revenue - a.revenue);
}

// Отмены: Kaspi называет причину, и это разные беды. BUYER_CANCELLATION_HIMSELF -
// передумал покупатель, TECHNICAL_PROBLEM_CANCELLATION и TIMEOUT_MERCHANT_DELIVERY -
// наша вина, и только вторые чинятся работой склада.
const REASON_RU = {
  BUYER_CANCELLATION_HIMSELF: 'покупатель передумал',
  BUYER_CANCELLATION_BY_COURIER: 'отказ при доставке',
  TECHNICAL_PROBLEM_CANCELLATION: 'технический сбой или нет товара',
  TIMEOUT_BUYER_SIGNATURE: 'покупатель не подписал вовремя',
  TIMEOUT_MERCHANT_DELIVERY: 'мы не успели отгрузить',
  RFO_REJECTED: 'банк отказал в рассрочке',
  MERCHANT_CANCELLATION: 'отменили сами',
};
// Наша вина или нет — от этого зависит, чинится ли это работой.
const OUR_FAULT = new Set(['TECHNICAL_PROBLEM_CANCELLATION', 'TIMEOUT_MERCHANT_DELIVERY', 'MERCHANT_CANCELLATION']);

async function cancellations(from, to) {
  const { rows } = await db.query(
    `SELECT COALESCE(o.raw_data->'attributes'->>'cancellationReason', 'не указана') AS reason,
            COUNT(*)::int AS n,
            COALESCE(SUM(${ORDER_TOTAL}), 0)::numeric AS sum
     FROM orders o
     WHERE o.stage = 'cancelled' AND ${ORDER_DAY} BETWEEN $1::date AND $2::date
     GROUP BY 1 ORDER BY n DESC`,
    [from, to]
  );
  return rows.map((r) => ({ ...r, sum: num(r.sum), ru: REASON_RU[r.reason] || r.reason, ours: OUR_FAULT.has(r.reason) }));
}

// Логистика: сколько прошло от заказа до отгрузки и что застряло.
async function logistics(from, to) {
  // Мебель делается под заказ, поэтому «48 часов» здесь не порог, а шум: нормальный
  // срок - трое-четверо суток. Смотрим медиану и девяностый процентиль, и считаем
  // хвост больше недели - вот он уже отмены и жалобы.
  const H = `EXTRACT(EPOCH FROM (o.ship_date_first - to_timestamp((o.raw_data->'attributes'->>'creationDate')::bigint / 1000))) / 3600`;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS shipped,
            ROUND(AVG(${H})::numeric, 1) AS avg_hours,
            ROUND(percentile_disc(0.5) WITHIN GROUP (ORDER BY ${H})::numeric, 1) AS median_hours,
            ROUND(percentile_disc(0.9) WITHIN GROUP (ORDER BY ${H})::numeric, 1) AS p90_hours,
            COUNT(*) FILTER (WHERE ${H} > 168)::int AS over_week,
            COUNT(*) FILTER (WHERE o.waybill_stamp_failed_at IS NOT NULL)::int AS waybill_failed
     FROM orders o
     WHERE o.stage <> 'cancelled' AND o.ship_date_first IS NOT NULL
       AND ${ORDER_DAY} BETWEEN $1::date AND $2::date`,
    [from, to]
  );
  const { rows: stuck } = await db.query(
    `SELECT s.name AS store, o.order_code, ${ORDER_TOTAL}::numeric AS total, o.stage,
            ${ORDER_DAY}::text AS d
     FROM orders o JOIN stores s ON s.id = o.store_id
     WHERE o.stage IN ('new', 'accepted', 'packed')
       AND ${ORDER_DAY} < CURRENT_DATE - 2
     ORDER BY d LIMIT 15`
  );
  return { ...rows[0], stuck: stuck.map((r) => ({ ...r, total: num(r.total) })) };
}

// Места на карточках: первый и последний срез внутри недели. Карточка одна на два
// магазина, поэтому берём лучшее из двух мест.
async function ranks(from, to) {
  const { rows: dayRows } = await db.query(
    `SELECT DISTINCT checked_day::text AS d FROM product_card_rank_history
     WHERE checked_day BETWEEN $1::date AND $2::date ORDER BY d`,
    [from, to]
  );
  const days = dayRows.map((r) => r.d);
  if (days.length < 2) return { days, moves: [], gone: [], deep: [], all: [] };
  const first = days[0];
  const last = days[days.length - 1];
  const { rows } = await db.query(
    `WITH best AS (
       SELECT card_id, checked_day::text AS d, MIN(place) AS place,
              MIN(our_price) AS our_price, MIN(best_price) AS best_price,
              MAX(offers_total) AS offers_total, MIN(best_seller) AS best_seller
       FROM product_card_rank_history
       WHERE checked_day IN ($1::date, $2::date)
       GROUP BY 1, 2
     ),
     named AS (
       SELECT DISTINCT ON (h.card_id) h.card_id, COALESCE(p.name, h.sku) AS name
       FROM product_card_rank_history h
       LEFT JOIN products p ON p.store_id = h.store_id AND p.sku = h.sku
       WHERE h.checked_day = $2::date
     )
     SELECT COALESCE(n.name, a.card_id) AS name, a.card_id,
            a.place AS place_was, b.place AS place_now,
            a.our_price AS price_was, b.our_price AS price_now,
            b.best_price, b.offers_total, b.best_seller
     FROM best a
     LEFT JOIN best b ON b.card_id = a.card_id AND b.d = $2::text
     LEFT JOIN named n ON n.card_id = a.card_id
     WHERE a.d = $1::text`,
    [first, last]
  );
  for (const r of rows) {
    r.price_was = r.price_was === null ? null : num(r.price_was);
    r.price_now = r.price_now === null ? null : num(r.price_now);
    r.best_price = r.best_price === null ? null : num(r.best_price);
  }
  const moves = rows
    .filter((r) => r.place_was !== null && r.place_now !== null && r.place_was !== r.place_now)
    .map((r) => ({ ...r, shift: r.place_was - r.place_now }))
    .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
  const gone = rows.filter((r) => r.place_was !== null && r.place_now === null);
  const back = rows.filter((r) => r.place_was === null && r.place_now !== null);
  const deep = rows.filter((r) => r.place_now !== null && r.place_now > 10)
    .sort((a, b) => b.place_now - a.place_now);
  const top3 = rows.filter((r) => r.place_now !== null && r.place_now <= 3).length;
  return { days, first, last, moves, gone, back, deep, top3, all: rows };
}

// Тревоги, которые скрипт поднимал за неделю.
async function alerts(from, to) {
  const { rows } = await db.query(
    `SELECT title, message, created_at::text AS created_at
     FROM notifications
     WHERE (data->>'kind') = 'card-drop'
       AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Almaty')::date BETWEEN $1::date AND $2::date
     ORDER BY created_at`,
    [from, to]
  );
  return rows;
}

// ── реклама ───────────────────────────────────────────────────────────────────
// Meta выставляет счёт в долларах; в тенге пересчитываем одним курсом, чтобы цифры
// в отчёте можно было складывать с выручкой. Курс грубый и это нормально: расход
// на рекламу — доли процента оборота, и сотня тенге на доллар ничего не решает.
const USD_KZT = 449;

// Куда ведёт группа объявлений. Цель кампании для этого не годится: она задаётся на
// кампании, назначение — на группе, и они расходятся молча (кампания «Этно комод
// 3.09 широкая» с целью ПРОДАЖИ ведёт в WhatsApp). Проверено 13.10.2026.
const DESTINATION_RU = {
  UNDEFINED: 'на карточку Kaspi',
  INSTAGRAM_PROFILE: 'в профиль Instagram',
  WHATSAPP: 'в переписку',
  INSTAGRAM_DIRECT: 'в переписку',
  MESSAGING_INSTAGRAM_DIRECT_WHATSAPP: 'в переписку',
};
const destinationRu = (d) => DESTINATION_RU[d] || 'прочее';

async function adsFor(from, to) {
  const { rows } = await db.query(
    `SELECT destination_type, campaign_name,
            SUM(spend_usd)::numeric AS usd,
            SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks,
            SUM(outbound_clicks)::bigint AS outbound,
            SUM(link_clicks)::bigint AS link_clicks
     FROM ad_spend_daily
     WHERE day BETWEEN $1::date AND $2::date
     GROUP BY 1, 2`,
    [from, to]
  );
  const byDest = new Map();
  let usd = 0;
  let impressions = 0;
  let clicks = 0;
  let outbound = 0;
  for (const r of rows) {
    const key = destinationRu(r.destination_type);
    const d = byDest.get(key) || { destination: key, usd: 0, impressions: 0, clicks: 0, outbound: 0, campaigns: new Set() };
    d.usd += num(r.usd); d.impressions += Number(r.impressions); d.clicks += Number(r.clicks); d.outbound += Number(r.outbound);
    d.campaigns.add(r.campaign_name);
    byDest.set(key, d);
    usd += num(r.usd); impressions += Number(r.impressions); clicks += Number(r.clicks); outbound += Number(r.outbound);
  }
  const dest = [...byDest.values()].map((d) => ({
    ...d, kzt: d.usd * USD_KZT, campaigns: d.campaigns.size,
    cpc: d.clicks ? (d.usd * USD_KZT) / d.clicks : null,
    ctr: d.impressions ? (d.clicks / d.impressions) * 100 : null,
  })).sort((a, b) => b.usd - a.usd);
  return {
    usd, kzt: usd * USD_KZT, impressions, clicks, outbound, dest,
    cpc: clicks ? (usd * USD_KZT) / clicks : null,
    cpm: impressions ? ((usd * USD_KZT) / impressions) * 1000 : null,
    ctr: impressions ? (clicks / impressions) * 100 : null,
  };
}

// Реклама и продажи по НЕДЕЛЯМ — то, ради чего отчёт и затевался. Одна неделя
// отношения расход/выручка не показывает: расход скачет втрое, выручка нет.
async function adsVsSalesByWeek(lastMonday, weeks) {
  const out = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const a = addDays(lastMonday, -7 * i);
    const b = addDays(a, 6);
    const [t, ad] = await Promise.all([totals(a, b), adsFor(a, b)]);
    out.push({
      from: a, to: b,
      revenue: t.all.revenue, orders: t.all.orders,
      usd: ad.usd, kzt: ad.kzt, clicks: ad.clicks,
      share: t.all.revenue ? (ad.kzt / t.all.revenue) * 100 : 0,
      roas: ad.kzt ? t.all.revenue / ad.kzt : null,
    });
  }
  return out;
}

// То же самое по МЕСЯЦАМ: восемь недель показывают текущую картину, месяцы — всю
// историю расхода. Именно на месяцах видно, что рекордный август сделан при вдвое
// меньшем расходе, чем июль.
async function adsVsSalesByMonth() {
  const { rows } = await db.query(
    `WITH ad AS (
       SELECT to_char(day, 'YYYY-MM') AS mon,
              SUM(spend_usd)::numeric AS usd, SUM(clicks)::bigint AS clicks
       FROM ad_spend_daily GROUP BY 1
     ),
     sale AS (
       SELECT to_char(${ORDER_DAY}, 'YYYY-MM') AS mon,
              COALESCE(SUM(${ORDER_TOTAL}), 0)::numeric AS revenue,
              COUNT(*)::int AS orders
       FROM orders o
       WHERE o.stage <> 'cancelled'
         AND ${ORDER_DAY} >= (SELECT MIN(day) FROM ad_spend_daily)
       GROUP BY 1
     )
     SELECT COALESCE(ad.mon, sale.mon) AS mon,
            COALESCE(ad.usd, 0)::numeric AS usd, COALESCE(ad.clicks, 0)::bigint AS clicks,
            COALESCE(sale.revenue, 0)::numeric AS revenue, COALESCE(sale.orders, 0)::int AS orders
     FROM ad FULL JOIN sale ON sale.mon = ad.mon
     -- месяцы, где расход был, а заказов в базе нет, — это период до заливки истории
     -- (январь 2024). Строка «расход 45 883 ₸, выручка 0» читается как провал, хотя
     -- это просто отсутствие данных.
     WHERE COALESCE(ad.usd, 0) > 0 AND COALESCE(sale.orders, 0) > 0
     ORDER BY 1`
  );
  return rows.map((r) => {
    const kzt = num(r.usd) * USD_KZT;
    return {
      mon: r.mon, usd: num(r.usd), kzt, clicks: Number(r.clicks),
      revenue: num(r.revenue), orders: r.orders,
      share: num(r.revenue) ? (kzt / num(r.revenue)) * 100 : 0,
      roas: kzt ? num(r.revenue) / kzt : null,
    };
  });
}

// Чего не хватает в данных. Отчёт обязан говорить, по какой части он молчит, -
// иначе «прибыль 2 млн» читается как факт, хотя посчитана по половине выручки.
async function gaps() {
  const [prodRes, whRes, rankRes] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE cost_product_id IS NOT NULL)::int AS linked,
                     COUNT(*) FILTER (WHERE price IS NULL)::int AS no_price
              FROM products`),
    db.query(`SELECT COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE cost_product_id IS NOT NULL)::int AS linked
              FROM warehouse_items`),
    db.query(`SELECT COUNT(*)::int AS n, MAX(checked_day)::text AS d
              FROM product_card_rank_history
              WHERE checked_day = (SELECT MAX(checked_day) FROM product_card_rank_history)`),
  ]);
  return { prod: prodRes.rows[0], wh: whRes.rows[0], rank: rankRes.rows[0] };
}

// ── сборка ────────────────────────────────────────────────────────────────────
function moneyBlock(list) {
  const revenue = list.reduce((a, r) => a + r.revenue, 0);
  const known = list.filter((r) => r.net !== null);
  const knownRevenue = known.reduce((a, r) => a + r.revenue, 0);
  const commission = list.reduce((a, r) => a + r.commission, 0);
  const ship = list.reduce((a, r) => a + r.ship, 0);
  const cost = known.reduce((a, r) => a + r.cost, 0);
  const net = known.reduce((a, r) => a + r.net, 0);
  return {
    revenue, commission, ship, cost, net,
    knownRevenue, coverage: pct(knownRevenue, revenue),
    netRate: knownRevenue ? (net / knownRevenue) * 100 : 0,
    // если по известной части остаётся столько-то процентов, столько же можно ждать и со всей
    netProjected: knownRevenue ? (net / knownRevenue) * revenue : 0,
  };
}

async function collect(from, to) {
  const prevFrom = addDays(from, -7);
  const prevTo = addDays(to, -7);
  const yearFrom = addDays(from, -364);
  const yearTo = addDays(to, -364);
  const fourFrom = addDays(from, -28);
  const fourTo = addDays(from, -1);

  const costs = await costByProductId();
  const [now, prev, year, four, series, prevSeries, itemsNow, itemsPrev,
    cancelNow, cancelPrev, log, rank, alertRows, gap] = await Promise.all([
    totals(from, to), totals(prevFrom, prevTo), totals(yearFrom, yearTo), totals(fourFrom, fourTo),
    daily(from, to), daily(prevFrom, prevTo),
    items(from, to, costs), items(prevFrom, prevTo, costs),
    cancellations(from, to), cancellations(prevFrom, prevTo),
    logistics(from, to), ranks(addDays(from, -1), to), alerts(from, to), gaps(),
  ]);

  const [ads, adsPrev, adsWeeks, adsMonths] = await Promise.all([
    adsFor(from, to), adsFor(prevFrom, prevTo), adsVsSalesByWeek(from, 8), adsVsSalesByMonth(),
  ]);

  // движение позиций неделя к неделе — по карточке
  const prevByCard = new Map(itemsPrev.map((r) => [r.card_id, r]));
  const nowCards = new Set(itemsNow.map((r) => r.card_id));
  const movers = itemsNow.map((r) => {
    const was = prevByCard.get(r.card_id);
    return {
      ...r,
      was_revenue: was ? was.revenue : 0,
      was_qty: was ? was.qty : 0,
      d_revenue: r.revenue - (was ? was.revenue : 0),
      fresh: !was,
    };
  });
  const disappeared = itemsPrev
    .filter((r) => !nowCards.has(r.card_id) && r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);

  // категории
  const catMap = new Map();
  for (const r of itemsNow) {
    const k = r.category || 'без категории';
    const c = catMap.get(k) || { category: k, revenue: 0, qty: 0, net: 0, known: 0 };
    c.revenue += r.revenue; c.qty += r.qty;
    if (r.net !== null) { c.net += r.net; c.known += r.revenue; }
    catMap.set(k, c);
  }
  const categories = [...catMap.values()].sort((a, b) => b.revenue - a.revenue);

  // Окупаемость рекламы. ROAS в его обычном виде здесь посчитать НЕЛЬЗЯ: пиксель на
  // Kaspi не поставить, это чужой сайт, поэтому ни одна покупка к объявлению не
  // привязана (omni_purchase пуст у всех групп). Валовый ROAS «вся выручка делить на
  // расход» печатаем только как масштаб — он приписывает рекламе и те заказы, которые
  // пришли бы сами. Решение принимают по ПОРОГУ: сколько заказов реклама должна была
  // принести, чтобы вернуть вложенное, и какая для этого нужна конверсия перехода.
  const money = moneyBlock(itemsNow);
  const netPerOrder = now.all.orders ? (money.netProjected / now.all.orders) : 0;
  const payback = {
    usd: ads.usd, kzt: ads.kzt, clicks: ads.clicks,
    share: now.all.revenue ? (ads.kzt / now.all.revenue) * 100 : 0,
    grossRoas: ads.kzt ? now.all.revenue / ads.kzt : null,
    netPerOrder,
    ordersNeeded: netPerOrder > 0 ? ads.kzt / netPerOrder : null,
    ordersNeededShare: netPerOrder > 0 && now.all.orders ? (ads.kzt / netPerOrder / now.all.orders) * 100 : null,
    conversionNeeded: netPerOrder > 0 && ads.clicks ? (ads.kzt / netPerOrder / ads.clicks) * 100 : null,
    // замеренная конверсия нашей карточки — 0,47-0,49% (CLAUDE.md, замер 07.10.2026)
    conversionMeasured: 0.48,
  };

  // профиль дней недели по четырём предыдущим неделям — чтобы отличить провал от вторника
  const profileSeries = await daily(fourFrom, fourTo);
  const profile = RU_DOW.map((d) => {
    const days = profileSeries.filter((x) => x.dow === d);
    return { dow: d, avg: days.length ? days.reduce((a, x) => a + x.revenue, 0) / days.length : 0 };
  });

  return {
    from, to, prevFrom, prevTo, yearFrom, yearTo, fourFrom, fourTo,
    now, prev, year, four, series, prevSeries, profile,
    ads, adsPrev, adsWeeks, adsMonths, payback, USD_KZT,
    money, moneyPrev: moneyBlock(itemsPrev),
    itemsNow, itemsPrev, movers, disappeared, categories,
    cancelNow, cancelPrev, log, rank, alerts: alertRows, gaps: gap,
    generated: new Date().toISOString(),
  };
}

module.exports = {
  collect, addDays, mondayOf, iso, human, dow, m, pct, delta, sign, num,
  COMMISSION, RU_DOW, USD_KZT, destinationRu,
};

// ── запуск ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    let from;
    let to;
    if (has('last7')) {
      to = iso(new Date(Date.now() - 24 * 3600 * 1000));
      from = addDays(to, -6);
    } else if (arg('week')) {
      from = mondayOf(arg('week'));
      to = addDays(from, 6);
    } else {
      from = addDays(mondayOf(iso(new Date())), -7);
      to = addDays(from, 6);
    }

    const data = await collect(from, to);
    const { renderText, renderHtml } = require('./weekly-report-render');
    console.log(renderText(data));

    const out = arg('out') || path.join(__dirname, '..', 'reports', 'nedelya-' + from + '.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderHtml(data), 'utf8');
    console.log('\nОтчёт: ' + out);

    await db.pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
