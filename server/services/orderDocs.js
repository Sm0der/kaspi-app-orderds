const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('../db/init');

// Шрифт с поддержкой кириллицы для генерации PDF (встроенные шрифты pdfkit её не знают).
// В репозиторий шрифт не кладём (лицензия Arial), а берём системный - Windows или Linux.
// Если ни один путь не найден - пометим отсутствие, PDF-роуты вернут понятную ошибку.
const CYRILLIC_FONT_CANDIDATES = [
  process.env.PDF_FONT_PATH,
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
].filter(Boolean);

const CYRILLIC_FONT_PATH = CYRILLIC_FONT_CANDIDATES.find(path => {
  try { return fs.existsSync(path); } catch { return false; }
});

const URGENCY_LABELS = { overdue: 'Просрочено', today: 'Сегодня', soon: 'Скоро', upcoming: 'Предстоит' };

// Заказы с рассчитанным количеством мест, отсортированные по срочности - в этом же
// порядке их формируют и печатают, поэтому порядок задан здесь один раз для всех,
// кто показывает или печатает пакет.
async function loadOrdersWithSpaces(orderCodes) {
  if (orderCodes.length === 0) return [];

  const placeholders = orderCodes.map((_, i) => `$${i + 1}`).join(',');
  const found = await db.query(
    `SELECT o.id, o.store_id, o.kaspi_order_id, o.order_code, o.status, o.stage,
            o.urgency, o.delivery_date, o.ship_date, s.name as store_name,
            (o.raw_data->'attributes'->'deliveryAddress'->>'town') AS town,
            (o.raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber') AS waybill_number,
            (o.raw_data->'attributes'->>'assembled')::boolean AS assembled,
            -- Предзаказ: у него формирование накладной требует отдельного шага ARRIVED
            (o.raw_data->'attributes'->>'preOrder')::boolean AS pre_order,
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

// Сводный манифест: один документ на весь пакет со всеми заказами и их составом.
// Это НЕ официальная накладная Kaspi со штрихкодом - это внутренняя сводка для сборщика:
// что, куда и сколько. Пишет прямо в поток ответа, чтобы не держать PDF в памяти целиком.
function renderManifest(stream, orders, { title = 'Сводный манифест по накладным', createdAt } = {}) {
  const totalSpaces = orders.reduce((sum, o) => sum + o.numberOfSpace, 0);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.registerFont('main', CYRILLIC_FONT_PATH);
  doc.font('main');
  doc.pipe(stream);

  doc.fontSize(16).text(title, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#555')
    .text(`Сформировано: ${new Date(createdAt || Date.now()).toLocaleString('ru-RU')}`, { align: 'center' })
    .text(`Заказов: ${orders.length}, всего мест: ${totalSpaces}`, { align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(1);

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
      `Срочность: ${URGENCY_LABELS[order.urgency] || order.urgency || '—'}` +
      `   Доставка: ${order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('ru-RU') : '—'}` +
      `   Мест: ${order.numberOfSpace}` +
      (order.town ? `   Город: ${order.town}` : ''),
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
}

module.exports = { CYRILLIC_FONT_PATH, URGENCY_LABELS, loadOrdersWithSpaces, renderManifest };
