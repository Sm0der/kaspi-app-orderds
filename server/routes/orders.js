const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin } = require('../middleware/requireAuth');
const { getOrderStats, getTodaysOrders, getUrgentOrders } = require('../services/orderProcessor');
const { CYRILLIC_FONT_PATH, loadOrdersWithSpaces, renderManifest } = require('../services/orderDocs');

// GET /api/orders/products/suggest - Подсказки товаров для автодополнения поиска
// Источник - каталог products (полный ассортимент), а не только то, что было в заказах
router.get('/products/suggest', async (req, res, next) => {
  try {
    const { q, storeId, limit = 200 } = req.query;
    const params = [];
    const whereClauses = ['1=1'];

    if (storeId) {
      params.push(storeId);
      whereClauses.push(`store_id = $${params.length}`);
    }
    // По словам и через И - как и фильтр заказов, чтобы подсказка не расходилась с поиском
    if (q) {
      for (const word of String(q).trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
        params.push(`%${word}%`);
        whereClauses.push(`name ILIKE $${params.length}`);
      }
    }

    params.push(Math.min(parseInt(limit) || 200, 500));

    const result = await db.query(`
      SELECT DISTINCT name
      FROM products
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY name ASC
      LIMIT $${params.length}
    `, params);

    res.json({ data: result.rows.map(r => r.name) });
  } catch (error) {
    next(error);
  }
});

// PUT /api/orders/products/packing - Задать правило упаковки для SKU:
// сколько мест накладной занимает 1 единица товара.
// Тело запроса: { sku: "108268540", spacesPerUnit: 0.1, storeId?: 1 }
// spacesPerUnit < 1 - мелкий товар, несколько штук в 1 месте (например 0.1 = 10 шт в 1 месте).
// spacesPerUnit >= 1 - крупный/громоздкий товар, 1 шт занимает несколько мест (например 4 = 4 места на 1 шт).
// Если storeId не указан - правило применяется ко всем товарам с этим SKU во всех магазинах.
// Доступно и менеджеру: правило упаковки нужно ему для формирования накладных
// (от него зависит число мест). Под админом остаются только настройки картинок.
router.put('/products/packing', async (req, res, next) => {
  try {
    const { sku, spacesPerUnit, storeId } = req.body;

    if (!sku || !spacesPerUnit || spacesPerUnit <= 0) {
      return res.status(400).json({ error: 'Нужны sku и spacesPerUnit (число > 0)' });
    }

    const params = [spacesPerUnit, sku];
    let where = 'sku = $2';
    if (storeId) {
      params.push(storeId);
      where += ' AND store_id = $3';
    }

    const result = await db.query(
      `UPDATE products SET spaces_per_unit = $1, updated_at = NOW() WHERE ${where} RETURNING id, store_id, sku, name, spaces_per_unit`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Товар с артикулом "${sku}" не найден в каталоге` });
    }

    res.json({ updated: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/products/images/status - сколько товаров в каталоге ещё без картинки
router.get('/products/images/status', requireAdmin, async (req, res, next) => {
  try {
    const { storeId } = req.query;
    const params = [];
    let where = 'image_url IS NULL';
    if (storeId) {
      params.push(storeId);
      where += ` AND store_id = $${params.length}`;
    }

    const result = await db.query(`SELECT COUNT(*)::int AS missing FROM products WHERE ${where}`, params);
    const total = await db.query(
      `SELECT COUNT(*)::int AS total FROM products${storeId ? ' WHERE store_id = $1' : ''}`,
      storeId ? [storeId] : []
    );

    res.json({ missing: result.rows[0].missing, total: total.rows[0].total });
  } catch (error) {
    next(error);
  }
});

// Раньше здесь был POST /products/images/fetch, подбиравший картинки прямо из этого
// сервера. Убран: Kaspi блокирует свой публичный каталог по IP датацентра Vercel (проверено -
// 30 из 30 запросов подряд получили 429 со страницей защиты от ботов, с первой же попытки,
// то есть дело не в конкретных артикулах). Работает только с обычного адреса, поэтому
// пополнение каталога картинками делается вручную, не через кнопку в интерфейсе -
// scripts/fetch-product-images.js.

// Kaspi умеет ответить ошибкой на ASSEMBLE, хотя заказ при этом фактически собрался -
// проверено на живом заказе 1071208448: пришло их внутреннее "Unexpected exception",
// а накладная в кабинете появилась. Записать такой заказ в отказ опасно: он останется
// «несобранным», его попробуют собрать ещё раз, и Kaspi выпустит ВТОРУЮ накладную с новым
// номером - на складе это расходится с тем, что наклеено на коробке.
// Поэтому перед тем как признать отказ, спрашиваем у Kaspi, как оно на самом деле.
// Накладная появляется не мгновенно, отсюда пауза.
async function confirmAssembledInKaspi(service, kaspiOrderId) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  try {
    const data = await service.getOrderDetails(kaspiOrderId);
    const attributes = data?.attributes || {};
    const waybillNumber = attributes.kaspiDelivery?.waybillNumber || null;
    return attributes.assembled === true || Boolean(waybillNumber) ? { waybillNumber } : null;
  } catch {
    return null;
  }
}

// Ошибки Kaspi приходят по-английски и иногда сформулированы так, что человек читает их
// как поломку нашего сервиса. Переводим в то, что с заказом делать дальше.
function readableKaspiError(error) {
  const title = error.response?.data?.errors?.[0]?.title;
  const anyText = `${title || ''} ${error.message || ''} ${JSON.stringify(error.response?.data || '')}`;

  // Внутренний сбой на стороне Kaspi. Он приходит простынёй на пол-экрана - это их
  // Java-исключение, которое их же шлюз не смог разобрать (их MessageDTO не знает поля
  // "description", которое они сами и прислали). Человеку из этого нужен только один
  // факт и один идентификатор: Kaspi просит передать его в поддержку.
  const exceptionId = anyText.match(/"exceptionId"\s*:\s*"([0-9a-f]{8,})"/i)?.[1];
  if (exceptionId) {
    return `Сбой на стороне Kaspi (код для их поддержки: ${exceptionId}). Kaspi может выпустить накладную с опозданием в несколько минут — сначала проверьте заказ в кабинете, и только если он не собран, формируйте`;
  }

  if (!title) return error.message;

  // Заказ существует и читается через GET, но смену статуса Kaspi по нему не принимает.
  // Обходных путей через API нет - только кабинет продавца.
  if (title === 'Order not found') {
    return 'Kaspi не принимает смену статуса по этому заказу — сформируйте его в кабинете Kaspi';
  }
  // "To mark as arrived order, order should be not delivered to city" (шаблон с незаполненным %s).
  // Буквально текст не верить: по штампам PDF такие заказы на момент отказа ещё не были
  // собраны и никуда не уехали - их потом штатно сформировали в кабинете. Что именно Kaspi
  // имеет в виду, не установлено, поэтому человеку пишем только то, что точно известно.
  if (title.startsWith('To mark as arrived order')) {
    return 'Kaspi не разрешил отметить поступление по этому заказу — сформируйте его в кабинете Kaspi';
  }
  if (title.startsWith('The current order status does not allow')) {
    return 'Kaspi не разрешает это действие в текущем статусе заказа (для предзаказа — товар не отмечен поступившим)';
  }
  return title;
}

// Порядок обработки заказов при формировании: срочность, затем ДАТА ПЕРЕДАЧИ КУРЬЕРУ
// (ship_date = kaspiDelivery.courierTransmissionPlanningDate) - та самая, что продавец
// видит в кабинете и которую через API не подвинуть. Дата доставки клиенту
// (delivery_date) идёт на 1-3 дня позже и для отгрузки не годится - остаётся
// последним разделителем, когда даты передачи совпадают или их нет.
const URGENCY_RANK = { overdue: 0, today: 1, soon: 2, upcoming: 3 };
const FAR_FUTURE = new Date(8640000000000000);

function byShippingPriority(a, b) {
  const ra = URGENCY_RANK[a.urgency] ?? 4;
  const rb = URGENCY_RANK[b.urgency] ?? 4;
  if (ra !== rb) return ra - rb;
  const sa = a.ship_date ? new Date(a.ship_date) : FAR_FUTURE;
  const sb = b.ship_date ? new Date(b.ship_date) : FAR_FUTURE;
  if (+sa !== +sb) return sa - sb;
  return new Date(a.delivery_date || 0) - new Date(b.delivery_date || 0);
}

// GET /api/orders/by-sku - Найти все ещё не отправленные заказы с этим SKU,
// отсортированные по приоритету: срочность, затем дата передачи курьеру
router.get('/by-sku', async (req, res, next) => {
  try {
    const { sku, storeId } = req.query;
    if (!sku) {
      return res.status(400).json({ error: 'Нужен параметр sku' });
    }

    const params = [sku];
    let where = 'oi.sku = $1 AND o.stage IN (\'new\', \'accepted\', \'packed\')';
    if (storeId) {
      params.push(storeId);
      where += ` AND o.store_id = $${params.length}`;
    }

    const result = await db.query(`
      SELECT DISTINCT o.order_code, o.stage, o.urgency, o.delivery_date, o.ship_date, o.store_id,
        s.name as store_name,
        oi.quantity as sku_quantity,
        (o.stage = 'packed') AS assembled
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN stores s ON s.id = o.store_id
      WHERE ${where}
    `, params);

    const orders = result.rows.sort(byShippingPriority);

    res.json({ sku, count: orders.length, orders });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/by-name - То же, что by-sku, но по наименованию товара: под один запрос
// («туалетный стол») попадает несколько разных артикулов, и формировать их нужно вместе.
// Слова ищутся по И, каждое как подстрока, поэтому порядок слов не важен: «туалетный стол»
// находит и «Туалетный столик Mebellion», и «Стол туалетный белый».
// Кроме заказов отдаёт разбивку по артикулам с их правилом упаковки - у разных артикулов
// оно разное, а от него зависит число мест в накладной.
router.get('/by-name', async (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim();
    const { storeId } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Нужен параметр name' });
    }

    const words = name.split(/\s+/).filter(Boolean).slice(0, 8);
    const params = [];
    const nameClauses = words.map(word => {
      params.push(`%${word}%`);
      return `oi.name ILIKE $${params.length}`;
    });

    let where = `${nameClauses.join(' AND ')} AND o.stage IN ('new', 'accepted', 'packed')`;
    if (storeId) {
      params.push(storeId);
      where += ` AND o.store_id = $${params.length}`;
    }

    const result = await db.query(`
      SELECT DISTINCT o.order_code, o.stage, o.urgency, o.delivery_date, o.ship_date, o.store_id,
        s.name AS store_name,
        oi.sku, oi.name AS item_name, oi.quantity AS sku_quantity,
        COALESCE(p.spaces_per_unit, 1) AS spaces_per_unit,
        (o.stage = 'packed') AS assembled
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN stores s ON s.id = o.store_id
      LEFT JOIN products p ON p.store_id = o.store_id AND p.sku = oi.sku
      WHERE ${where}
    `, params);

    const orders = result.rows.sort(byShippingPriority);

    // Разбивка по артикулам: что именно нашлось под этим наименованием и с каким правилом
    // упаковки поедет. Один заказ может попасть в несколько строк, если в нём разные товары.
    const byProduct = new Map();
    for (const row of orders) {
      if (!byProduct.has(row.sku)) {
        byProduct.set(row.sku, {
          sku: row.sku,
          name: row.item_name,
          spacesPerUnit: Number(row.spaces_per_unit),
          ordersCount: 0,
          units: 0
        });
      }
      const entry = byProduct.get(row.sku);
      entry.ordersCount += 1;
      entry.units += Number(row.sku_quantity) || 0;
    }

    res.json({
      name,
      count: orders.length,
      orders,
      products: [...byProduct.values()].sort((a, b) => b.units - a.units)
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/orders/allocate-preview - Раскладка заказов под доступное количество товара.
// Вход: { sku, storeId?, quantity }. Продавец вручную указывает, сколько штук готово.
// Логика: берём все несобранные заказы с этим артикулом, сортируем по приоритету
// (срочность -> дата отгрузки -> дата доставки), идём сверху и набираем заказы, пока
// суммарное количество штук не упрётся в quantity. Заказам одной даты не хватило -
// добираем со следующих дат (в выборку попадает то, что помещается по приоритету).
// Дату в Kaspi НЕ меняем - это только отбор.
// Ничего не мутирует, только показывает план.
router.post('/allocate-preview', async (req, res, next) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const quantity = Number(req.body.quantity);
    const storeId = req.body.storeId;

    if (!sku) return res.status(400).json({ error: 'Нужен артикул (sku)' });
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'Количество должно быть целым числом от 1' });
    }

    const params = [sku];
    let where = "oi.sku = $1 AND o.stage IN ('new', 'accepted', 'packed')";
    if (storeId) {
      params.push(storeId);
      where += ` AND o.store_id = $${params.length}`;
    }

    const result = await db.query(`
      SELECT o.order_code, o.stage, o.urgency, o.delivery_date, o.ship_date, o.store_id,
        s.name AS store_name,
        SUM(oi.quantity)::int AS units,
        (o.raw_data->'attributes'->>'preOrder')::boolean AS pre_order,
        (o.stage = 'packed') AS assembled
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN stores s ON s.id = o.store_id
      WHERE ${where}
      GROUP BY o.id, s.id
    `, params);

    const candidates = result.rows.sort(byShippingPriority);

    // Набираем под наличие. Уже собранные (packed) наличие не тратят - их накладная
    // просто переиспользуется при формировании, товар под них уже был отложен раньше.
    let remaining = quantity;
    const selected = [];
    const overflow = [];
    for (const order of candidates) {
      if (order.assembled) { selected.push({ ...order, reused: true }); continue; }
      if (order.units <= remaining) {
        remaining -= order.units;
        selected.push({ ...order, reused: false });
      } else {
        overflow.push(order);
      }
    }

    // Сколько мест выйдет по накладной у каждого отобранного заказа - по тому же правилу
    // упаковки, по которому потом посчитает и формирование. Без этого число мест продавец
    // видел только постфактум, в результатах, когда накладная уже выпущена.
    const withSpaces = await loadOrdersWithSpaces(selected.map(o => o.order_code));
    const spacesByCode = new Map(withSpaces.map(o => [o.order_code, o.numberOfSpace]));
    for (const order of selected) order.numberOfSpace = spacesByCode.get(order.order_code) ?? null;

    const ruleRow = await db.query(
      `SELECT spaces_per_unit FROM products WHERE sku = $1${storeId ? ' AND store_id = $2' : ''} LIMIT 1`,
      storeId ? [sku, storeId] : [sku]
    );

    const selectedNew = selected.filter(o => !o.reused);
    res.json({
      sku,
      quantity,
      allocatedUnits: quantity - remaining,
      remainingUnits: remaining,
      selectedCount: selected.length,
      overflowCount: overflow.length,
      preorderCount: selectedNew.filter(o => o.pre_order).length,
      spacesPerUnit: ruleRow.rows[0] ? Number(ruleRow.rows[0].spaces_per_unit) : null,
      spacesTotal: selected.reduce((sum, o) => sum + (o.numberOfSpace || 0), 0),
      selected,
      overflow
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/manifest?orderCodes=123,456 - Сводный PDF-манифест по списку заказов:
// один файл со всеми заказами (по приоритету срочности), а не набор отдельных документов.
// Это НЕ официальная накладная Kaspi со штрихкодом для курьера (её API не отдаёт, только
// личный кабинет Kaspi по одной) - это внутренняя сводка для сборщика: что, куда и сколько.
// ВАЖНО: этот GET-роут с одним сегментом пути должен быть объявлен ДО GET /:orderId ниже,
// иначе Express примет "manifest" за значение параметра :orderId.
router.get('/manifest', async (req, res, next) => {
  try {
    if (!CYRILLIC_FONT_PATH) {
      return res.status(500).json({
        error: 'Не найден шрифт с поддержкой кириллицы для PDF. Задайте PDF_FONT_PATH в .env (путь к .ttf-файлу).'
      });
    }

    const orderCodes = (req.query.orderCodes || '')
      .split(/[\s,;]+/)
      .map(s => s.trim())
      .filter(Boolean);

    if (orderCodes.length === 0) {
      return res.status(400).json({ error: 'orderCodes должен быть непустым списком' });
    }

    const orders = await loadOrdersWithSpaces(orderCodes);
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Ни один из заказов не найден в базе' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="manifest_${Date.now()}.pdf"`);
    renderManifest(res, orders);
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/assemble-preview?orderCodes=123,456 - Предпросмотр перед формированием:
// порядок обработки, позиции по каждому заказу и рассчитанное количество мест.
// ВАЖНО: этот GET-роут с одним сегментом пути должен быть объявлен ДО GET /:orderId ниже,
// иначе Express примет "assemble-preview" за значение параметра :orderId.
router.get('/assemble-preview', async (req, res, next) => {
  try {
    const orderCodes = (req.query.orderCodes || '')
      .split(/[\s,;]+/)
      .map(s => s.trim())
      .filter(Boolean);

    if (orderCodes.length === 0) {
      return res.status(400).json({ error: 'orderCodes должен быть непустым списком' });
    }

    const orders = await loadOrdersWithSpaces(orderCodes);
    const foundCodes = new Set(orders.map(o => o.order_code));
    const notFound = orderCodes.filter(c => !foundCodes.has(c));

    res.json({
      orders: orders.map(o => ({
        order_code: o.order_code,
        stage: o.stage,
        urgency: o.urgency,
        delivery_date: o.delivery_date,
        // Дата передачи курьеру - по ней и идёт отгрузка, её и показываем
        ship_date: o.ship_date,
        positionsCount: o.positionsCount,
        numberOfSpace: o.numberOfSpace,
        pre_order: o.pre_order || false,
        // Заказ уже собран в одном из прошлых вывозов - при формировании его накладную
        // просто переиспользуют, к Kaspi повторно не обращаются (см. /assemble-batch)
        assembled: o.stage === 'packed',
        items: o.items
      })),
      notFound
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/summary - Получить сводку заказов (все активные + в доставке + недавно завершённые)
router.get('/summary', async (req, res, next) => {
  try {
    const { storeId, product, dateFrom, dateTo, orderDateFrom, orderDateTo } = req.query;

    // Показываем незавершённые заказы (new/accepted/packed/shipping) всегда,
    // а завершённые/отменённые - только за последние 14 дней (глубина синка Kaspi)
    const whereClauses = [
      `(o.stage IN ('new', 'accepted', 'packed', 'shipping') OR o.updated_at >= NOW() - INTERVAL '14 days')`
    ];
    const params = [];

    if (storeId) {
      params.push(storeId);
      whereClauses.push(`o.store_id = $${params.length}`);
    }
    // Фильтр по дню отгрузки - по плановой дате передачи курьеру (ship_date), той самой,
    // что продавец видит в кабинете Kaspi. По дате прибытия к клиенту (delivery_date)
    // за тот же день попадает совсем другой набор заказов: она на 1-3 дня позже.
    if (dateFrom) {
      params.push(dateFrom);
      whereClauses.push(`o.ship_date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      whereClauses.push(`o.ship_date <= $${params.length}`);
    }
    // Фильтр по дате СОЗДАНИЯ заказа в Kaspi (order_date) - отдельно от даты доставки выше.
    // Используется для "новых заказов за сегодня/вчера/месяц".
    if (orderDateFrom) {
      params.push(orderDateFrom);
      whereClauses.push(`o.order_date >= $${params.length}`);
    }
    if (orderDateTo) {
      params.push(orderDateTo);
      whereClauses.push(`o.order_date < $${params.length}::date + INTERVAL '1 day'`);
    }
    // Поиск по товару - по словам, каждое подстрокой и все вместе (И). Простая подстрока
    // целиком спотыкалась о порядок слов: «туалетный стол» не находил «Стол туалетный белый».
    if (product) {
      const words = String(product).trim().split(/\s+/).filter(Boolean).slice(0, 8);
      if (words.length > 0) {
        const clauses = words.map(word => {
          params.push(`%${word}%`);
          return `oi2.name ILIKE $${params.length}`;
        });
        whereClauses.push(`EXISTS (
          SELECT 1 FROM order_items oi2
          WHERE oi2.order_id = o.id AND ${clauses.join(' AND ')}
        )`);
      }
    }

    // Отдаём только нужные колонки, без raw_data: полный JSON заказа весит пару килобайт,
    // на 1300 заказов это лишние мегабайты в каждом ответе дашборду. Нужные из него поля
    // (город, сумма, плановая дата передачи курьеру) достаём здесь же.
    const result = await db.query(`
      SELECT o.id, o.store_id, o.kaspi_order_id, o.order_code, o.status, o.state, o.stage,
        o.delivery_date, o.ship_date, o.order_date, o.urgency, o.crm_status_id, o.updated_at,
        s.name as store_name,
        (o.raw_data->'attributes'->'deliveryAddress'->>'town') AS town,
        (o.raw_data->'attributes'->>'totalPrice')::numeric AS total_price,
        (o.raw_data->'attributes'->'kaspiDelivery'->>'courierTransmissionPlanningDate')::bigint AS shipment_plan_ms,
        -- Момент, когда курьер реально забрал заказ. Пока он пуст, плановая дата - это срок
        -- продавца; как только заполнен, обязанность выполнена и «просрочки» быть не может.
        (o.raw_data->'attributes'->'kaspiDelivery'->>'courierTransmissionDate')::bigint AS shipment_fact_ms,
        (o.raw_data->'attributes'->>'assembled')::boolean AS assembled,
        -- Kaspi отдаёт продавцу только имя и первую букву фамилии покупателя - телефон
        -- в этом ответе всегда замаскирован (+0(000)-000-00-00), реальный видит только
        -- курьер в своём приложении, поэтому его здесь нет и добавлять смысла нет.
        (o.raw_data->'attributes'->'customer'->>'name') AS customer_name,
        (o.raw_data->'attributes'->'customer'->>'lastName') AS customer_last_name,
        COALESCE(
          json_agg(
            json_build_object(
              'name', oi.name, 'quantity', oi.quantity, 'sku', oi.sku,
              'imageUrl', COALESCE(oi.image_url, p.image_url)
            )
            ORDER BY oi.sku ASC
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'
        ) as items
      FROM orders o
      LEFT JOIN stores s ON o.store_id = s.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN products p ON p.store_id = o.store_id AND p.sku = oi.sku
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY o.id, s.id
      ORDER BY
        CASE o.stage
          WHEN 'new' THEN 0 WHEN 'accepted' THEN 1 WHEN 'packed' THEN 2
          WHEN 'shipping' THEN 3 WHEN 'completed' THEN 4 ELSE 5
        END,
        o.urgency ASC, o.ship_date ASC NULLS LAST, o.delivery_date ASC
    `, params);

    const orders = result.rows;

    // Статистика по этапам, по всем и по магазинам
    const storeStats = {};
    let totalStats = {
      total: orders.length,
      today: 0,
      urgent: 0,
      overdue: 0,
      new: 0,
      accepted: 0,
      packed: 0,
      shipping: 0,
      completed: 0,
      cancelled: 0
    };

    orders.forEach(order => {
      const storeName = order.store_name || 'Unknown';
      if (!storeStats[storeName]) {
        storeStats[storeName] = {
          total: 0, today: 0, urgent: 0, overdue: 0,
          new: 0, accepted: 0, packed: 0, shipping: 0, completed: 0, cancelled: 0
        };
      }

      storeStats[storeName].total++;
      if (order.stage) storeStats[storeName][order.stage] = (storeStats[storeName][order.stage] || 0) + 1;
      if (order.urgency === 'today') storeStats[storeName].today++;
      if (order.urgency === 'today' || order.urgency === 'overdue') storeStats[storeName].urgent++;
      if (order.urgency === 'overdue') storeStats[storeName].overdue++;

      if (order.stage) totalStats[order.stage] = (totalStats[order.stage] || 0) + 1;
      if (order.urgency === 'today') totalStats.today++;
      if (order.urgency === 'today' || order.urgency === 'overdue') totalStats.urgent++;
      if (order.urgency === 'overdue') totalStats.overdue++;
    });

    res.json({
      total: totalStats,
      byStore: storeStats,
      orders: orders
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders - Получить список заказов с фильтром
router.get('/', async (req, res, next) => {
  try {
    const { urgency, stage, storeId, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT o.*, s.name as store_name,
        json_agg(json_build_object(
          'id', oi.id,
          'name', oi.name,
          'quantity', oi.quantity,
          'sku', oi.sku,
          'imageUrl', oi.image_url
        ) ORDER BY oi.sku ASC) as items
      FROM orders o
      LEFT JOIN stores s ON o.store_id = s.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE 1=1
    `;
    const params = [];

    if (urgency) {
      params.push(urgency);
      query += ` AND o.urgency = $${params.length}`;
    }

    if (stage) {
      params.push(stage);
      query += ` AND o.stage = $${params.length}`;
    }

    if (storeId) {
      params.push(storeId);
      query += ` AND o.store_id = $${params.length}`;
    }

    query += ` GROUP BY o.id, s.id
              ORDER BY o.urgency ASC, o.delivery_date ASC
              LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    params.push(limit, offset);

    const result = await db.query(query, params);

    res.json({
      data: result.rows,
      count: result.rowCount
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/:orderId - Получить детали заказа
router.get('/:orderId', async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const orderResult = await db.query(
      `SELECT o.*, s.name as store_name
       FROM orders o
       LEFT JOIN stores s ON o.store_id = s.id
       WHERE o.kaspi_order_id = $1`,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    const itemsResult = await db.query(
      `SELECT id, order_id, product_code, sku, name, quantity, image_url, raw_data, created_at
       FROM order_items WHERE order_id = $1
       ORDER BY sku ASC`,
      [order.id]
    );

    res.json({
      ...order,
      items: itemsResult.rows
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/orders/sync - Синхронизировать заказы с Kaspi
router.post('/sync', async (req, res, next) => {
  try {
    const syncService = req.app.locals.syncService;

    if (!syncService) {
      return res.status(500).json({ error: 'Sync service not initialized' });
    }

    console.log('📍 Manual sync requested');
    const results = await syncService.syncAll();

    res.json({
      message: 'Sync completed',
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// Загрузить заказы по номерам вместе с их позициями, отсортировать по приоритету
// срочности и посчитать количество мест по составу заказа. Для каждой позиции
// учитывается правило упаковки её SKU (spaces_per_unit из каталога products) -
// сколько мест накладной занимает 1 единица товара. По умолчанию (если правило
// не задано) - 1 шт = 1 место. Правило работает в обе стороны: дробное значение
// (например 0.1) - несколько мелких штук в одном месте; целое >= 1 (например 4) -

// POST /api/orders/assemble-batch - Сформировать накладные для списка заказов,
// в порядке приоритета по срочности (просрочено -> сегодня -> скоро -> предстоит).
// Количество мест считается автоматически по составу каждого заказа (позиции x количество).
// Тело запроса: { orderCodes: ["1234567", ...] }
router.post('/assemble-batch', async (req, res, next) => {
  try {
    const syncService = req.app.locals.syncService;
    if (!syncService) {
      return res.status(500).json({ error: 'Sync service not initialized' });
    }

    const { orderCodes } = req.body;
    if (!Array.isArray(orderCodes) || orderCodes.length === 0) {
      return res.status(400).json({ error: 'orderCodes должен быть непустым массивом' });
    }

    // Предзаказам Kaspi не даёт формировать накладную, пока товар не отмечен поступившим
    // (ARRIVED). Это заявление о физическом наличии товара, поэтому автоматически его НЕ шлём:
    // только если вызывающий явно передал allowPreorderArrived (в интерфейсе - отдельное
    // подтверждение «товар есть»). Обычное формирование без флага предзаказы пропускает с ошибкой.
    const allowPreorderArrived = req.body.allowPreorderArrived === true;

    const sortedOrders = await loadOrdersWithSpaces(orderCodes);
    const foundCodes = new Set(sortedOrders.map(o => o.order_code));
    const results = [];

    for (const code of orderCodes) {
      if (!foundCodes.has(code)) {
        results.push({ order_code: code, success: false, error: 'Заказ не найден в базе' });
      }
    }

    for (const order of sortedOrders) {
      const storeConfig = syncService.services[order.store_id];
      if (!storeConfig) {
        results.push({ order_code: order.order_code, success: false, error: 'Магазин не настроен' });
        continue;
      }

      if (!['new', 'accepted', 'packed'].includes(order.stage)) {
        results.push({
          order_code: order.order_code,
          success: false,
          error: `Заказ уже в этапе "${order.stage}" - накладная не требуется или уже сформирована`
        });
        continue;
      }

      // Заказ уже собран в одном из прошлых вывозов сегодня (или раньше), но ещё не уехал -
      // например, курьер не забрал его в первый рейс, и его добавили во второй список вместе
      // с новыми заказами. Kaspi не блокирует повторный ASSEMBLE такого заказа (status у него
      // всё ещё ACCEPTED_BY_MERCHANT), поэтому раньше повторный вызов рисковал перевыпустить
      // накладную с новым номером - тот самый дубль, который путает при сборке. Теперь просто
      // переиспользуем то, что Kaspi уже сформировал: заказ входит в этот вывоз (и в его ZIP),
      // но к Kaspi за этим не обращаемся.
      // «Уже собран» определяем не только по нашему stage, но и по накладной в самих данных
      // Kaspi: копия в базе живёт до ближайшего синка, и если заказ за это время сформировали
      // в кабинете, stage у нас ещё 'accepted' - без этой проверки его собрали бы повторно,
      // а повторный ASSEMBLE выпускает накладную с новым номером.
      if (order.stage === 'packed' || order.waybill_number) {
        results.push({
          order_code: order.order_code,
          success: true,
          reused: true,
          urgency: order.urgency,
          positionsCount: order.positionsCount,
          numberOfSpace: order.numberOfSpace
        });
        continue;
      }

      // Последняя проверка перед любым действием - живое состояние заказа у самого Kaspi.
      // Наша копия бывает устаревшей, а Kaspi умеет выпустить накладную спустя минуты после
      // того, как ответил ошибкой (1071208448: ошибка в 17:36:55, накладная в 17:39:02, а
      // соседи по пакету получили свои за 7-13 с). Проверка после ошибки такой случай не
      // ловит - ждать минуты в запросе нельзя. Зато перед повторной отправкой накладная уже
      // видна, и второй ASSEMBLE (он перевыпускает накладную с новым номером) не уйдёт.
      // Если Kaspi не ответил на чтение - не блокируем формирование, работаем как раньше.
      try {
        const live = await storeConfig.service.getOrderDetails(order.kaspi_order_id);
        const liveWaybill = live?.attributes?.kaspiDelivery?.waybillNumber;
        if (live?.attributes?.assembled === true || liveWaybill) {
          results.push({
            order_code: order.order_code,
            success: true,
            reused: true,
            alreadyAssembledInKaspi: true,
            urgency: order.urgency,
            positionsCount: order.positionsCount,
            numberOfSpace: order.numberOfSpace
          });
          continue;
        }
      } catch {
        // чтение не удалось - решает дальнейший поток
      }

      // Объявлено до try: понадобится и в catch, когда будем разбирать ложный отказ
      let arrived = false;

      try {
        // Заказ ещё не принят продавцом - сначала принимаем, потом комплектуем
        if (order.stage === 'new') {
          await storeConfig.service.acceptOrder(order.kaspi_order_id);
        }

        // Предзаказ: Kaspi отклонит ASSEMBLE, пока товар не отмечен поступившим (ARRIVED).
        // Шлём ARRIVED только при явном подтверждении наличия - иначе честно отказываем,
        // чтобы случайно не заявить Kaspi о поступлении того, чего нет (грозит штрафом).
        if (order.pre_order) {
          if (!allowPreorderArrived) {
            results.push({
              order_code: order.order_code,
              success: false,
              preOrder: true,
              error: 'Предзаказ: требуется подтверждение поступления товара (ARRIVED)'
            });
            continue;
          }
          try {
            await storeConfig.service.markArrived(order.kaspi_order_id);
            arrived = true;
          } catch (arrivedError) {
            // Kaspi отвечает 404 "Order not found" на ARRIVED, если поступление по этому
            // предзаказу уже отмечено раньше (в кабинете или прошлой попыткой) - сам заказ
            // при этом жив и читается через GET. Проверено на живых заказах: пять одинаковых
            // предзаказов, у трёх ARRIVED падал с 404, у двух проходил. Поэтому ошибку здесь
            // не считаем фатальной: пробуем ASSEMBLE - если товар и правда не отмечен
            // поступившим, Kaspi откажет уже на нём, со своим понятным статусным текстом.
            if (arrivedError.response?.status !== 404) throw arrivedError;
          }
        }

        await storeConfig.service.assembleOrder(order.kaspi_order_id, order.numberOfSpace);
        results.push({
          order_code: order.order_code,
          success: true,
          reused: false,
          arrived,
          preOrder: order.pre_order || false,
          urgency: order.urgency,
          positionsCount: order.positionsCount,
          numberOfSpace: order.numberOfSpace
        });
      } catch (error) {
        // Ошибка могла быть ложной - Kaspi иногда падает уже после того, как собрал заказ
        const actuallyAssembled = await confirmAssembledInKaspi(storeConfig.service, order.kaspi_order_id);
        if (actuallyAssembled) {
          results.push({
            order_code: order.order_code,
            success: true,
            reused: false,
            arrived,
            preOrder: order.pre_order || false,
            urgency: order.urgency,
            positionsCount: order.positionsCount,
            numberOfSpace: order.numberOfSpace,
            // Kaspi ответил ошибкой, но накладную выпустил - показываем это честно,
            // чтобы человек знал, почему заказ «прошёл со звёздочкой»
            despiteError: readableKaspiError(error)
          });
          continue;
        }

        results.push({
          order_code: order.order_code,
          success: false,
          error: readableKaspiError(error)
        });
      }
    }

    // Kaspi проставляет заказу "собран" не мгновенно: сразу после успешного ASSEMBLE он
    // ещё отдаёт assembled = false, флаг и номер накладной появляются через несколько
    // секунд (проверено на живом заказе). Поэтому сразу тянуть синхронизацию бессмысленно -
    // она запишет прежнее состояние. Вместо этого сами переводим заказы в "собран" и
    // сбрасываем raw_hash, чтобы ближайшая синхронизация обязательно перечитала их из Kaspi
    // и подставила настоящий номер накладной.
    // Переиспользованные (reused) заказы уже в stage 'packed' - трогать их не нужно,
    // обновляем только тех, кого собрали сейчас впервые.
    // Сюда же - заказы, которые наша копия считала несобранными, а Kaspi уже собрал: иначе
    // stage у нас так и останется 'accepted' до следующего синка
    const newlyAssembled = results
      .filter(r => r.success && (!r.reused || r.alreadyAssembledInKaspi))
      .map(r => r.order_code);
    if (newlyAssembled.length > 0) {
      await db.query(
        `UPDATE orders
         SET stage = 'packed', raw_hash = NULL, updated_at = NOW()
         WHERE order_code = ANY($1)`,
        [newlyAssembled]
      );
    }

    // Записываем пакет в архив: по нему потом видно, когда и что формировали, и из него
    // повторно скачиваются документы (см. routes/batches.js). Заказы храним списком кодов -
    // их состав и товары всегда доступны из основной таблицы по коду.
    // wave_number - порядковый номер вывоза за сегодня (по времени Алматы), а не абстрактный
    // id пакета: так на складе легко различить "Вывоз №1" от "Вывоз №2" без путаницы.
    let batchId = null;
    let waveNumber = null;
    if (results.length > 0) {
      const spacesTotal = results.reduce((sum, r) => sum + (Number(r.numberOfSpace) || 0), 0);
      // Номер вывоза считаем и вставляем ОДНИМ запросом (CTE), а не "посчитать, потом
      // вставить": на пуле PgBouncer в transaction-режиме два отдельных обращения могут
      // попасть в разные соединения и не увидеть строк друг друга - проверено, оба
      // одновременных формирования получали одинаковый номер вывоза. pg_advisory_xact_lock
      // на ключ дня сериализует конкурентные вставки за тот же день: вторая ждёт, пока
      // первая закоммитится, и уже тогда пересчитывает COUNT.
      // created_at хранится как timestamp БЕЗ пояса, в UTC (как отдаёт NOW() в этой сессии) -
      // поэтому "местная дата" считается двойной конверсией (сначала пометить как UTC,
      // потом сдвинуть в Алматы). Один AT TIME ZONE 'Asia/Almaty' на уже-голом timestamp
      // делает противоположное - трактует его как алматинское время и сдвигает в UTC,
      // из-за чего дата уезжает почти на сутки (проверено: 04:10 UTC = 09:10 в Алматы,
      // но при одинарной конверсии превращалось в предыдущий день).
      const saved = await db.query(
        `WITH day_lock AS (
           SELECT pg_advisory_xact_lock(hashtext('assembly_wave_' || to_char(NOW() AT TIME ZONE 'Asia/Almaty', 'YYYY-MM-DD')))
         ),
         next_wave AS (
           SELECT COUNT(*) + 1 AS n FROM assembly_batches, day_lock
           WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Almaty')::date
               = (NOW() AT TIME ZONE 'Asia/Almaty')::date
         )
         INSERT INTO assembly_batches (created_by, order_codes, succeeded, failed, spaces_total, results, wave_number)
         SELECT $1, $2, $3, $4, $5, $6, next_wave.n FROM next_wave
         RETURNING id, wave_number`,
        [
          req.user?.email || null,
          results.map(r => r.order_code),
          results.filter(r => r.success).length,
          results.filter(r => !r.success).length,
          spacesTotal,
          JSON.stringify(results)
        ]
      );
      batchId = saved.rows[0].id;
      waveNumber = saved.rows[0].wave_number;
    }

    res.json({
      batchId,
      waveNumber,
      total: orderCodes.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/sync/status - Получить статус последней синхронизации
router.get('/sync/status', async (req, res, next) => {
  try {
    const syncService = req.app.locals.syncService;

    if (!syncService) {
      return res.status(500).json({ error: 'Sync service not initialized' });
    }

    const syncStatus = await syncService.getLastSyncStatus();

    res.json({
      syncs: syncStatus
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
