// Обзорный отчёт из кабинета Kaspi — в таблицу kaspi_card_stats.
//
//   node scripts/load-card-stats.js "путь.xlsm" --store=1            # показать, что будет
//   node scripts/load-card-stats.js "путь.xlsm" --store=1 --apply    # записать
//
// Магазин задаётся ключом: внутри файла его нет, он только в имени, а имя при
// пересылке теряется. 1 - КухниKZ, 2 - ART ROOM HOME (см. таблицу stores).
//
// То же самое умеет кнопка «Загрузить отчёт» в «Аналитике» → «Продажи»: там файл
// разбирает браузер. Скрипт нужен, когда файлов несколько или грузить надо не глядя;
// разбор здесь повторяет браузерный строка в строку, чтобы цифры не разошлись.
//
// Зачем вообще этот отчёт. Из восьми его столбцов шесть у нас уже есть и сходятся
// с заказами до тенге (сверено 15.10.2026: 573 шт / 35 883 445 ₸ у КухниKZ и
// 448 шт / 26 674 385 ₸ у ART ROOM, расхождение ноль). Берут его ради двух
// оставшихся - ПРОСМОТРЫ и ДОЛЯ КАРТОЧКИ, - которых нет ни в API заказов, ни в
// публичном каталоге. Без них «товар не продаётся» неотличимо от «товар ищут, но
// покупают не у нас». Раз в месяц достаточно: обе цифры двигаются медленно.
require('dotenv').config();
const ExcelJS = require('exceljs');
const db = require('../db/init');

const APPLY = process.argv.includes('--apply');
const storeArg = process.argv.find((x) => x.startsWith('--store='));
const FILES = process.argv.slice(2).filter((x) => !x.startsWith('--'));

const m = (v) => Math.round(Number(v) || 0).toLocaleString('ru-RU');
const cell = (row, i) => {
  const v = row.getCell(i).value;
  if (v === null || v === undefined) return null;
  // Формулы и текст со ссылкой exceljs отдаёт объектом
  if (typeof v === 'object') return v.result ?? v.text ?? v.richText?.map((t) => t.text).join('') ?? null;
  return v;
};

// Разбор повторяет onFile() из frontend/app/components/SalesView.js
async function parse(file) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  const ws = book.getWorksheet('Товары') || book.worksheets[0];
  if (!ws) throw new Error('В книге нет ни одного листа');

  // Шапка отчёта - пары «Параметр / Значение» до таблицы, период лежит там
  const meta = {};
  let head = -1;
  ws.eachRow((row, i) => {
    const a = cell(row, 1);
    const b = cell(row, 2);
    if (head < 0 && String(a || '').trim() === 'Товар') head = i;
    if (head < 0 && a && b && !cell(row, 3)) meta[String(a).trim()] = String(b).trim();
  });

  const span = String(meta['Период'] || '').match(/^(\d{2})\.(\d{2})\.(\d{4})\D+(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!span) throw new Error(`Это не похоже на обзорный отчёт Kaspi: не нашёл строку «Период» (нашлось: ${JSON.stringify(meta['Период'])})`);
  if (head < 0) throw new Error('В отчёте нет таблицы товаров');

  const from = `${span[3]}-${span[2]}-${span[1]}`;
  const to = `${span[6]}-${span[5]}-${span[4]}`;

  const rows = [];
  for (let i = head + 1; i <= ws.rowCount; i += 1) {
    const row = ws.getRow(i);
    const cardId = String(cell(row, 1) || '').trim();
    if (!cardId) continue;
    const price = cell(row, 4);
    rows.push({
      cardId,
      name: cell(row, 2),
      category: cell(row, 3),
      // «Нет в наличии» вместо цены означает, что предложения на карточке нет
      price: price === 'Нет в наличии' ? null : Number(price),
      inStock: price !== 'Нет в наличии',
      sold: Number(cell(row, 5)) || 0,
      revenue: Number(cell(row, 6)) || 0,
      clicks: Number(cell(row, 7)) || 0,
      share: cell(row, 8) === null ? null : Number(cell(row, 8)),
    });
  }
  if (rows.length === 0) throw new Error('В отчёте не нашлось ни одного товара');
  return { from, to, rows };
}

(async () => {
  if (FILES.length === 0 || !storeArg) {
    console.log('Нужен файл и магазин: node scripts/load-card-stats.js "отчёт.xlsm" --store=1 [--apply]');
    const { rows } = await db.query('SELECT id, name FROM stores ORDER BY id');
    console.log('Магазины: ' + rows.map((r) => `${r.id} — ${r.name}`).join(', '));
    await db.pool.end();
    return;
  }
  const storeId = Number(storeArg.slice(8));
  const { rows: store } = await db.query('SELECT id, name FROM stores WHERE id = $1', [storeId]);
  if (store.length === 0) throw new Error(`Магазина ${storeId} нет`);

  for (const file of FILES) {
    const { from, to, rows } = await parse(file);
    const sold = rows.reduce((s, r) => s + r.sold, 0);
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const dead = rows.filter((r) => !r.inStock);

    console.log(`\n${file}`);
    console.log(`  магазин ${store[0].name}, период ${from} — ${to}`);
    console.log(`  карточек ${rows.length}, продано ${sold} шт на ${m(revenue)} ₸, просмотров ${m(clicks)}`);
    console.log(`  нет в наличии ${dead.length} карточек, на них ${m(dead.reduce((s, r) => s + r.clicks, 0))} просмотров`);

    // Что уже лежит за этот период — чтобы повторная загрузка не выглядела новой
    const { rows: have } = await db.query(
      `SELECT COUNT(*)::int AS n FROM kaspi_card_stats
       WHERE store_id = $1 AND period_from = $2::date AND period_to = $3::date`,
      [storeId, from, to]
    );
    if (have[0].n > 0) console.log(`  за этот период уже загружено ${have[0].n} строк — будут перезаписаны`);

    if (!APPLY) continue;

    let saved = 0;
    for (const r of rows) {
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
          storeId, r.cardId, from, to,
          String(r.name || '').slice(0, 500) || null,
          String(r.category || '').slice(0, 200) || null,
          r.price === null || Number.isNaN(r.price) ? null : r.price,
          r.inStock, r.sold, r.revenue, r.clicks,
          r.share === null || Number.isNaN(r.share) ? null : r.share,
        ]
      );
      saved += 1;
    }
    console.log(`  записано ${saved}`);
  }

  if (!APPLY) console.log('\nЭто предпросмотр. Записать: добавьте --apply');
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
