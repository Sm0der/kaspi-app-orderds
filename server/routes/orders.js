const express = require('express');
const router = express.Router();
const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('../db/init');
const { getOrderStats, getTodaysOrders, getUrgentOrders } = require('../services/orderProcessor');

// Шрифт с поддержкой кириллицы для генерации PDF (встроенные шрифты pdfkit её не знают).
// В репозиторий шрифт не кладём (лицензия Arial), а берём системный - Windows или Linux.
// Если ни один путь не найден - пометим отсутствие, PDF-роут вернёт понятную ошибку.
const CYRILLIC_FONT_CANDIDATES = [
  process.env.PDF_FONT_PATH,
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
].filter(Boolean);
const CYRILLIC_FONT_PATH = CYRILLIC_FONT_CANDIDATES.find(p => {
  try { return fs.existsSync(p); } catch { return false; }
});

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
    if (q) {
      params.push(`%${q}%`);
      whereClauses.push(`name ILIKE $${params.length}`);
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

// GET /api/orders/by-sku - Найти все ещё не отправленные заказы с этим SKU,
// отсортированные по приоритету срочности/дате доставки
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
      SELECT DISTINCT o.order_code, o.stage, o.urgency, o.delivery_date, o.store_id, s.name as store_name,
        oi.quantity as sku_quantity
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN stores s ON s.id = o.store_id
      WHERE ${where}
    `, params);

    const urgencyRank = { overdue: 0, today: 1, soon: 2, upcoming: 3 };
    const orders = result.rows.sort((a, b) => {
      const ra = urgencyRank[a.urgency] ?? 4;
      const rb = urgencyRank[b.urgency] ?? 4;
      if (ra !== rb) return ra - rb;
      return new Date(a.delivery_date || 0) - new Date(b.delivery_date || 0);
    });

    res.json({ sku, count: orders.length, orders });
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

    const totalSpaces = orders.reduce((sum, o) => sum + o.numberOfSpace, 0);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="manifest_${Date.now()}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.registerFont('main', CYRILLIC_FONT_PATH);
    doc.font('main');
    doc.pipe(res);

    doc.fontSize(16).text('Сводный манифест по накладным', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#555')
      .text(`Сформировано: ${new Date().toLocaleString('ru-RU')}`, { align: 'center' })
      .text(`Заказов: ${orders.length}, всего мест: ${totalSpaces}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(1);

    const urgencyLabels = { overdue: 'Просрочено', today: 'Сегодня', soon: 'Скоро', upcoming: 'Предстоит' };

    orders.forEach((order, idx) => {
      if (idx > 0) doc.moveDown(1);

      // Не разрывать блок заказа между страницами, если он не влезает целиком
      const blockHeight = 70 + order.items.length * 16;
      if (doc.y + blockHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }

      const leftX = doc.page.margins.left;
      const rightEdge = doc.page.width - doc.page.margins.right;

      doc.x = leftX;
      doc.fontSize(13).fillColor('#000')
        .text(`Заказ №${order.order_code}${order.store_name ? '  (' + order.store_name + ')' : ''}`, leftX, doc.y, { width: rightEdge - leftX });

      doc.x = leftX;
      doc.fontSize(10).fillColor('#000').text(
        `Срочность: ${urgencyLabels[order.urgency] || order.urgency || '—'}` +
        `   Доставка: ${order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('ru-RU') : '—'}` +
        `   Мест: ${order.numberOfSpace}`,
        leftX, doc.y, { width: rightEdge - leftX }
      );
      doc.moveDown(0.3);

      // Заголовок таблицы позиций (высота строки фиксирована, чтобы колонки не расходились по y)
      const colX = { sku: leftX, name: leftX + 90, qty: leftX + 360, spaces: leftX + 420 };
      const rowHeight = 14;
      let rowY = doc.y;
      doc.fontSize(9).fillColor('#555');
      doc.text('Артикул', colX.sku, rowY, { width: 85, lineBreak: false });
      doc.text('Товар', colX.name, rowY, { width: 265, lineBreak: false });
      doc.text('Кол-во', colX.qty, rowY, { width: 55, lineBreak: false });
      doc.text('Места', colX.spaces, rowY, { width: 55, lineBreak: false });
      doc.fillColor('#000');
      rowY += rowHeight;

      order.items.forEach(item => {
        const qty = Number(item.quantity) || 1;
        const perUnit = Number(item.spacesPerUnit) || 1;
        const itemSpaces = Math.max(Math.ceil(qty * perUnit), 1);
        doc.fontSize(9);
        doc.text(item.sku || '—', colX.sku, rowY, { width: 85, lineBreak: false, ellipsis: true });
        doc.text(item.name || '—', colX.name, rowY, { width: 265, lineBreak: false, ellipsis: true });
        doc.text(String(qty), colX.qty, rowY, { width: 55, lineBreak: false });
        doc.text(String(itemSpaces), colX.spaces, rowY, { width: 55, lineBreak: false });
        rowY += rowHeight;
      });

      doc.x = leftX;
      doc.y = rowY + 6;
      doc.moveTo(leftX, doc.y).lineTo(rightEdge, doc.y).strokeColor('#ccc').stroke();
    });

    doc.end();
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
        positionsCount: o.positionsCount,
        numberOfSpace: o.numberOfSpace,
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
    const { storeId, product, dateFrom, dateTo } = req.query;

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
    if (dateFrom) {
      params.push(dateFrom);
      whereClauses.push(`o.delivery_date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      whereClauses.push(`o.delivery_date <= $${params.length}`);
    }
    if (product) {
      params.push(`%${product}%`);
      whereClauses.push(`EXISTS (
        SELECT 1 FROM order_items oi2
        WHERE oi2.order_id = o.id AND oi2.name ILIKE $${params.length}
      )`);
    }

    const result = await db.query(`
      SELECT o.*, s.name as store_name,
        COALESCE(
          json_agg(
            json_build_object('name', oi.name, 'quantity', oi.quantity, 'sku', oi.sku, 'imageUrl', oi.image_url)
            ORDER BY oi.sku ASC
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'
        ) as items
      FROM orders o
      LEFT JOIN stores s ON o.store_id = s.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY o.id, s.id
      ORDER BY
        CASE o.stage
          WHEN 'new' THEN 0 WHEN 'accepted' THEN 1 WHEN 'packed' THEN 2
          WHEN 'shipping' THEN 3 WHEN 'completed' THEN 4 ELSE 5
        END,
        o.urgency ASC, o.delivery_date ASC
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
// одна крупная штука занимает несколько мест.
async function loadOrdersWithSpaces(orderCodes) {
  const placeholders = orderCodes.map((_, i) => `$${i + 1}`).join(',');
  const found = await db.query(
    `SELECT o.id, o.store_id, o.kaspi_order_id, o.order_code, o.status, o.stage,
            o.urgency, o.delivery_date, s.name as store_name,
            COALESCE(
              json_agg(
                json_build_object(
                  'name', oi.name,
                  'sku', oi.sku,
                  'quantity', oi.quantity,
                  'imageUrl', COALESCE(oi.image_url, p.image_url),
                  'spacesPerUnit', COALESCE(p.spaces_per_unit, 1)
                ) ORDER BY oi.sku ASC
              ) FILTER (WHERE oi.id IS NOT NULL),
              '[]'
            ) as items
     FROM orders o
     LEFT JOIN stores s ON s.id = o.store_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN products p ON p.store_id = o.store_id AND p.sku = oi.sku
     WHERE o.order_code IN (${placeholders})
     GROUP BY o.id, s.id`,
    orderCodes
  );

  const urgencyRank = { overdue: 0, today: 1, soon: 2, upcoming: 3 };
  const orders = found.rows.map(o => {
    const positionsCount = o.items.length;
    // Места считаем по каждой позиции отдельно (ceil(количество * места_на_1шт)),
    // затем суммируем по заказу - так разные товары со своей упаковкой не мешают друг другу
    // (в одном заказе может быть несколько разных товаров с разными правилами упаковки).
    const numberOfSpace = o.items.reduce((sum, i) => {
      const qty = Number(i.quantity) || 1;
      const perUnit = Number(i.spacesPerUnit) || 1;
      return sum + Math.max(Math.ceil(qty * perUnit), 1);
    }, 0);
    return { ...o, positionsCount, numberOfSpace: Math.max(numberOfSpace, 1) };
  });

  orders.sort((a, b) => {
    const ra = urgencyRank[a.urgency] ?? 4;
    const rb = urgencyRank[b.urgency] ?? 4;
    if (ra !== rb) return ra - rb;
    return new Date(a.delivery_date || 0) - new Date(b.delivery_date || 0);
  });

  return orders;
}

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

      try {
        // Заказ ещё не принят продавцом - сначала принимаем, потом комплектуем
        if (order.stage === 'new') {
          await storeConfig.service.acceptOrder(order.kaspi_order_id);
        }
        await storeConfig.service.assembleOrder(order.kaspi_order_id, order.numberOfSpace);
        results.push({
          order_code: order.order_code,
          success: true,
          urgency: order.urgency,
          positionsCount: order.positionsCount,
          numberOfSpace: order.numberOfSpace
        });
      } catch (error) {
        const kaspiError = error.response?.data?.errors?.[0]?.title;
        results.push({ order_code: order.order_code, success: false, error: kaspiError || error.message });
      }
    }

    // Подтянуть новые статусы/накладные из Kaspi после обработки
    const affectedStores = [...new Set(sortedOrders.map(o => o.store_id))];
    for (const storeId of affectedStores) {
      syncService.syncStore(storeId).catch(err => console.error('Post-assemble sync error:', err.message));
    }

    res.json({
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
