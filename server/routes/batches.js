const express = require('express');
const router = express.Router();
// archiver 7, а не 8: восьмая версия ESM-only, и рантайм Vercel её require() не принимает
const archiver = require('archiver');
const axios = require('axios');
const db = require('../db/init');
const { CYRILLIC_FONT_PATH, loadOrdersWithSpaces, renderManifest } = require('../services/orderDocs');

// Архив сформированных пакетов накладных: когда собирали, что вошло, и повторное
// скачивание документов. Пакет записывается при каждом успешном формировании
// (см. POST /api/orders/assemble-batch).

const SORTABLE = {
  date: 'b.created_at',
  orders: 'array_length(b.order_codes, 1)',
  spaces: 'b.spaces_total'
};

// Сколько накладных тянем из Kaspi одновременно при сборке ZIP
const WAYBILL_CONCURRENCY = 6;

// GET /api/batches?sort=date|orders|spaces&dir=asc|desc
router.get('/', async (req, res, next) => {
  try {
    const column = SORTABLE[req.query.sort] || SORTABLE.date;
    const direction = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Number(req.query.limit) || 100, 300);

    const result = await db.query(
      `SELECT b.id, b.created_at, b.created_by, b.order_codes, b.succeeded, b.failed, b.spaces_total,
              array_length(b.order_codes, 1) AS orders_count
       FROM assembly_batches b
       ORDER BY ${column} ${direction} NULLS LAST, b.id ${direction}
       LIMIT $1`,
      [limit]
    );

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/batches/:id - что именно вошло в пакет
router.get('/:id', async (req, res, next) => {
  try {
    const batch = await findBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Пакет не найден' });

    const orders = await loadOrdersWithSpaces(batch.order_codes);
    // Результат по каждому заказу сохраняли в момент формирования - показываем его рядом,
    // иначе непонятно, почему заказ в пакете есть, а накладной у него нет.
    const outcomes = new Map((batch.results || []).map(r => [String(r.order_code), r]));

    res.json({
      data: {
        ...batch,
        orders: orders.map(order => ({
          ...order,
          outcome: outcomes.get(String(order.order_code)) || null
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/batches/:id/manifest.pdf - сводный список по пакету одним документом
router.get('/:id/manifest.pdf', async (req, res, next) => {
  try {
    if (!CYRILLIC_FONT_PATH) {
      return res.status(500).json({
        error: 'Не найден шрифт с поддержкой кириллицы для PDF. Задайте PDF_FONT_PATH в .env (путь к .ttf-файлу).'
      });
    }

    const batch = await findBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Пакет не найден' });

    const orders = await loadOrdersWithSpaces(batch.order_codes);
    if (orders.length === 0) return res.status(404).json({ error: 'Заказы пакета не найдены в базе' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="manifest_${batch.id}.pdf"`);
    renderManifest(res, orders, {
      title: `Сводный манифест — пакет №${batch.id}`,
      createdAt: batch.created_at
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/batches/:id/waybills.zip - архив с накладными Kaspi (по PDF на заказ).
// Ссылку на накладную Kaspi выдаёт одноразовую и недолговечную, поэтому храним не её,
// а перезапрашиваем заказ в момент скачивания и берём свежую.
router.get('/:id/waybills.zip', async (req, res, next) => {
  try {
    const batch = await findBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Пакет не найден' });

    const syncService = req.app.locals.syncService;
    if (!syncService) return res.status(503).json({ error: 'Сервис синхронизации не готов' });

    const rows = await db.query(
      `SELECT order_code, kaspi_order_id, store_id FROM orders WHERE order_code = ANY($1)`,
      [batch.order_codes]
    );
    if (rows.rows.length === 0) return res.status(404).json({ error: 'Заказы пакета не найдены в базе' });

    const files = await fetchWaybills(rows.rows, syncService);
    const ready = files.filter(f => f.pdf);

    if (ready.length === 0) {
      return res.status(404).json({
        error: 'Kaspi не отдал ни одной накладной по этому пакету. Обычно это значит, что заказы ещё не собраны.'
      });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="waybills_${batch.id}.zip"`);

    // PDF уже сжат, паковать повторно незачем - складываем без компрессии
    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('error', err => next(err));
    archive.pipe(res);

    for (const file of ready) {
      archive.append(file.pdf, { name: `${file.orderCode}.pdf` });
    }

    // Если по части заказов накладной не оказалось - кладём рядом заметку, чтобы это
    // не выяснялось уже у коробок
    const missing = files.filter(f => !f.pdf);
    if (missing.length > 0) {
      const note = ['Накладные не получены по заказам:', '']
        .concat(missing.map(f => `${f.orderCode} — ${f.reason}`))
        .join('\r\n');
      archive.append(Buffer.from(note, 'utf8'), { name: 'НЕ_ПОЛУЧЕНЫ.txt' });
    }

    await archive.finalize();
  } catch (error) {
    next(error);
  }
});

async function findBatch(id) {
  if (!/^\d+$/.test(String(id))) return null;
  const result = await db.query(
    `SELECT id, created_at, created_by, order_codes, succeeded, failed, spaces_total, results
     FROM assembly_batches WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Тянем накладные пулом: на каждый заказ это два обращения к Kaspi (свежая ссылка,
// затем сам PDF), последовательно на два десятка заказов это не уложится в лимит функции.
async function fetchWaybills(orders, syncService) {
  const results = new Array(orders.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < orders.length) {
      const index = cursor++;
      const order = orders[index];
      const store = syncService.services[order.store_id];

      if (!store) {
        results[index] = { orderCode: order.order_code, pdf: null, reason: 'магазин не настроен' };
        continue;
      }

      try {
        const details = await store.service.getOrderDetails(order.kaspi_order_id);
        const url = details?.attributes?.kaspiDelivery?.waybill;

        if (!url) {
          results[index] = { orderCode: order.order_code, pdf: null, reason: 'у Kaspi нет накладной по заказу' };
          continue;
        }

        const pdf = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: { 'X-Auth-Token': store.service.apiToken }
        });
        results[index] = { orderCode: order.order_code, pdf: Buffer.from(pdf.data) };
      } catch (error) {
        results[index] = {
          orderCode: order.order_code,
          pdf: null,
          reason: error.response?.status ? `Kaspi ответил ${error.response.status}` : error.message
        };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(WAYBILL_CONCURRENCY, orders.length) }, worker)
  );

  return results;
}

module.exports = router;
