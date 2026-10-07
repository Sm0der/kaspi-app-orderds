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
                COALESCE(SUM(total_price) FILTER (WHERE NOT cancelled), 0)::numeric AS revenue,
                -- Иначе в хвосте списка стоят города с нулём и непонятно, откуда они
                -- взялись: это места, куда заказывали, но всё отменили.
                COUNT(*) FILTER (WHERE cancelled)::int AS cancelled
         -- Без LIMIT: городов за два года 296, это десяток килобайт, зато владелец
         -- видит весь список, а не «прочие». Обрезать до интересного - дело экрана.
         FROM scope GROUP BY 1 ORDER BY orders DESC`,
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

// GET /api/analytics/sales - подробно про продажи: категории, каждая позиция,
// кандидаты на снятие и наше место на общих карточках Kaspi.
//
// Отдельно от /overview намеренно. Там восемь проходов по таблице заказов ради денег и
// логистики, и за два года это одиннадцать секунд; здесь свои тяжёлые проходы по
// позициям заказов. Сложив их в один ответ, мы бы заставили владельца ждать оба набора
// цифр, даже когда ему нужен один.
router.get('/sales', async (req, res, next) => {
  try {
    const { from, to, store } = parseRange(req);
    const args = [from, to, store];

    // Предыдущий период такой же длины - чтобы к каждой строке можно было дописать
    // «растёт» или «падает». Без сравнения таблица отвечает «сколько», но не «куда».
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const shift = (day, by) => new Date(Date.parse(day) - by * 86400000).toISOString().slice(0, 10);
    const prevArgs = [shift(from, days), shift(from, 1), store];

    const [categories, prevCategories, items, prevItems, ranks, costs, cardStats] = await Promise.all([
      categoryRows(args),
      categoryRows(prevArgs),
      itemRows(args),
      prevItemRows(prevArgs),
      db.query(
        `SELECT r.store_id, r.sku, r.card_id, r.place, r.offers_total,
                r.our_price, r.best_price, r.best_seller, r.checked_at
         FROM product_card_ranks r
         WHERE ($1::int IS NULL OR r.store_id = $1)`,
        [store]
      ),
      costPerProduct(),
      // Берём оба магазина даже при фильтре по одному: карточку они делят между собой,
      // и доля «сколько досталось нам» складывается из двух строк.
      latestCardStats(null),
    ]);

    const prevCat = new Map(prevCategories.rows.map((r) => [r.category, Number(r.revenue)]));
    const prevQty = new Map(prevItems.rows.map((r) => [`${r.store_id}:${r.sku}`, r.qty]));
    const rankBySku = new Map(ranks.rows.map((r) => [`${r.store_id}:${r.sku}`, r]));

    // Те же продажи, но сложенные по карточке Kaspi, а не по артикулу магазина.
    // Нужно для переездов: позиция уходит в соседний магазин под новым артикулом,
    // и сравнение по артикулу показывает «новое» там и обвал здесь, хотя продажи
    // просто перетекли. Карточка у них общая, и по ней видно, что было на самом деле.
    const sumByCard = (rows) => {
      const out = new Map();
      for (const r of rows) {
        if (!r.card_id) continue;
        out.set(r.card_id, (out.get(r.card_id) || 0) + r.qty);
      }
      return out;
    };
    const prevByCard = sumByCard(prevItems.rows);
    const nowByCard = sumByCard(items.rows);

    // Клики и доля в карточке - из отчёта кабинета, по номеру карточки и магазину
    const statsByCard = new Map(cardStats.map((r) => [`${r.store_id}:${r.card_id}`, r]));
    const statsPeriod = cardStats.length
      ? { from: cardStats[0].period_from, to: cardStats[0].period_to }
      : null;

    // Доля карточки, сложенная по нашим магазинам. Kaspi считает её на магазин, а мы
    // на одной карточке стоим дважды: у Aisha Pro 1103 это 11% у КухниKZ и 26% у
    // ART ROOM - по отдельности каждая выглядит провалом, вместе это 37% и бестселлер.
    // Судить «покупают у других» можно только по сумме.
    const ourShareByCard = new Map();
    for (const r of cardStats) {
      if (r.card_share === null) continue;
      ourShareByCard.set(r.card_id, (ourShareByCard.get(r.card_id) || 0) + Number(r.card_share));
    }

    const totalRevenue = categories.rows.reduce((sum, r) => sum + Number(r.revenue), 0);

    const categoryList = categories.rows.map((r) => {
      const was = prevCat.get(r.category) ?? null;
      return {
        category: r.category,
        orders: r.orders,
        qty: r.qty,
        revenue: Number(r.revenue),
        share: totalRevenue > 0 ? Math.round((Number(r.revenue) / totalRevenue) * 1000) / 10 : 0,
        avgPrice: r.qty > 0 ? Math.round(Number(r.revenue) / r.qty) : 0,
        cancelledQty: r.cancelled_qty,
        cancelShare: r.qty + r.cancelled_qty > 0
          ? Math.round((r.cancelled_qty / (r.qty + r.cancelled_qty)) * 1000) / 10
          : 0,
        positions: r.positions,
        // null - в прошлом периоде категории не было вовсе: это не «рост на бесконечность»,
        // а «появилась», и интерфейс должен сказать именно так.
        prevRevenue: was,
        change: was && was > 0 ? Math.round(((Number(r.revenue) - was) / was) * 1000) / 10 : null,
      };
    });

    const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    const productList = items.rows.map((r) => {
      const key = `${r.store_id}:${r.sku}`;
      const found = r.cost_product_id ? costs.get(r.cost_product_id) : null;
      const unitCost = found && found.cost !== null ? found.cost : null;
      const revenue = Number(r.revenue);
      const rank = rankBySku.get(key) || null;
      const wasQty = prevQty.get(key) ?? 0;
      const touched = r.qty + r.cancelled_qty;

      // Под этим артикулом в прошлом периоде не продавали, а карточка продавалась -
      // значит позиция переехала. Тогда честнее сравнить по карточке и сказать об этом,
      // чем подписать бестселлер словом «новое».
      const wasCard = r.card_id ? prevByCard.get(r.card_id) ?? 0 : 0;
      const nowCard = r.card_id ? nowByCard.get(r.card_id) ?? 0 : 0;
      const moved = wasQty === 0 && wasCard > 0;
      const changeFrom = moved ? wasCard : wasQty;
      const changeTo = moved ? nowCard : r.qty;

      return {
        storeId: r.store_id,
        storeName: r.store_name,
        sku: r.sku,
        name: r.name,
        category: r.category,
        qty: r.qty,
        revenue,
        avgPrice: r.qty > 0 ? Math.round(revenue / r.qty) : 0,
        // Маржа - только по связанным с «Себестоимостью». Без связи прочерк честнее,
        // чем выручка, выданная за прибыль.
        cost: unitCost !== null ? Math.round(unitCost * r.qty) : null,
        profit: unitCost !== null ? Math.round(revenue - unitCost * r.qty) : null,
        margin: unitCost !== null && revenue > 0
          ? Math.round(((revenue - unitCost * r.qty) / revenue) * 1000) / 10
          : null,
        costCode: found ? found.code : null,
        cancelledQty: r.cancelled_qty,
        cancelShare: touched > 0 ? Math.round((r.cancelled_qty / touched) * 1000) / 10 : 0,
        lastSold: r.last_sold,
        daysSinceSale: r.last_sold
          ? Math.round((Date.parse(today) - Date.parse(r.last_sold)) / 86400000)
          : null,
        prevQty: wasQty,
        qtyChange: changeFrom > 0 ? Math.round(((changeTo - changeFrom) / changeFrom) * 1000) / 10 : null,
        // Сравнение сделано по карточке, а не по артикулу - интерфейс это подписывает
        movedBetweenStores: moved,
        traffic: (() => {
          const st = r.card_id ? statsByCard.get(`${r.store_id}:${r.card_id}`) : null;
          if (!st) return null;
          return {
            clicks: st.clicks,
            sold: st.sold,
            // Сколько из ста заглянувших купили. Доля процента - обычное дело,
            // поэтому два знака: округление до целых всё превратило бы в нули.
            conversion: st.clicks > 0 ? Math.round((st.sold / st.clicks) * 10000) / 100 : null,
            cardShare: st.card_share === null ? null : Number(st.card_share),
            // Та же доля, но по двум магазинам вместе - интерфейс показывает её рядом,
            // когда она отличается от доли этого магазина.
            ourShare: ourShareByCard.has(st.card_id)
              ? Math.round(ourShareByCard.get(st.card_id) * 100) / 100
              : null,
            inStock: st.in_stock,
            from: st.period_from,
            to: st.period_to,
          };
        })(),
        card: rank && {
          cardId: rank.card_id,
          place: rank.place,
          offersTotal: rank.offers_total,
          ourPrice: rank.our_price !== null ? Number(rank.our_price) : null,
          bestPrice: rank.best_price !== null ? Number(rank.best_price) : null,
          bestSeller: rank.best_seller,
          // Насколько мы дороже самого дешёвого чужого предложения
          gap: rank.our_price !== null && rank.best_price !== null
            ? Math.round(Number(rank.our_price) - Number(rank.best_price))
            : null,
          checkedAt: rank.checked_at,
        },
      };
    });

    res.json({
      range: { from, to, store, days },
      previous: { from: prevArgs[0], to: prevArgs[1] },
      revenue: totalRevenue,
      categories: categoryList,
      products: productList,
      drop: dropCandidates(productList, days),
      trafficPeriod: statsPeriod,
      ranksCheckedAt: ranks.rows.reduce(
        (latest, r) => (!latest || r.checked_at > latest ? r.checked_at : latest), null
      ),
    });
  } catch (error) {
    next(error);
  }
});

// Категория приходит в самой позиции заказа (attributes.category.title) - это та же
// категория, по которой покупатель ищет на Kaspi. В products колонка category пустая,
// поэтому берём из заказа: покрытие 100%, и оно историческое, а не на сегодня.
const ITEM_CATEGORY = "oi.raw_data->'attributes'->'category'->>'title'";
const ITEM_PRICE = "(oi.raw_data->'attributes'->>'totalPrice')::numeric";
// Номер общей карточки Kaspi. Он один и тот же, когда позиция переезжает между нашими
// магазинами или её пересоздают под новым артикулом - а это происходит регулярно.
// Без него сравнение с прошлым периодом врёт: бестселлер, уехавший из одного магазина
// в другой, в одном показывался как «новое», а в другом как падение на 83%.
const ITEM_CARD =
  "convert_from(decode(oi.raw_data->'relationships'->'product'->'data'->>'id', 'base64'), 'UTF8')";

function categoryRows([from, to, store]) {
  return db.query(
    `WITH ${SCOPE}
     SELECT COALESCE(${ITEM_CATEGORY}, 'без категории') AS category,
            COUNT(DISTINCT scope.id) FILTER (WHERE NOT scope.cancelled)::int AS orders,
            COALESCE(SUM(oi.quantity) FILTER (WHERE NOT scope.cancelled), 0)::int AS qty,
            COALESCE(SUM(${ITEM_PRICE}) FILTER (WHERE NOT scope.cancelled), 0)::numeric AS revenue,
            COALESCE(SUM(oi.quantity) FILTER (WHERE scope.cancelled), 0)::int AS cancelled_qty,
            COUNT(DISTINCT oi.sku)::int AS positions
     FROM scope JOIN order_items oi ON oi.order_id = scope.id
     GROUP BY 1 ORDER BY revenue DESC`,
    [from, to, store]
  );
}

// Все позиции периода, а не топ-25: вопрос «что снять с продажи» живёт как раз в хвосте
// списка, и обрезание сверху отвечает ровно на другой вопрос.
function itemRows([from, to, store]) {
  return db.query(
    `WITH ${SCOPE}
     SELECT scope.store_id, oi.sku,
            (ARRAY_AGG(oi.name ORDER BY scope.created_day DESC))[1] AS name,
            MAX(${ITEM_CARD}) AS card_id,
            COALESCE(MAX(${ITEM_CATEGORY}), 'без категории') AS category,
            COALESCE(SUM(oi.quantity) FILTER (WHERE NOT scope.cancelled), 0)::int AS qty,
            COALESCE(SUM(${ITEM_PRICE}) FILTER (WHERE NOT scope.cancelled), 0)::numeric AS revenue,
            COALESCE(SUM(oi.quantity) FILTER (WHERE scope.cancelled), 0)::int AS cancelled_qty,
            MAX(scope.created_day) FILTER (WHERE NOT scope.cancelled)::text AS last_sold,
            MAX(p.cost_product_id) AS cost_product_id,
            MAX(s.name) AS store_name
     FROM scope
     JOIN order_items oi ON oi.order_id = scope.id
     JOIN stores s ON s.id = scope.store_id
     LEFT JOIN products p ON p.sku = oi.sku AND p.store_id = scope.store_id
     GROUP BY scope.store_id, oi.sku
     ORDER BY revenue DESC`,
    [from, to, store]
  );
}

// Для прошлого периода нужны только количества - сравнивать выручку по позиции
// бессмысленно, цена за это время могла поменяться.
function prevItemRows([from, to, store]) {
  return db.query(
    `WITH ${SCOPE}
     SELECT scope.store_id, oi.sku, MAX(${ITEM_CARD}) AS card_id,
            COALESCE(SUM(oi.quantity) FILTER (WHERE NOT scope.cancelled), 0)::int AS qty
     FROM scope JOIN order_items oi ON oi.order_id = scope.id
     GROUP BY scope.store_id, oi.sku`,
    [from, to, store]
  );
}

/**
 * Кандидаты на снятие с продажи. Не приговор, а повод посмотреть: решение за владельцем,
 * поэтому у каждой строки написана причина, а не просто флаг.
 *
 * Правила намеренно простые и объяснимые:
 *  - торгуем в убыток - себестоимость выше цены, это не обсуждается;
 *  - заказы массово отменяют - значит товара нет или он не тот, что на карточке;
 *  - давно не продавалось, хотя предложение на Kaspi висит;
 *  - наценка меньше десятой доли при живых продажах - работаем за склад.
 * Товары без связи с «Себестоимостью» по марже не судим: там не ноль, там неизвестно.
 */
// 1 день, 2 дня, 5 дней - иначе в причинах стоит «51 дней»
function plural(n, one, few, many) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function dropCandidates(products, days) {
  const quiet = Math.max(30, Math.round(days / 2));
  const out = [];

  for (const p of products) {
    const reasons = [];
    if (p.profit !== null && p.profit < 0) {
      reasons.push(`продаём в минус: ${Math.abs(p.profit).toLocaleString('ru-RU')} ₸ за период`);
    } else if (p.margin !== null && p.margin < 10 && p.qty > 0) {
      reasons.push(`наценка ${String(p.margin).replace('.', ',')}% — работаем почти даром`);
    }
    if (p.cancelledQty >= 3 && p.cancelShare >= 40) {
      reasons.push(`отменяют ${p.cancelShare}% заказов (${p.cancelledQty} шт)`);
    }
    if (p.daysSinceSale !== null && p.daysSinceSale >= quiet) {
      reasons.push(`не продавалось ${p.daysSinceSale} ${plural(p.daysSinceSale, 'день', 'дня', 'дней')}`);
    }
    // Трафик из отчёта кабинета. Он отвечает на вопрос, который по заказам не задать:
    // товар не берут, потому что он не нужен, или потому что покупают не у нас.
    if (p.traffic) {
      const t = p.traffic;
      if (t.clicks >= 1000 && t.sold === 0) {
        reasons.push(
          `${t.clicks.toLocaleString('ru-RU')} ${plural(t.clicks, 'просмотр', 'просмотра', 'просмотров')}` +
          ' на карточке и ни одной продажи' + (t.inStock ? '' : ' — нашего предложения там нет')
        );
      } else if (t.clicks >= 20000 && t.ourShare !== null && t.ourShare < 20) {
        reasons.push(
          `${t.clicks.toLocaleString('ru-RU')} ${plural(t.clicks, 'просмотр', 'просмотра', 'просмотров')}, ` +
          `а досталось нам ${String(t.ourShare).replace('.', ',')}% карточки — покупают у других`
        );
      }
    }

    // Нашего предложения на карточке нет - оно уже снято или кончился остаток.
    // Это не повод снимать, это повод знать: товар не продаётся, потому что его не видно.
    if (p.card && p.card.place === null) {
      reasons.push(`на карточке нас нет — снято или нет остатка (${p.card.offersTotal} чужих предложений)`);
    } else if (p.card && p.card.place > 10 && p.card.gap > 0) {
      reasons.push(`${p.card.place}-е место из ${p.card.offersTotal}, дороже рынка на ${p.card.gap.toLocaleString('ru-RU')} ₸`);
    }

    if (reasons.length > 0) out.push({ ...p, reasons });
  }

  // Сверху те, где на кону больше денег: убыток важнее тишины на складе, а между
  // прочими равными вперёд идёт тот, у кого больше потерянного трафика - сто тысяч
  // просмотров мимо кассы дороже, чем позиция, которую никто и не искал.
  return out.sort((a, b) => {
    const loss = (x) => (x.profit !== null && x.profit < 0 ? -x.profit : 0);
    const missed = (x) => (x.traffic ? x.traffic.clicks : 0);
    return loss(b) - loss(a) || b.reasons.length - a.reasons.length
      || missed(b) - missed(a) || b.revenue - a.revenue;
  });
}

// GET /api/analytics/card-stats - какие отчёты из кабинета уже загружены
router.get('/card-stats', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.store_id, st.name AS store_name,
              c.period_from::text AS period_from, c.period_to::text AS period_to,
              COUNT(*)::int AS cards, SUM(c.clicks)::bigint AS clicks,
              SUM(c.sold)::int AS sold, MAX(c.loaded_at) AS loaded_at
       FROM kaspi_card_stats c
       JOIN stores st ON st.id = c.store_id
       JOIN (SELECT DISTINCT store_id FROM kaspi_card_stats) s ON s.store_id = c.store_id
       GROUP BY 1, 2, 3, 4
       ORDER BY period_to DESC, store_name`
    );
    res.json({ data: rows.map((r) => ({ ...r, clicks: Number(r.clicks) })) });
  } catch (error) {
    next(error);
  }
});

// POST /api/analytics/card-stats - принять разобранный отчёт
//
// Файл разбирает браузер (xlsx там уже есть ради «Денег»), сюда приходят готовые строки.
// Магазин присылается отдельно: внутри отчёта его нет - он есть только в имени файла,
// а имя при пересылке теряется.
router.post('/card-stats', async (req, res, next) => {
  try {
    const storeId = Number(req.body?.storeId);
    const from = String(req.body?.from || '');
    const to = String(req.body?.to || '');
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!Number.isInteger(storeId) || storeId <= 0) {
      return res.status(400).json({ error: 'Не указан магазин' });
    }
    if (!isDay(from) || !isDay(to)) {
      return res.status(400).json({ error: 'В отчёте не нашёлся период' });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: 'В отчёте нет ни одной строки с товаром' });
    }

    const store = await db.query('SELECT id FROM stores WHERE id = $1', [storeId]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Такого магазина нет' });

    let saved = 0;
    let skipped = 0;
    for (const row of rows) {
      const cardId = String(row.cardId || '').trim();
      if (!cardId) { skipped++; continue; }
      await db.query(
        `INSERT INTO kaspi_card_stats
           (store_id, card_id, period_from, period_to, name, category,
            price, in_stock, sold, revenue, clicks, card_share, loaded_at)
         VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (store_id, card_id, period_from, period_to) DO UPDATE SET
           name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price,
           in_stock = EXCLUDED.in_stock, sold = EXCLUDED.sold, revenue = EXCLUDED.revenue,
           clicks = EXCLUDED.clicks, card_share = EXCLUDED.card_share, loaded_at = NOW()`,
        [
          storeId, cardId, from, to,
          String(row.name || '').slice(0, 500) || null,
          String(row.category || '').slice(0, 200) || null,
          row.price === null || row.price === undefined ? null : Number(row.price),
          row.inStock !== false,
          Number(row.sold) || 0,
          Number(row.revenue) || 0,
          Number(row.clicks) || 0,
          row.share === null || row.share === undefined ? null : Number(row.share),
        ]
      );
      saved++;
    }

    res.json({ saved, skipped, from, to });
  } catch (error) {
    next(error);
  }
});

// Последний загруженный отчёт по каждому магазину. Именно последний, а не за период
// аналитики: отчёт берут за свой отрезок, и подгонять его под выбранный период нельзя -
// получилось бы, что цифры то появляются, то исчезают в зависимости от календаря.
// Поэтому интерфейс пишет рядом, за какой период эти клики.
async function latestCardStats(store) {
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT store_id, MAX(period_to) AS period_to
       FROM kaspi_card_stats
       WHERE ($1::int IS NULL OR store_id = $1)
       GROUP BY store_id
     )
     SELECT c.store_id, c.card_id, c.sold, c.revenue, c.clicks, c.card_share,
            c.in_stock, c.period_from::text AS period_from, c.period_to::text AS period_to
     FROM kaspi_card_stats c
     JOIN latest l ON l.store_id = c.store_id AND l.period_to = c.period_to`,
    [store]
  );
  return rows;
}

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
