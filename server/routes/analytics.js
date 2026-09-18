const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin } = require('../middleware/requireAuth');
const { calculate } = require('../services/costingMath');

// Аналитика для владельца. Читает те же таблицы, что и рабочие разделы, ничего не пишет.
//
// Почему только владельцу: здесь выручка, себестоимость и выработка поимённо. Менеджеру
// для работы это не нужно, а технологу закрыто по той же причине, что и заказы.
router.use(requireAdmin);

// Все даты считаем по Алматы (UTC+5, без перевода стрелок). Колонка order_date для этого
// не годится: у заказов, загруженных до правки часового пояса, в ней лежит момент по UTC,
// а у новых - алматинская полночь. Единственный надёжный источник - epoch из raw_data,
// поэтому день везде выводим из него арифметикой, без участия часового пояса сервера.
const almatyDay = (ms) =>
  `((timestamp 'epoch' + ((${ms})::bigint + 18000000) / 1000 * interval '1 second')::date)`;

const CREATED_MS = "(o.raw_data->'attributes'->>'creationDate')";
const HANDED_MS = "(o.raw_data->'attributes'->'kaspiDelivery'->>'courierTransmissionDate')";

// Заказы периода: отмена остаётся в выборке отдельной строкой, а не выбрасывается молча -
// доля отказов и есть одна из цифр, ради которых раздел делался.
const SCOPE = `
  scope AS (
    SELECT o.id, o.store_id, o.stage, o.order_code,
           ${almatyDay(CREATED_MS)} AS created_day,
           CASE WHEN ${HANDED_MS} IS NOT NULL THEN ${almatyDay(HANDED_MS)} END AS handed_day,
           ${CREATED_MS}::bigint AS created_ms,
           ${HANDED_MS}::bigint AS handed_ms,
           o.ship_date, o.ship_date_first,
           (o.raw_data->'attributes'->>'totalPrice')::numeric AS total_price,
           (o.raw_data->'attributes'->'deliveryAddress'->>'town') AS town,
           o.stage = 'cancelled' AS cancelled
    FROM orders o
    WHERE ${almatyDay(CREATED_MS)} BETWEEN $1::date AND $2::date
      AND ($3::int IS NULL OR o.store_id = $3)
  )`;

function parseRange(req) {
  const valid = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null);
  const from = valid(req.query.from);
  const to = valid(req.query.to);
  const store = Number(req.query.store);

  // По умолчанию - последние 30 дней по Алматы
  const nowAlmaty = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const day = (offset) => new Date(nowAlmaty.getTime() - offset * 86400000).toISOString().slice(0, 10);

  return {
    from: from || day(29),
    to: to || day(0),
    store: Number.isInteger(store) && store > 0 ? store : null,
  };
}

// GET /api/analytics/overview - деньги, логистика и люди за период одним запросом
router.get('/overview', async (req, res, next) => {
  try {
    const { from, to, store } = parseRange(req);
    const args = [from, to, store];

    const [totals, byDay, byStore, towns, shipDay, products, lead, pending, people, costs] = await Promise.all([
      db.query(
        `WITH ${SCOPE}
         SELECT COUNT(*)::int AS orders,
                COUNT(*) FILTER (WHERE cancelled)::int AS cancelled_orders,
                COALESCE(SUM(total_price) FILTER (WHERE NOT cancelled), 0)::numeric AS revenue,
                COALESCE(SUM(total_price) FILTER (WHERE cancelled), 0)::numeric AS cancelled_revenue,
                COUNT(*) FILTER (WHERE handed_day IS NOT NULL)::int AS handed,
                -- Перенос срока: плановая дата уехала вперёд от той, что мы увидели первой.
                -- Сравнивать с планом самого Kaspi бесполезно - он подтягивает план
                -- к факту в момент передачи курьеру, и просрочки там не бывает никогда.
                COUNT(*) FILTER (WHERE ship_date_first IS NOT NULL
                                   AND ship_date > ship_date_first)::int AS postponed,
                COALESCE(MAX(ship_date - ship_date_first), 0)::int AS postponed_max_days,
                ROUND(AVG(ship_date - ship_date_first)
                      FILTER (WHERE ship_date > ship_date_first)::numeric, 1) AS postponed_avg_days
         FROM scope`,
        args
      ),

      db.query(
        `WITH ${SCOPE}
         -- ::text обязателен: DATE node-pg превращает в Date по поясу процесса, и при
         -- сериализации в JSON алматинская полночь уезжает на предыдущий день.
         SELECT created_day::text AS day,
                COUNT(*) FILTER (WHERE NOT cancelled)::int AS orders,
                COALESCE(SUM(total_price) FILTER (WHERE NOT cancelled), 0)::numeric AS revenue,
                COUNT(*) FILTER (WHERE cancelled)::int AS cancelled
         FROM scope GROUP BY 1 ORDER BY 1`,
        args
      ),

      db.query(
        `WITH ${SCOPE}
         SELECT s.id AS store_id, s.name,
                COUNT(*) FILTER (WHERE NOT cancelled)::int AS orders,
                COALESCE(SUM(total_price) FILTER (WHERE NOT cancelled), 0)::numeric AS revenue,
                COUNT(*) FILTER (WHERE cancelled)::int AS cancelled
         FROM scope JOIN stores s ON s.id = scope.store_id
         GROUP BY 1, 2 ORDER BY revenue DESC`,
        args
      ),

      db.query(
        `WITH ${SCOPE}
         SELECT COALESCE(NULLIF(town, ''), 'без города') AS town,
                COUNT(*) FILTER (WHERE NOT cancelled)::int AS orders,
                COALESCE(SUM(total_price) FILTER (WHERE NOT cancelled), 0)::numeric AS revenue
         FROM scope GROUP BY 1 ORDER BY orders DESC LIMIT 12`,
        args
      ),

      // Отгрузки берём по дню передачи курьеру, а не по дню оформления: заказ, оформленный
      // в марте и уехавший в апреле, для склада - апрельский день работы.
      db.query(
        `SELECT ${almatyDay(HANDED_MS)}::text AS day, COUNT(*)::int AS handed
         FROM orders o
         WHERE ${HANDED_MS} IS NOT NULL
           AND ${almatyDay(HANDED_MS)} BETWEEN $1::date AND $2::date
           AND ($3::int IS NULL OR o.store_id = $3)
         GROUP BY 1 ORDER BY 1`,
        args
      ),

      // Товары: выручку берём из позиции заказа, а не делением суммы заказа -
      // в одном заказе бывает несколько разных изделий.
      db.query(
        `WITH ${SCOPE}
         SELECT oi.sku, MIN(oi.name) AS name,
                SUM(oi.quantity)::int AS qty,
                COALESCE(SUM((oi.raw_data->'attributes'->>'totalPrice')::numeric), 0)::numeric AS revenue,
                MAX(p.cost_product_id) AS cost_product_id
         FROM scope
         JOIN order_items oi ON oi.order_id = scope.id
         LEFT JOIN products p ON p.sku = oi.sku AND p.store_id = scope.store_id
         WHERE NOT scope.cancelled
         GROUP BY oi.sku ORDER BY revenue DESC LIMIT 25`,
        args
      ),

      // Сколько часов проходит от оформления до передачи курьеру
      db.query(
        `WITH ${SCOPE}
         SELECT ROUND(AVG((handed_ms - created_ms) / 3600000.0)::numeric, 1) AS avg_hours,
                ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP
                       (ORDER BY (handed_ms - created_ms) / 3600000.0))::numeric, 1) AS median_hours
         FROM scope WHERE handed_ms IS NOT NULL AND handed_ms > created_ms`,
        args
      ),

      // Что висит прямо сейчас - вне периода: владельцу это нужно на сегодня, а не за март
      db.query(
        `SELECT stage, COUNT(*)::int AS orders
         FROM orders WHERE stage IN ('new', 'accepted', 'packed')
           AND ($1::int IS NULL OR store_id = $1)
         GROUP BY 1`,
        [store]
      ),

      peopleStats(from, to),
      costPerProduct(),
    ]);

    const t = totals.rows[0];
    const sold = t.orders - t.cancelled_orders;

    res.json({
      range: { from, to, store },
      money: {
        orders: t.orders,
        sold,
        revenue: Number(t.revenue),
        avgCheck: sold > 0 ? Math.round(Number(t.revenue) / sold) : 0,
        cancelledOrders: t.cancelled_orders,
        cancelledRevenue: Number(t.cancelled_revenue),
        byDay: byDay.rows,
        byStore: byStore.rows,
      },
      products: products.rows.map((row) => {
        const found = row.cost_product_id ? costs.get(row.cost_product_id) : null;
        const linked = found && found.cost !== null ? found : null;
        return {
          sku: row.sku,
          name: row.name,
          qty: row.qty,
          revenue: Number(row.revenue),
          // Маржа показывается только у товаров, связанных с изделием в «Себестоимости»:
          // без связи честнее прочерк, чем выручка, выданная за прибыль.
          cost: linked ? linked.cost * row.qty : null,
          profit: linked ? Math.round(Number(row.revenue) - linked.cost * row.qty) : null,
          // Код показываем, даже если себестоимости по нему пока нет: владельцу видно,
          // что связь есть и ждёт спецификации, а не что товар вообще не сопоставлен
          costCode: found ? found.code : null,
        };
      }),
      logistics: {
        handed: t.handed,
        postponed: t.postponed,
        postponedMaxDays: t.postponed_max_days,
        postponedAvgDays: t.postponed_avg_days != null ? Number(t.postponed_avg_days) : null,
        avgHours: lead.rows[0]?.avg_hours != null ? Number(lead.rows[0].avg_hours) : null,
        medianHours: lead.rows[0]?.median_hours != null ? Number(lead.rows[0].median_hours) : null,
        byDay: shipDay.rows,
        towns: towns.rows,
        pending: pending.rows.reduce((acc, row) => ({ ...acc, [row.stage]: row.orders }), {}),
      },
      people,
    });
  } catch (error) {
    next(error);
  }
});

// Себестоимость каждого изделия - теми же формулами, что и раздел «Себестоимость»
async function costPerProduct() {
  const { rows: products } = await db.query('SELECT * FROM cost_products');
  const { rows: lines } = await db.query(`
    SELECT pi.product_id, pi.quantity, pi.price, i.kind, i.counts_as
    FROM cost_product_items pi JOIN cost_items i ON i.id = pi.item_id`);

  const byProduct = new Map();
  for (const line of lines) {
    if (!byProduct.has(line.product_id)) byProduct.set(line.product_id, []);
    byProduct.get(line.product_id).push(line);
  }

  // Изделие без спецификации - это заведённый код, до которого технолог ещё не дошёл.
  // Формула на пустой спецификации всё равно вернёт тарифы (упаковка, отправка,
  // накладные - около трёх тысяч), и прибыль вышла бы почти равной выручке. Такой код
  // честнее считать неизвестной себестоимостью, как и полное отсутствие связи.
  return new Map(
    products.map((p) => {
      const lines = byProduct.get(p.id) || [];
      return [p.id, { code: p.code, cost: lines.length > 0 ? calculate(p, lines).cost : null }];
    })
  );
}

// Выработка людей. Таблицы склада и цехов живут в той же базе (см. prisma/schema.prisma
// приложения склада), поэтому читаем их обычным SQL, без второго подключения.
async function peopleStats(from, to) {
  const span = [from, to];
  const almaty = (column) => `((${column} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Almaty')::date)`;

  const [picking, movements, labels, workshops] = await Promise.all([
    db.query(
      `SELECT u.full_name AS name, COUNT(*)::int AS orders
       FROM order_picking op JOIN production_users u ON u.id = op.locked_by
       WHERE op.completed_at IS NOT NULL
         AND ${almaty('op.completed_at')} BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY orders DESC`,
      span
    ),

    db.query(
      `SELECT u.full_name AS name,
              COALESCE(SUM(m.quantity) FILTER (WHERE m.type = 'INBOUND'), 0)::int AS inbound,
              COALESCE(SUM(m.quantity) FILTER (WHERE m.type = 'OUTBOUND'), 0)::int AS outbound
       FROM warehouse_movements m JOIN production_users u ON u.id = m.staff_id
       WHERE ${almaty('m.recorded_at')} BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY outbound DESC, inbound DESC`,
      span
    ),

    db.query(
      `SELECT COALESCE(u.full_name, 'неизвестно') AS name,
              COUNT(*)::int AS batches, COALESCE(SUM(b.units), 0)::int AS units
       FROM label_batches b LEFT JOIN production_users u ON u.id = b.printed_by
       WHERE ${almaty('b.created_at')} BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY units DESC`,
      span
    ),

    db.query(
      `SELECT u.full_name AS name, w.name AS workshop,
              COALESCE(SUM(o.quantity_completed), 0)::int AS done,
              COUNT(*) FILTER (WHERE o.status = 'DEFECTIVE')::int AS defects
       FROM workshop_operations o
       JOIN production_users u ON u.id = o.worker_id
       JOIN workshops w ON w.id = o.workshop_id
       WHERE ${almaty('COALESCE(o.completed_at, o.created_at)')} BETWEEN $1::date AND $2::date
       GROUP BY 1, 2 ORDER BY done DESC`,
      span
    ),
  ]);

  return {
    picking: picking.rows,
    movements: movements.rows,
    labels: labels.rows,
    workshops: workshops.rows,
  };
}

module.exports = router;
