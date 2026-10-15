// Еженедельный отчёт в Excel: только таблицы, без пояснений.
//
// Страница отчёта объясняет каждую цифру, и это правильно для чтения. В книге Excel
// пояснения мешают: с ними нельзя ни отсортировать, ни сложить, ни построить свою
// сводную. Поэтому здесь ровно шапка и данные — ни абзацев, ни заметок, ни списка
// «что с этим делать».
//
// Деньги лежат ЧИСЛАМИ, а не строками «15 312 510 ₸»: единица вынесена в заголовок
// столбца, формат отдан Excel. Иначе сумма по столбцу не считается, а сортировка идёт
// по алфавиту, и отчёт превращается в картинку.
const ExcelJS = require('exceljs');
const { human, num, pct } = require('./weekly-report');

const MONEY = '# ##0';
const MONEY2 = '# ##0.00';
const PERCENT = '0.0"%"';

// Один стиль на всю книгу: шапка, ширины, заморозка первой строки, автофильтр.
// Руками это по десятку листов не расставляют.
function sheet(book, title, columns, rows) {
  const ws = book.addWorksheet(title, {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || Math.max(12, Math.min(44, c.header.length + 4)),
    style: c.format ? { numFmt: c.format } : undefined,
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(1).height = 28;
  for (const r of rows) ws.addRow(r);
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return ws;
}

// Итоговая строка снизу — жирная, с суммой по числовым столбцам.
function totalRow(ws, label, sums) {
  const row = ws.addRow(sums);
  row.getCell(1).value = label;
  row.font = { bold: true };
  row.border = { top: { style: 'thin' } };
  return row;
}

function build(d) {
  const book = new ExcelJS.Workbook();
  book.creator = 'ARTROOM/OPS';
  book.created = new Date();
  book.title = `Неделя ${d.from} — ${d.to}`;

  const a = d.now.all;
  const p = d.prev.all;
  const y = d.year.all;
  const f = d.four.all;
  const M = d.money;

  // ── Сводка ──────────────────────────────────────────────────────────────────
  // Четыре базы сравнения в столбцах: неделя, прошлая, среднее за четыре, год назад.
  sheet(book, 'Сводка', [
    { header: 'Показатель', key: 'k', width: 34 },
    { header: 'Неделя', key: 'now', width: 16, format: MONEY },
    { header: 'Прошлая неделя', key: 'prev', width: 16, format: MONEY },
    { header: 'Среднее за 4 недели', key: 'four', width: 18, format: MONEY },
    { header: 'Та же неделя год назад', key: 'year', width: 18, format: MONEY },
  ], [
    { k: 'Выручка, ₸', now: a.revenue, prev: p.revenue, four: f.revenue / 4, year: y.revenue },
    { k: 'Заказов', now: a.orders, prev: p.orders, four: f.orders / 4, year: y.orders },
    { k: 'Средний чек, ₸', now: a.avg, prev: p.avg, four: f.avg, year: y.avg },
    { k: 'Отмен, шт', now: a.cancelled, prev: p.cancelled, four: f.cancelled / 4, year: y.cancelled },
    { k: 'Отменено на сумму, ₸', now: a.cancelled_sum, prev: p.cancelled_sum, four: f.cancelled_sum / 4, year: y.cancelled_sum },
    { k: 'Возвратов, шт', now: a.returned, prev: p.returned, four: f.returned / 4, year: y.returned },
    { k: 'Заказов из наличия', now: a.in_stock, prev: p.in_stock, four: f.in_stock / 4, year: y.in_stock },
    { k: 'В рассрочку, шт', now: a.credit, prev: p.credit, four: f.credit / 4, year: y.credit },
    { k: 'В рассрочку, ₸', now: a.credit_sum, prev: p.credit_sum, four: f.credit_sum / 4, year: y.credit_sum },
    { k: 'Доставка по факту, ₸', now: M.ship, prev: d.moneyPrev.ship, four: null, year: null },
    { k: 'Комиссия Kaspi 11,75%, ₸', now: M.commission, prev: d.moneyPrev.commission, four: null, year: null },
    { k: 'Себестоимость, ₸', now: M.cost, prev: d.moneyPrev.cost, four: null, year: null },
    { k: 'Остаётся, ₸', now: M.net, prev: d.moneyPrev.net, four: null, year: null },
    { k: 'Остаётся от посчитанной выручки, %', now: M.netRate, prev: d.moneyPrev.netRate, four: null, year: null },
    { k: 'Выручка с известной себестоимостью, ₸', now: M.knownRevenue, prev: d.moneyPrev.knownRevenue, four: null, year: null },
    { k: 'Покрытие себестоимостью, %', now: M.coverage, prev: d.moneyPrev.coverage, four: null, year: null },
    { k: 'Расход на рекламу, ₸', now: d.ads.kzt, prev: d.adsPrev.kzt, four: null, year: null },
    { k: 'Переходов из рекламы', now: d.ads.clicks, prev: d.adsPrev.clicks, four: null, year: null },
  ]);
  // Проценты своим форматом — иначе 12,4 покажется как 12. Строки ищем по названию,
  // а не по номеру: номер ломается от любой вставки в список выше.
  const summary = book.getWorksheet('Сводка');
  summary.eachRow((row, i) => {
    if (i === 1 || !String(row.getCell(1).value || '').endsWith(', %')) return;
    for (const c of [2, 3, 4, 5]) row.getCell(c).numFmt = PERCENT;
  });

  // ── Магазины ────────────────────────────────────────────────────────────────
  const stores = sheet(book, 'Магазины', [
    { header: 'Магазин', key: 'store', width: 22 },
    { header: 'Выручка, ₸', key: 'revenue', format: MONEY },
    { header: 'Доля, %', key: 'share', format: PERCENT },
    { header: 'Заказов', key: 'orders' },
    { header: 'Средний чек, ₸', key: 'avg', format: MONEY },
    { header: 'Отмен', key: 'cancelled' },
    { header: 'Отменено, ₸', key: 'cancelled_sum', format: MONEY },
    { header: 'В рассрочку', key: 'credit' },
  ], d.now.stores.map((s) => ({
    store: s.store, revenue: s.revenue, share: pct(s.revenue, a.revenue),
    orders: s.orders, avg: s.avg, cancelled: s.cancelled,
    cancelled_sum: s.cancelled_sum, credit: s.credit,
  })));
  totalRow(stores, 'Вместе', {
    revenue: a.revenue, share: 100, orders: a.orders, avg: a.avg,
    cancelled: a.cancelled, cancelled_sum: a.cancelled_sum, credit: a.credit,
  });

  // ── Дни ─────────────────────────────────────────────────────────────────────
  sheet(book, 'По дням', [
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'День', key: 'dow', width: 8 },
    { header: 'Выручка, ₸', key: 'revenue', format: MONEY },
    { header: 'Заказов', key: 'orders' },
    { header: 'Средний чек, ₸', key: 'avg', format: MONEY },
    { header: 'Обычно в этот день, ₸', key: 'usual', format: MONEY, width: 18 },
    { header: 'Отклонение, %', key: 'diff', format: PERCENT },
  ], d.series.map((x) => {
    const prof = d.profile.find((q) => q.dow === x.dow);
    const usual = prof ? prof.avg : 0;
    return {
      date: x.d, dow: x.dow, revenue: x.revenue, orders: x.orders,
      avg: x.orders ? x.revenue / x.orders : 0,
      usual, diff: usual ? ((x.revenue - usual) / usual) * 100 : null,
    };
  }));

  // ── Товары ──────────────────────────────────────────────────────────────────
  // Все позиции, а не первые двадцать: в Excel режут сами, фильтром.
  const prevByCard = new Map(d.itemsPrev.map((r) => [r.card_id, r]));
  const goods = sheet(book, 'Товары', [
    { header: 'Позиция', key: 'name', width: 46 },
    { header: 'Код технолога', key: 'code', width: 14 },
    { header: 'Карточка Kaspi', key: 'card', width: 14 },
    { header: 'Магазины', key: 'stores', width: 26 },
    { header: 'Категория', key: 'category', width: 26 },
    { header: 'Штук', key: 'qty' },
    { header: 'Заказов', key: 'orders' },
    { header: 'Выручка, ₸', key: 'revenue', format: MONEY },
    { header: 'Доставка, ₸', key: 'ship', format: MONEY },
    { header: 'Комиссия, ₸', key: 'commission', format: MONEY },
    { header: 'Себестоимость, ₸', key: 'cost', format: MONEY, width: 16 },
    { header: 'Остаётся, ₸', key: 'net', format: MONEY },
    { header: 'С штуки, ₸', key: 'per_unit', format: MONEY },
    { header: 'Наценка, %', key: 'markup', format: PERCENT },
    { header: 'Было на прошлой неделе, ₸', key: 'was', format: MONEY, width: 20 },
    { header: 'Разница, ₸', key: 'delta', format: MONEY },
  ], d.itemsNow.map((r) => {
    const was = prevByCard.get(r.card_id);
    return {
      name: (r.name || '').replace(/\s+/g, ' ').trim(),
      code: r.code || '', card: r.card_id, stores: r.stores || '', category: r.category || '',
      qty: r.qty, orders: r.orders, revenue: r.revenue, ship: r.ship, commission: r.commission,
      cost: r.cost, net: r.net, per_unit: r.per_unit, markup: r.markup,
      was: was ? was.revenue : 0, delta: r.revenue - (was ? was.revenue : 0),
    };
  }));
  totalRow(goods, 'Итого', {
    qty: d.itemsNow.reduce((s, r) => s + r.qty, 0),
    revenue: M.revenue, ship: M.ship, commission: M.commission, cost: M.cost, net: M.net,
  });

  // Продавались на прошлой неделе и пропали — отдельным листом, не примечанием
  sheet(book, 'Пропали из продаж', [
    { header: 'Позиция', key: 'name', width: 46 },
    { header: 'Код технолога', key: 'code', width: 14 },
    { header: 'Карточка Kaspi', key: 'card', width: 14 },
    { header: 'Было за прошлую неделю, ₸', key: 'revenue', format: MONEY, width: 22 },
    { header: 'Штук', key: 'qty' },
  ], d.disappeared.map((r) => ({
    name: (r.name || '').replace(/\s+/g, ' ').trim(),
    code: r.code || '', card: r.card_id, revenue: r.revenue, qty: r.qty,
  })));

  // ── Категории ───────────────────────────────────────────────────────────────
  const cats = sheet(book, 'Категории', [
    { header: 'Категория', key: 'category', width: 34 },
    { header: 'Выручка, ₸', key: 'revenue', format: MONEY },
    { header: 'Доля, %', key: 'share', format: PERCENT },
    { header: 'Штук', key: 'qty' },
    { header: 'Средняя цена, ₸', key: 'avg', format: MONEY },
    { header: 'Остаётся, ₸', key: 'net', format: MONEY },
  ], d.categories.map((c) => ({
    category: c.category, revenue: c.revenue, share: pct(c.revenue, M.revenue),
    qty: c.qty, avg: c.qty ? c.revenue / c.qty : 0, net: c.known ? c.net : null,
  })));
  totalRow(cats, 'Итого', {
    revenue: M.revenue, share: 100,
    qty: d.categories.reduce((s, c) => s + c.qty, 0),
    net: d.categories.reduce((s, c) => s + (c.known ? c.net : 0), 0),
  });

  // ── Карточки ────────────────────────────────────────────────────────────────
  sheet(book, 'Карточки', [
    { header: 'Позиция', key: 'name', width: 46 },
    { header: 'Карточка Kaspi', key: 'card', width: 14 },
    { header: `Место ${d.rank.first || ''}`, key: 'place_was', width: 14 },
    { header: `Место ${d.rank.last || ''}`, key: 'place_now', width: 14 },
    { header: 'Сдвиг', key: 'shift' },
    { header: 'Цена была, ₸', key: 'price_was', format: MONEY },
    { header: 'Цена стала, ₸', key: 'price_now', format: MONEY },
    { header: 'Лучшая на карточке, ₸', key: 'best_price', format: MONEY, width: 18 },
    { header: 'Кто дешевле', key: 'best_seller', width: 32 },
    { header: 'Продавцов', key: 'offers_total' },
  ], (d.rank.all || []).map((r) => ({
    name: (r.name || '').replace(/\s+/g, ' ').trim(),
    card: r.card_id, place_was: r.place_was, place_now: r.place_now,
    shift: r.place_was !== null && r.place_now !== null ? r.place_was - r.place_now : null,
    price_was: r.price_was, price_now: r.price_now,
    best_price: r.best_price,
    best_seller: r.best_price && r.price_now && r.best_price < r.price_now ? (r.best_seller || '') : '',
    offers_total: r.offers_total,
  })));

  // ── Отмены и оплата ─────────────────────────────────────────────────────────
  sheet(book, 'Отмены', [
    { header: 'Причина', key: 'ru', width: 36 },
    { header: 'Код Kaspi', key: 'reason', width: 32 },
    { header: 'Штук', key: 'n' },
    { header: 'Сумма, ₸', key: 'sum', format: MONEY },
    { header: 'Наша вина', key: 'ours', width: 12 },
  ], d.cancelNow.map((c) => ({
    ru: c.ru, reason: c.reason, n: c.n, sum: c.sum, ours: c.ours ? 'да' : 'нет',
  })));

  sheet(book, 'Оплата', [
    { header: 'Как платили', key: 'term', width: 24 },
    { header: 'Заказов', key: 'n' },
    { header: 'Сумма, ₸', key: 'sum', format: MONEY },
    { header: 'Средний чек, ₸', key: 'avg', format: MONEY },
  ], d.now.terms.map((t) => ({
    term: t.term === 'предоплата' ? 'предоплата' : `рассрочка ${t.term} мес`,
    n: t.n, sum: t.sum, avg: t.sum / (t.n || 1),
  })));

  // ── Логистика ───────────────────────────────────────────────────────────────
  sheet(book, 'Логистика', [
    { header: 'Показатель', key: 'k', width: 40 },
    { header: 'Значение', key: 'v', width: 14 },
  ], [
    { k: 'Отгружено заказов', v: d.log.shipped },
    { k: 'Срок отгрузки, медиана, суток', v: Number((num(d.log.median_hours) / 24).toFixed(1)) },
    { k: 'Срок отгрузки, 90-й процентиль, суток', v: Number((num(d.log.p90_hours) / 24).toFixed(1)) },
    { k: 'Срок отгрузки, среднее, суток', v: Number((num(d.log.avg_hours) / 24).toFixed(1)) },
    { k: 'Отгружались дольше недели', v: d.log.over_week },
    { k: 'Накладная не прочиталась', v: d.log.waybill_failed },
    { k: 'Висят в работе дольше двух дней', v: d.log.stuck.length },
  ]);

  sheet(book, 'Висят в работе', [
    { header: 'Заказ', key: 'order_code', width: 16 },
    { header: 'Магазин', key: 'store', width: 18 },
    { header: 'День заказа', key: 'd', width: 13 },
    { header: 'Стадия', key: 'stage', width: 12 },
    { header: 'Сумма, ₸', key: 'total', format: MONEY },
  ], d.log.stuck.map((s) => ({
    order_code: s.order_code, store: s.store, d: s.d, stage: s.stage, total: s.total,
  })));

  // ── Реклама ─────────────────────────────────────────────────────────────────
  sheet(book, 'Реклама за неделю', [
    { header: 'Направление', key: 'destination', width: 26 },
    { header: 'Расход, $', key: 'usd', format: MONEY2 },
    { header: 'Расход, ₸', key: 'kzt', format: MONEY },
    { header: 'Показов', key: 'impressions' },
    { header: 'Переходов', key: 'clicks' },
    { header: 'Цена перехода, ₸', key: 'cpc', format: MONEY, width: 16 },
    { header: 'CTR, %', key: 'ctr', format: PERCENT },
    { header: 'Кампаний', key: 'campaigns' },
  ], d.ads.dest.map((x) => ({
    destination: x.destination, usd: x.usd, kzt: x.kzt, impressions: x.impressions,
    clicks: x.clicks, cpc: x.cpc, ctr: x.ctr, campaigns: x.campaigns,
  })));

  sheet(book, 'Реклама по неделям', [
    { header: 'Неделя', key: 'week', width: 26 },
    { header: 'Начало', key: 'from', width: 12 },
    { header: 'Конец', key: 'to', width: 12 },
    { header: 'Расход, ₸', key: 'kzt', format: MONEY },
    { header: 'Переходов', key: 'clicks' },
    { header: 'Выручка, ₸', key: 'revenue', format: MONEY },
    { header: 'Заказов', key: 'orders' },
    { header: 'Доля расхода в выручке, %', key: 'share', format: '0.00"%"', width: 20 },
    { header: 'Валовый ROAS', key: 'roas', format: MONEY },
  ], d.adsWeeks.map((w) => ({
    week: `${human(w.from)} — ${human(w.to)}`, from: w.from, to: w.to,
    kzt: w.kzt, clicks: w.clicks, revenue: w.revenue, orders: w.orders,
    share: w.share, roas: w.roas,
  })));

  sheet(book, 'Реклама по месяцам', [
    { header: 'Месяц', key: 'mon', width: 12 },
    { header: 'Расход, $', key: 'usd', format: MONEY2 },
    { header: 'Расход, ₸', key: 'kzt', format: MONEY },
    { header: 'Переходов', key: 'clicks' },
    { header: 'Выручка, ₸', key: 'revenue', format: MONEY },
    { header: 'Заказов', key: 'orders' },
    { header: 'Доля расхода в выручке, %', key: 'share', format: '0.00"%"', width: 20 },
    { header: 'Валовый ROAS', key: 'roas', format: MONEY },
  ], d.adsMonths.map((w) => ({
    mon: w.mon, usd: w.usd, kzt: w.kzt, clicks: w.clicks,
    revenue: w.revenue, orders: w.orders, share: w.share, roas: w.roas,
  })));

  sheet(book, 'Окупаемость рекламы', [
    { header: 'Показатель', key: 'k', width: 44 },
    { header: 'Значение', key: 'v', width: 16, format: MONEY },
  ], [
    { k: 'Расход за неделю, ₸', v: d.payback.kzt },
    { k: 'Расход за неделю, $', v: Number(d.payback.usd.toFixed(2)) },
    { k: 'Доля расхода в выручке, %', v: Number(d.payback.share.toFixed(2)) },
    { k: 'Переходов', v: d.payback.clicks },
    { k: 'Валовый ROAS, ₸ выручки на тенге', v: d.payback.grossRoas },
    { k: 'Прибыль с заказа, ₸', v: Math.round(d.payback.netPerOrder) },
    { k: 'Заказов, чтобы вернуть вложенное', v: d.payback.ordersNeeded === null ? null : Number(d.payback.ordersNeeded.toFixed(1)) },
    { k: 'Это от всех заказов недели, %', v: d.payback.ordersNeededShare === null ? null : Number(d.payback.ordersNeededShare.toFixed(1)) },
    { k: 'Нужна конверсия перехода, %', v: d.payback.conversionNeeded === null ? null : Number(d.payback.conversionNeeded.toFixed(2)) },
    { k: 'Замеренная конверсия карточки, %', v: d.payback.conversionMeasured },
  ]);

  // ── Полнота данных ──────────────────────────────────────────────────────────
  const g = d.gaps;
  sheet(book, 'Полнота данных', [
    { header: 'Показатель', key: 'k', width: 44 },
    { header: 'Есть', key: 'have' },
    { header: 'Всего', key: 'total' },
  ], [
    { k: 'Артикулов Kaspi с кодом технолога', have: g.prod.linked, total: g.prod.total },
    { k: 'Изделий склада с кодом технолога', have: g.wh.linked, total: g.wh.total },
    { k: 'Артикулов без цены', have: g.prod.no_price, total: g.prod.total },
    { k: `Позиций в замере мест ${g.rank.d}`, have: g.rank.n, total: g.prod.total },
    { k: 'Выручка с известной себестоимостью, ₸', have: Math.round(M.knownRevenue), total: Math.round(M.revenue) },
  ]);

  return book;
}

async function writeXlsx(d, file) {
  const book = build(d);
  await book.xlsx.writeFile(file);
  return file;
}

module.exports = { build, writeXlsx };
