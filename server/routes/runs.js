const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const axios = require('axios');
const db = require('../db/init');
const { refreshStamps } = require('../services/waybillStamps');

// Вывозы, восстановленные по времени формирования накладных.
//
// Зачем отдельно от /api/batches: тот архив знает только пакеты, собранные кнопкой в нашем
// сервисе. Когда накладные печатают в кабинете Kaspi, пакетов не появляется вовсе, и день
// выглядит как одна куча. Штамп внутри PDF (см. services/waybillStamps.js) позволяет
// разложить эту кучу на вывозы задним числом.

// Накладные одного вывоза печатают подряд: наблюдаемый разброс внутри вывоза - минуты
// (13:07-13:22 по одному магазину и 16:52 / 17:17 по двум), между вывозами - часы.
// 45 минут разделяют эти два случая с большим запасом в обе стороны.
const RUN_GAP_MINUTES = 45;

const ALMATY = 'Asia/Almaty';

function almatyParts(date) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: ALMATY,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

/**
 * Раскладывает заказы по вывозам: сортируем по штампу и режем там, где перерыв
 * больше RUN_GAP_MINUTES. Нумеруем внутри дня - на складе говорят «второй рейс»,
 * а не «вывоз с ключом 2026-09-10T11:52Z».
 */
function groupIntoRuns(orders) {
  const sorted = [...orders].sort((a, b) => new Date(a.waybill_made_at) - new Date(b.waybill_made_at));
  const runs = [];

  for (const order of sorted) {
    const madeAt = new Date(order.waybill_made_at);
    const current = runs[runs.length - 1];
    const sameDay = current && almatyParts(new Date(current.lastAt)).date === almatyParts(madeAt).date;
    const closeEnough = current && (madeAt - new Date(current.lastAt)) / 60000 <= RUN_GAP_MINUTES;

    if (current && sameDay && closeEnough) {
      current.lastAt = madeAt.toISOString();
      current.orders.push(order);
    } else {
      runs.push({ firstAt: madeAt.toISOString(), lastAt: madeAt.toISOString(), orders: [order] });
    }
  }

  // Номер внутри дня по времени: первый вывоз дня - №1
  const perDay = new Map();
  return runs.map((run) => {
    const day = almatyParts(new Date(run.firstAt)).date;
    const number = (perDay.get(day) || 0) + 1;
    perDay.set(day, number);

    const byStore = {};
    for (const order of run.orders) byStore[order.store_name] = (byStore[order.store_name] || 0) + 1;

    return {
      // Ключ - день и минута начала: устойчив к пересчёту и годится в URL
      key: `${day}_${almatyParts(new Date(run.firstAt)).time.replace(':', '')}`,
      day,
      number,
      from: almatyParts(new Date(run.firstAt)).time,
      to: almatyParts(new Date(run.lastAt)).time,
      count: run.orders.length,
      stores: byStore,
      orderCodes: run.orders.map((o) => o.order_code)
    };
  });
}

// Без фильтра по статусу - намеренно. Вывоз это история: заказы из него доедут до клиента
// и станут delivered, но состав рейса от этого не меняется. Отсеивать их здесь значило бы,
// что вчерашний рейс за неделю худеет на глазах и архив перестаёт совпадать с тем,
// что реально уехало. Статус экономит обращения к Kaspi только при ЧТЕНИИ штампов
// (см. refreshStamps) - там смысл есть, у доставленного заказа штамп уже не появится.
async function loadStamped(days) {
  const result = await db.query(
    `SELECT o.order_code, o.kaspi_order_id, o.store_id, o.stage, o.ship_date,
            o.waybill_made_at, s.name AS store_name,
            o.raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber' AS waybill_number
     FROM orders o
     JOIN stores s ON s.id = o.store_id
     WHERE o.waybill_made_at IS NOT NULL
       AND o.waybill_made_at >= NOW() - ($1 || ' days')::interval
     ORDER BY o.waybill_made_at`,
    [String(days)]
  );
  return result.rows;
}

// GET /api/runs?days=7 - какие вывозы были и что в них вошло
router.get('/', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
    const orders = await loadStamped(days);
    const runs = groupIntoRuns(orders).reverse(); // свежие сверху

    // Сколько накладных ещё не прочитано - чтобы интерфейс мог честно сказать
    // «показаны не все» и предложить дочитать
    const pending = await db.query(
      `SELECT COUNT(*)::int AS n FROM orders
       WHERE raw_data->'attributes'->'kaspiDelivery'->>'waybill' IS NOT NULL
         AND stage NOT IN ('cancelled', 'delivered', 'completed')
         AND (waybill_made_at IS NULL
              OR waybill_stamped_number IS DISTINCT FROM raw_data->'attributes'->'kaspiDelivery'->>'waybillNumber')`
    );

    res.json({ data: runs, pending: pending.rows[0].n });
  } catch (error) {
    next(error);
  }
});

// POST /api/runs/refresh - дочитать штампы у накладных, которых ещё нет
router.post('/refresh', async (req, res, next) => {
  try {
    const syncService = req.app.locals.syncService;
    if (!syncService) return res.status(503).json({ error: 'Сервис синхронизации не готов' });

    const limit = Math.min(Math.max(Number(req.body?.limit) || 60, 1), 200);
    res.json(await refreshStamps(syncService, { limit }));
  } catch (error) {
    next(error);
  }
});

// GET /api/runs/:key/waybills.zip - архив накладных одного вывоза
router.get('/:key/waybills.zip', async (req, res, next) => {
  try {
    const syncService = req.app.locals.syncService;
    if (!syncService) return res.status(503).json({ error: 'Сервис синхронизации не готов' });

    const orders = await loadStamped(60);
    const run = groupIntoRuns(orders).find((r) => r.key === req.params.key);
    if (!run) return res.status(404).json({ error: 'Вывоз не найден' });

    const rows = orders.filter((o) => run.orderCodes.includes(o.order_code));
    const files = await fetchWaybills(rows, syncService);
    const ready = files.filter((f) => f.pdf);

    if (ready.length === 0) {
      return res.status(404).json({ error: 'Kaspi не отдал ни одной накладной этого вывоза' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="reys_${run.number}_${run.day}.zip"`);

    // PDF уже сжат, паковать повторно незачем
    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('error', (err) => next(err));
    archive.pipe(res);

    for (const file of ready) {
      // По папкам магазинов: на складе пакеты разбирают по магазинам, а не вперемешку
      archive.append(file.pdf, { name: `${file.storeName}/${file.orderCode}_${file.waybillNumber || 'б-н'}.pdf` });
    }

    const missing = files.filter((f) => !f.pdf);
    if (missing.length > 0) {
      const note = ['Накладные не получены по заказам:', '']
        .concat(missing.map((f) => `${f.orderCode} — ${f.reason}`))
        .join('\r\n');
      archive.append(Buffer.from(note, 'utf8'), { name: 'НЕ_ПОЛУЧЕНЫ.txt' });
    }

    await archive.finalize();
  } catch (error) {
    next(error);
  }
});

// Тянем накладные пулом: на каждый заказ это два обращения к Kaspi (свежая ссылка,
// затем сам PDF), последовательно на пару десятков заказов это не уложится в лимит функции.
async function fetchWaybills(orders, syncService) {
  const results = new Array(orders.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < orders.length) {
      const index = cursor++;
      const order = orders[index];
      const base = {
        orderCode: order.order_code,
        storeName: order.store_name,
        waybillNumber: order.waybill_number
      };
      const store = syncService.services[order.store_id];

      if (!store) {
        results[index] = { ...base, pdf: null, reason: 'магазин не настроен' };
        continue;
      }

      try {
        const details = await store.service.getOrderDetails(order.kaspi_order_id);
        const url = details?.attributes?.kaspiDelivery?.waybill;
        if (!url) {
          results[index] = { ...base, pdf: null, reason: 'у Kaspi нет накладной по заказу' };
          continue;
        }

        const pdf = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: { 'X-Auth-Token': store.service.apiToken }
        });
        results[index] = { ...base, pdf: Buffer.from(pdf.data) };
      } catch (error) {
        results[index] = {
          ...base,
          pdf: null,
          reason: error.response?.status ? `Kaspi ответил ${error.response.status}` : error.message
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(6, orders.length) }, worker));
  return results;
}

module.exports = router;
