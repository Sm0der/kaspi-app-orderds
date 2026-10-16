// Как еженедельный отчёт выглядит: текст в консоль и страница для чтения.
// Считает данные weekly-report.js, здесь только оформление.
//
// Страница самодостаточная: ни одного внешнего файла, графики нарисованы SVG прямо
// в разметке. Её можно открыть с телефона, отправить в мессенджер и распечатать.
const { m, pct, delta, sign, num, human, RU_DOW } = require('./weekly-report');

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const short = (s, n = 46) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const mln = (v) => (Math.abs(num(v)) >= 1e6 ? (num(v) / 1e6).toFixed(2) + ' млн' : m(v));

// ── текст в консоль ───────────────────────────────────────────────────────────
function renderText(d) {
  const L = [];
  const line = (s = '') => L.push(s);
  const rule = (t) => { line(''); line('── ' + t + ' ' + '─'.repeat(Math.max(0, 70 - t.length))); line(''); };

  line('');
  line('ОТЧЁТ ЗА НЕДЕЛЮ  ' + human(d.from) + ' — ' + human(d.to));
  line('='.repeat(74));

  const a = d.now.all;
  const p = d.prev.all;
  const y = d.year.all;
  const f = d.four.all;
  rule('ДЕНЬГИ');
  line('  выручка        ' + m(a.revenue).padStart(12) + ' ₸    к прошлой неделе ' + sign(delta(a.revenue, p.revenue), 1) +
       ',  к среднему за 4 недели ' + sign(delta(a.revenue, f.revenue / 4), 1) +
       (y.revenue ? ',  год назад ' + sign(delta(a.revenue, y.revenue), 1) : ''));
  line('  заказов        ' + String(a.orders).padStart(12) + '      ' + sign(delta(a.orders, p.orders), 1));
  line('  средний чек    ' + m(a.avg).padStart(12) + ' ₸    ' + sign(delta(a.avg, p.avg), 1));
  line('  отмены         ' + String(a.cancelled).padStart(12) + ' шт   ' + pct(a.cancelled, a.cancelled + a.orders).toFixed(1) + '% заказов, ' + m(a.cancelled_sum) + ' ₸');
  for (const s of d.now.stores) {
    line('    ' + s.store.padEnd(16) + m(s.revenue).padStart(12) + ' ₸  ' + String(s.orders).padStart(4) + ' зак.  средний ' + m(s.avg) + ' ₸');
  }

  // Штука и место - разные единицы. Машину, грузчиков и склад занимают места:
  // одна штука едет и пятью коробками, поэтому неделя «на 1000 штук» и неделя
  // «на 1700 мест» - это разный объём работы при одной и той же выручке.
  const B = d.boxes;
  const Bp = d.boxesPrev;
  line('');
  line('  штук           ' + String(B.qty).padStart(12) + '      ' + sign(delta(B.qty, Bp.qty), 1));
  line('  мест (коробок) ' + String(Math.round(B.boxes)).padStart(12) + '      ' + sign(delta(B.boxes, Bp.boxes), 1) +
       (B.perUnit ? ',  по ' + B.perUnit.toFixed(2) + ' на штуку' : ''));
  line('    места известны у ' + B.qtyKnown + ' штук из ' + B.qty + ' (' + B.coverage.toFixed(0) + '%)' +
       (B.unknown ? ', у ' + B.unknown + ' позиций нет изделия склада' : '') +
       (B.projected ? ';  со всеми было бы около ' + Math.round(B.projected) + ' мест' : ''));

  rule('ЧТО ОСТАЁТСЯ');
  const M = d.money;
  line('  выручка                 ' + m(M.revenue).padStart(12) + ' ₸');
  line('  − комиссия Kaspi 11,75% ' + m(-M.commission).padStart(12) + ' ₸');
  line('  − доставка по факту     ' + m(-M.ship).padStart(12) + ' ₸   (' + pct(M.ship, M.revenue).toFixed(1) + '% выручки)');
  line('  − себестоимость         ' + m(-M.cost).padStart(12) + ' ₸');
  line('  = остаётся              ' + m(M.net).padStart(12) + ' ₸   ' + M.netRate.toFixed(1) + '% от посчитанной выручки');
  line('');
  line('  Посчитано по ' + M.coverage.toFixed(0) + '% выручки (' + m(M.knownRevenue) + ' ₸): у остальных позиций нет кода технолога.');
  line('  Если у них та же доходность, по всей неделе остаётся около ' + m(M.netProjected) + ' ₸.');

  rule('ПО ДНЯМ');
  const max = Math.max(...d.series.map((x) => x.revenue), 1);
  for (const x of d.series) {
    const prof = d.profile.find((q) => q.dow === x.dow);
    const bar = '█'.repeat(Math.round((x.revenue / max) * 34));
    line('  ' + x.dow + ' ' + x.d.slice(8) + '  ' + m(x.revenue).padStart(9) + ' ₸ ' + bar.padEnd(35) +
         ' обычно ' + m(prof ? prof.avg : 0).padStart(9) + ' ₸  ' + sign(delta(x.revenue, prof ? prof.avg : 0), 0));
  }

  rule('ТОП ПО ДЕНЬГАМ');
  line('  позиция                                        шт  мест      выручка     остаётся   с штуки');
  for (const r of d.itemsNow.slice(0, 12)) {
    line('  ' + short(r.name, 44).padEnd(46) + String(r.qty).padStart(4) +
         (r.boxes === null ? '     —' : String(r.boxes).padStart(6)) + m(r.revenue).padStart(13) +
         (r.net === null ? '            —' : m(r.net).padStart(13)) +
         (r.per_unit === null ? '         —' : m(r.per_unit).padStart(10)));
  }

  const up = d.movers.filter((x) => x.d_revenue > 0).sort((x, z) => z.d_revenue - x.d_revenue).slice(0, 5);
  const down = d.movers.filter((x) => x.d_revenue < 0).sort((x, z) => x.d_revenue - z.d_revenue).slice(0, 5);
  rule('ЧТО ИЗМЕНИЛОСЬ ПРОТИВ ПРОШЛОЙ НЕДЕЛИ');
  line('  выросли:');
  for (const r of up) line('    + ' + m(r.d_revenue).padStart(10) + ' ₸  ' + short(r.name, 42) + (r.fresh ? '  (на прошлой неделе не продавалась)' : ''));
  line('  просели:');
  for (const r of down) line('    − ' + m(-r.d_revenue).padStart(10) + ' ₸  ' + short(r.name, 42));
  if (d.disappeared.length) {
    line('  продавались и пропали совсем:');
    for (const r of d.disappeared.slice(0, 6)) line('    ' + m(r.revenue).padStart(10) + ' ₸ на прошлой неделе  ' + short(r.name, 42));
  }

  rule('КАРТОЧКИ');
  if (d.rank.days.length < 2) {
    line('  Срезов за неделю меньше двух — сравнивать не с чем.');
  } else {
    line('  Замеры ' + d.rank.first + ' → ' + d.rank.last + ', города: ' + d.rank.cities +
         '. Первые везде: ' + d.rank.firstEverywhere + ', первые хоть где-то: ' + d.rank.firstSomewhere +
         ', ниже десятого хоть где-то: ' + d.rank.deep.length + '.');
    for (const r of d.rank.moves.slice(0, 10)) {
      const price = r.price_was && r.price_now && r.price_was !== r.price_now
        ? '  цена ' + m(r.price_was) + ' → ' + m(r.price_now) : '';
      line('    ' + (r.shift > 0 ? '↑' : '↓') + ' ' + short(r.name, 40).padEnd(42) +
           ('первых городов ' + r.first_was + ' → ' + r.first_now + ' из ' + r.cities_total).padEnd(26) + price);
    }
    if (d.rank.gone.length) line('    пропали со всех городов: ' + d.rank.gone.map((r) => short(r.name, 28)).join(', '));
  }

  rule('ОТМЕНЫ И ВОЗВРАТЫ');
  for (const c of d.cancelNow) {
    line('  ' + String(c.n).padStart(4) + ' шт  ' + m(c.sum).padStart(10) + ' ₸  ' + c.ru + (c.ours ? '   ← наша вина' : ''));
  }
  line('  возвратов за неделю: ' + a.returned);

  rule('ЛОГИСТИКА');
  const lg = d.log;
  line('  отгружено ' + lg.shipped + ', от заказа до отгрузки: медиана ' + (num(lg.median_hours) / 24).toFixed(1) +
       ' сут, девять из десяти укладываются в ' + (num(lg.p90_hours) / 24).toFixed(1) + ' сут');
  line('  дольше недели: ' + lg.over_week + ',  накладная не прочиталась: ' + lg.waybill_failed);
  if (lg.stuck.length) {
    line('  висят в работе дольше двух дней: ' + lg.stuck.length);
    for (const s of lg.stuck.slice(0, 5)) line('    ' + s.d + '  ' + s.order_code + '  ' + m(s.total) + ' ₸  ' + s.stage + '  ' + s.store);
  }

  rule('РЕКЛАМА И ПРОДАЖИ');
  const A = d.ads;
  const P = d.payback;
  if (!A.usd) {
    line('  За неделю на рекламу не потрачено ничего.');
  } else {
    line('  расход         ' + A.usd.toFixed(2).padStart(10) + ' $   = ' + m(A.kzt) + ' ₸,  это ' + P.share.toFixed(2) + '% выручки');
    line('  переходов      ' + String(A.clicks).padStart(10) + '     по ' + m(A.cpc) + ' ₸,  CTR ' + (A.ctr || 0).toFixed(2) + '%,  CPM ' + m(A.cpm) + ' ₸');
    line('  показов        ' + String(A.impressions).padStart(10));
    line('');
    line('  куда вели:');
    for (const x of A.dest) {
      line('    ' + x.destination.padEnd(22) + m(x.kzt).padStart(10) + ' ₸  ' + String(x.clicks).padStart(6) + ' переходов по ' +
           m(x.cpc) + ' ₸,  CTR ' + (x.ctr || 0).toFixed(2) + '%');
    }
    line('');
    line('  ВАЛОВЫЙ ROAS ' + (P.grossRoas === null ? '—' : P.grossRoas.toFixed(0) + ' ₸ выручки на вложенный тенге') + ' — цифра бесполезная:');
    line('  пикселя на Kaspi нет, покупки к объявлениям не привязаны, и она приписывает рекламе всю выручку.');
    line('  Считать надо порог:');
    line('    прибыль с заказа            ' + m(P.netPerOrder).padStart(10) + ' ₸');
    line('    заказов, чтобы отбить       ' + (P.ordersNeeded === null ? '—' : P.ordersNeeded.toFixed(1).padStart(10)) +
         '     это ' + (P.ordersNeededShare === null ? '—' : P.ordersNeededShare.toFixed(1) + '% всех ' + d.now.all.orders + ' заказов недели'));
    line('    нужна конверсия перехода    ' + (P.conversionNeeded === null ? '—' : P.conversionNeeded.toFixed(2).padStart(10) + '%') +
         '     замеренная конверсия карточки ' + P.conversionMeasured + '%');
    line('    ' + (P.conversionNeeded !== null && P.conversionNeeded < P.conversionMeasured
      ? 'Порог ниже замеренной конверсии — реклама окупилась с запасом в ' + (P.conversionMeasured / P.conversionNeeded).toFixed(1) + ' раза.'
      : 'Порог ВЫШЕ замеренной конверсии — такой расход не отбивается.'));
  }

  rule('РЕКЛАМА И ВЫРУЧКА ПО НЕДЕЛЯМ');
  line('  неделя                 расход        выручка   доля   заказов   валовый ROAS');
  for (const w of d.adsWeeks) {
    line('  ' + (human(w.from) + ' — ' + human(w.to)).padEnd(24) +
         (w.kzt ? m(w.kzt) + ' ₸' : '—').padStart(11) +
         m(w.revenue).padStart(14) + ' ₸' +
         (w.kzt ? w.share.toFixed(2) + '%' : '—').padStart(8) +
         String(w.orders).padStart(9) +
         (w.roas === null ? '—' : m(w.roas)).padStart(14));
  }

  rule('РЕКЛАМА И ВЫРУЧКА ПО МЕСЯЦАМ');
  line('  месяц        расход        выручка   доля   заказов   валовый ROAS');
  for (const w of d.adsMonths) {
    line('  ' + w.mon.padEnd(10) + m(w.kzt).padStart(10) + ' ₸' + m(w.revenue).padStart(14) + ' ₸' +
         (w.share.toFixed(2) + '%').padStart(8) + String(w.orders).padStart(9) +
         (w.roas === null ? '—' : m(w.roas)).padStart(14));
  }

  rule('ЧЕГО НЕ ХВАТАЕТ В ДАННЫХ');
  const g = d.gaps;
  line('  себестоимость известна у ' + g.prod.linked + ' артикулов из ' + g.prod.total +
       ', у изделий склада ' + g.wh.linked + ' из ' + g.wh.total);
  line('  цены нет у ' + g.prod.no_price + ' артикулов, последний замер мест ' + g.rank.d + ' (' + g.rank.n + ' позиций)');

  line('');
  return L.join('\n');
}

// ── страница ──────────────────────────────────────────────────────────────────
// Столбики по дням. Своя разметка, а не библиотека: график на семь значений не
// стоит трёхсот килобайт, а страница должна открываться с телефона в поле.
function barChart(series, profile) {
  const w = 760;
  const h = 200;
  const pad = { l: 8, r: 8, t: 16, b: 34 };
  const max = Math.max(...series.map((x) => x.revenue), ...profile.map((x) => x.avg), 1);
  const bw = (w - pad.l - pad.r) / series.length;
  const bars = series.map((x, i) => {
    const prof = profile.find((q) => q.dow === x.dow);
    const bh = ((h - pad.t - pad.b) * x.revenue) / max;
    const ph = ((h - pad.t - pad.b) * (prof ? prof.avg : 0)) / max;
    const cx = pad.l + i * bw;
    const barW = bw * 0.52;
    const better = prof && x.revenue >= prof.avg;
    return `
      <rect x="${(cx + bw * 0.14).toFixed(1)}" y="${(h - pad.b - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"
            rx="3" fill="${better ? 'var(--good)' : 'var(--warn)'}"></rect>
      <line x1="${(cx + bw * 0.08).toFixed(1)}" x2="${(cx + bw * 0.78).toFixed(1)}"
            y1="${(h - pad.b - ph).toFixed(1)}" y2="${(h - pad.b - ph).toFixed(1)}"
            stroke="var(--line-strong)" stroke-width="1.5" stroke-dasharray="4 3"></line>
      <text x="${(cx + bw * 0.4).toFixed(1)}" y="${h - pad.b + 14}" text-anchor="middle"
            class="tick">${x.dow}</text>
      <text x="${(cx + bw * 0.4).toFixed(1)}" y="${h - pad.b + 27}" text-anchor="middle"
            class="tick dim">${(x.revenue / 1e6).toFixed(1)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img"
     aria-label="Выручка по дням недели в миллионах тенге, пунктиром обычный уровень этого дня">
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}" stroke="var(--line)"></line>
    ${bars}
  </svg>`;
}

function kpi(label, value, unit, note, tone) {
  return `<div class="kpi${tone ? ' ' + tone : ''}">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${esc(value)}<span class="kpi-unit">${esc(unit || '')}</span></div>
    <div class="kpi-note">${note || ''}</div>
  </div>`;
}

const tone = (v) => (v === null ? '' : v > 1 ? 'up' : v < -1 ? 'down' : 'flat');
const chip = (v, digits = 1) => `<span class="chip ${tone(v)}">${esc(sign(v, digits))}</span>`;

function renderHtml(d) {
  const a = d.now.all;
  const p = d.prev.all;
  const y = d.year.all;
  const f = d.four.all;
  const M = d.money;
  const g = d.gaps;

  const rows = (list, cells) => list.map((r) => '<tr>' + cells(r).map((c) => (typeof c === 'string' && c.startsWith('<') ? c : `<td>${esc(c)}</td>`)).join('') + '</tr>').join('');
  const n = (v) => `<td class="n">${esc(v)}</td>`;

  const up = d.movers.filter((x) => x.d_revenue > 0).sort((x, z) => z.d_revenue - x.d_revenue).slice(0, 8);
  const down = d.movers.filter((x) => x.d_revenue < 0).sort((x, z) => x.d_revenue - z.d_revenue).slice(0, 8);
  const byUnit = d.itemsNow.filter((r) => r.per_unit !== null).sort((x, z) => z.per_unit - x.per_unit);
  const weak = byUnit.slice(-6).reverse();

  const ourFault = d.cancelNow.filter((c) => c.ours).reduce((s, c) => s + c.n, 0);
  const cancelShare = pct(a.cancelled, a.cancelled + a.orders);
  const prevCancelShare = pct(p.cancelled, p.cancelled + p.orders);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Неделя ${esc(human(d.from))} — ${esc(human(d.to))}</title>
<style>
  :root {
    --bg: #faf8f5;
    --surface: #ffffff;
    --ink: #1b1915;
    --ink-soft: #5d574d;
    --ink-dim: #8c8578;
    --line: #e4ded4;
    --line-strong: #b8ae9e;
    --accent: #8a4b2a;
    --good: #3f6b4a;
    --warn: #b07c2a;
    --bad: #9c3326;
    --mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #16140f; --surface: #1f1c17; --ink: #f0ebe2; --ink-soft: #b5ac9d;
      --ink-dim: #837b6d; --line: #312c24; --line-strong: #5c5447;
      --accent: #d98a5c; --good: #7fae89; --warn: #d9ab5c; --bad: #d9796a;
    }
  }
  :root[data-theme="dark"] {
    --bg: #16140f; --surface: #1f1c17; --ink: #f0ebe2; --ink-soft: #b5ac9d;
    --ink-dim: #837b6d; --line: #312c24; --line-strong: #5c5447;
    --accent: #d98a5c; --good: #7fae89; --warn: #d9ab5c; --bad: #d9796a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.55 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 48px 16px 80px; }
  header { border-bottom: 2px solid var(--ink); padding-bottom: 18px; margin-bottom: 8px; }
  .eyebrow { font: 600 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.05; margin: 12px 0 6px; text-wrap: balance; font-weight: 600; }
  .sub { color: var(--ink-soft); font-size: 15px; }
  h2 {
    font: 600 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase;
    color: var(--ink-dim); margin: 54px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line);
  }
  h3 { font-size: 17px; margin: 26px 0 8px; font-weight: 600; }
  p { margin: 10px 0; color: var(--ink-soft); }
  p.lead { color: var(--ink); font-size: 17px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); margin-top: 18px; }
  .kpi { background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 14px 16px; }
  .kpi.up { border-left: 3px solid var(--good); }
  .kpi.down { border-left: 3px solid var(--bad); }
  .kpi-label { font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-dim); }
  .kpi-value { font-size: 27px; margin: 9px 0 4px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
  .kpi-unit { font-size: 14px; color: var(--ink-dim); margin-left: 4px; }
  .kpi-note { font-size: 13px; color: var(--ink-soft); }
  .chip { font: 600 12px/1 var(--mono); padding: 2px 6px; border-radius: 3px; background: var(--line); color: var(--ink-soft); white-space: nowrap; }
  .chip.up { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
  .chip.down { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
  .scroll { overflow-x: auto; margin-top: 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
  th {
    text-align: left; font: 600 11px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase;
    color: var(--ink-dim); padding: 0 10px 7px; border-bottom: 1px solid var(--line-strong); white-space: nowrap;
  }
  th.n, td.n { text-align: right; }
  td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.n { font-variant-numeric: tabular-nums; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  .muted { color: var(--ink-dim); }
  .chart { width: 100%; height: auto; display: block; margin: 10px 0 4px; }
  .tick { font: 11px var(--mono); fill: var(--ink-soft); }
  .tick.dim { fill: var(--ink-dim); }
  .waterfall { margin: 16px 0 0; }
  .wf-row { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .wf-row:last-child { border-bottom: none; border-top: 2px solid var(--ink); margin-top: 4px; font-weight: 600; }
  .wf-row .v { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .wf-bar { height: 7px; border-radius: 2px; margin-top: 5px; }
  .note { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 3px; padding: 12px 15px; margin: 18px 0; font-size: 14.5px; color: var(--ink-soft); }
  .note strong { color: var(--ink); }
  ul.todo { list-style: none; padding: 0; margin: 14px 0; }
  ul.todo li { padding: 10px 0 10px 26px; border-bottom: 1px solid var(--line); position: relative; color: var(--ink); }
  ul.todo li::before { content: "□"; position: absolute; left: 2px; color: var(--accent); font-size: 17px; }
  footer { margin-top: 60px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-dim); }
  @media print {
    body { background: #fff; }
    .wrap { max-width: none; padding: 0; }
    h2 { page-break-after: avoid; }
    table { page-break-inside: auto; }
  }
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="eyebrow">ARTROOM · еженедельный отчёт</div>
  <h1>${esc(human(d.from))} — ${esc(human(d.to))}</h1>
  <div class="sub">КухниKZ и ART ROOM HOME. Сравнение с прошлой неделей, со средней за четыре недели и с той же неделей год назад.</div>
</header>

<div class="grid">
  ${kpi('Выручка', mln(a.revenue), '₸', chip(delta(a.revenue, p.revenue)) + ' к прошлой неделе', tone(delta(a.revenue, p.revenue)))}
  ${kpi('Заказов', m(a.orders), '', chip(delta(a.orders, p.orders)) + ' · средний чек ' + m(a.avg) + ' ₸')}
  ${kpi('Остаётся чистыми', mln(M.net), '₸', M.netRate.toFixed(1) + '% от посчитанной выручки')}
  ${kpi('Мест (коробок)', m(Math.round(d.boxes.boxes)), '',
    d.boxes.qty + ' шт' + (d.boxes.perUnit ? ' · по ' + d.boxes.perUnit.toFixed(2) + ' на штуку' : '') +
    ' · посчитано по ' + d.boxes.coverage.toFixed(0) + '% штук')}
  ${kpi('Отмены', m(a.cancelled), 'шт', cancelShare.toFixed(1) + '% заказов' + (prevCancelShare ? ', было ' + prevCancelShare.toFixed(1) + '%' : ''), cancelShare > prevCancelShare ? 'down' : 'up')}
</div>

<h2>Деньги</h2>
<div class="scroll"><table>
  <thead><tr><th>Магазин</th><th class="n">Выручка</th><th class="n">Доля</th><th class="n">Заказов</th><th class="n">Средний чек</th><th class="n">Отмен</th></tr></thead>
  <tbody>
  ${rows(d.now.stores, (r) => ['<td>' + esc(r.store) + '</td>', n(m(r.revenue) + ' ₸'), n(pct(r.revenue, a.revenue).toFixed(0) + '%'), n(r.orders), n(m(r.avg) + ' ₸'), n(r.cancelled)])}
  <tr><td><strong>Вместе</strong></td>${n(m(a.revenue) + ' ₸')}${n('100%')}${n(a.orders)}${n(m(a.avg) + ' ₸')}${n(a.cancelled)}</tr>
  </tbody>
</table></div>

<div class="note">
  Неделя к неделе ${chip(delta(a.revenue, p.revenue))}, к средней за четыре недели
  ${chip(delta(a.revenue, f.revenue / 4))}${y.revenue ? ', к той же неделе год назад ' + chip(delta(a.revenue, y.revenue)) : ''}.
  Год назад за эти семь дней было <strong>${esc(m(y.revenue))} ₸</strong> и ${esc(y.orders)} заказов.
</div>

<h2>Что остаётся</h2>
<p>Выручка минус комиссия Kaspi 11,75%, минус фактическая доставка из заказов, минус себестоимость технолога.
   Доставка в заказе одна на всё, между позициями делится по доле в сумме.</p>
<div class="waterfall">
  ${[
    ['Выручка', M.revenue, 'var(--ink-soft)'],
    ['Комиссия Kaspi 11,75%', -M.commission, 'var(--warn)'],
    ['Доставка по факту', -M.ship, 'var(--warn)'],
    ['Себестоимость', -M.cost, 'var(--bad)'],
  ].map(([label, value, color]) => `
    <div class="wf-row">
      <div>${esc(label)}
        <div class="wf-bar" style="width:${Math.min(100, (Math.abs(value) / M.revenue) * 100).toFixed(1)}%;background:${color}"></div>
      </div>
      <div class="v">${esc((value < 0 ? '−' : '') + m(Math.abs(value)))} ₸</div>
    </div>`).join('')}
  <div class="wf-row"><div>Остаётся</div><div class="v">${esc(m(M.net))} ₸</div></div>
</div>
<div class="note">
  Посчитано по <strong>${esc(M.coverage.toFixed(0))}%</strong> выручки — ${esc(m(M.knownRevenue))} ₸.
  У остальных позиций нет кода технолога, и их себестоимость неизвестна: приписывать им нулевые затраты
  нельзя, иначе прибыль выйдет почти равной выручке. Если доходность у них такая же, по всей неделе
  остаётся около <strong>${esc(m(M.netProjected))} ₸</strong>.
  На прошлой неделе чистыми выходило ${esc(d.moneyPrev.netRate.toFixed(1))}% ${chip(M.netRate - d.moneyPrev.netRate, 1)}.
</div>

<h2>По дням</h2>
<p>Столбик — выручка дня, пунктир — сколько обычно даёт этот день недели (среднее за четыре предыдущие недели).
   Зелёный столбик выше своей нормы, жёлтый ниже. Подпись под столбиком — миллионы тенге.</p>
${barChart(d.series, d.profile)}
<div class="scroll"><table>
  <thead><tr><th>День</th><th class="n">Выручка</th><th class="n">Заказов</th><th class="n">Обычно</th><th class="n">Разница</th></tr></thead>
  <tbody>
  ${rows(d.series, (r) => {
    const prof = d.profile.find((q) => q.dow === r.dow);
    const dv = delta(r.revenue, prof ? prof.avg : 0);
    return ['<td>' + esc(r.dow + ' ' + r.d.slice(8) + '.' + r.d.slice(5, 7)) + '</td>',
      n(m(r.revenue) + ' ₸'), n(r.orders), n(m(prof ? prof.avg : 0) + ' ₸'), '<td class="n">' + chip(dv, 0) + '</td>'];
  })}
  </tbody>
</table></div>

<h2>Топ по деньгам</h2>
<p>Считаем по карточке Kaspi, а не по артикулу: одна и та же позиция продаётся из двух наших витрин
   и при переезде получает новый артикул. «С штуки» — сколько остаётся после комиссии, доставки и себестоимости.</p>
<div class="scroll"><table>
  <thead><tr><th>Позиция</th><th>Код</th><th class="n">Шт</th><th class="n">Коробок</th><th class="n">Выручка</th><th class="n">Наценка</th><th class="n">Остаётся</th><th class="n">С штуки</th></tr></thead>
  <tbody>
  ${rows(d.itemsNow.slice(0, 20), (r) => [
    '<td>' + esc(short(r.name, 52)) + '<div class="muted" style="font-size:12.5px">' + esc(r.stores || '') + '</div></td>',
    '<td class="muted">' + esc(r.code || '—') + '</td>',
    n(r.qty), n(r.boxes === null ? '—' : String(r.boxes)), n(m(r.revenue) + ' ₸'),
    n(r.markup === null ? '—' : r.markup.toFixed(0) + '%'),
    n(r.net === null ? '—' : m(r.net) + ' ₸'),
    n(r.per_unit === null ? '—' : m(r.per_unit) + ' ₸'),
  ])}
  </tbody>
</table></div>

<h3>Больше всего оставляют с одной штуки</h3>
<div class="scroll"><table>
  <thead><tr><th>Позиция</th><th class="n">Шт</th><th class="n">С штуки</th><th class="n">Всего за неделю</th></tr></thead>
  <tbody>
  ${rows(byUnit.slice(0, 8), (r) => ['<td>' + esc(short(r.name, 54)) + '</td>', n(r.qty), n(m(r.per_unit) + ' ₸'), n(m(r.net) + ' ₸')])}
  </tbody>
</table></div>

<h3>Меньше всего — стоит посмотреть на цену</h3>
<div class="scroll"><table>
  <thead><tr><th>Позиция</th><th class="n">Шт</th><th class="n">С штуки</th><th class="n">Наценка</th></tr></thead>
  <tbody>
  ${rows(weak, (r) => ['<td>' + esc(short(r.name, 54)) + '</td>', n(r.qty), n(m(r.per_unit) + ' ₸'), n(r.markup === null ? '—' : r.markup.toFixed(0) + '%')])}
  </tbody>
</table></div>

<h2>Что изменилось за неделю</h2>
<div class="scroll"><table>
  <thead><tr><th>Выросли</th><th class="n">Было</th><th class="n">Стало</th><th class="n">Разница</th></tr></thead>
  <tbody>
  ${rows(up, (r) => ['<td>' + esc(short(r.name, 50)) + (r.fresh ? ' <span class="muted">(новая)</span>' : '') + '</td>',
    n(m(r.was_revenue) + ' ₸'), n(m(r.revenue) + ' ₸'), '<td class="n"><span class="chip up">+' + esc(m(r.d_revenue)) + ' ₸</span></td>'])}
  </tbody>
</table></div>
<div class="scroll"><table>
  <thead><tr><th>Просели</th><th class="n">Было</th><th class="n">Стало</th><th class="n">Разница</th></tr></thead>
  <tbody>
  ${rows(down, (r) => ['<td>' + esc(short(r.name, 50)) + '</td>',
    n(m(r.was_revenue) + ' ₸'), n(m(r.revenue) + ' ₸'), '<td class="n"><span class="chip down">−' + esc(m(-r.d_revenue)) + ' ₸</span></td>'])}
  </tbody>
</table></div>
${d.disappeared.length ? `
<h3>Продавались на прошлой неделе и не продались ни разу на этой</h3>
<div class="scroll"><table>
  <thead><tr><th>Позиция</th><th class="n">Было за неделю</th><th class="n">Штук</th></tr></thead>
  <tbody>
  ${rows(d.disappeared.slice(0, 10), (r) => ['<td>' + esc(short(r.name, 54)) + '</td>', n(m(r.revenue) + ' ₸'), n(r.qty)])}
  </tbody>
</table></div>` : ''}

<h2>Категории</h2>
<div class="scroll"><table>
  <thead><tr><th>Категория</th><th class="n">Выручка</th><th class="n">Доля</th><th class="n">Штук</th><th class="n">Коробок</th><th class="n">Средняя цена</th><th class="n">Остаётся</th></tr></thead>
  <tbody>
  ${rows(d.categories, (c) => ['<td>' + esc(c.category) + '</td>', n(m(c.revenue) + ' ₸'),
    n(pct(c.revenue, M.revenue).toFixed(0) + '%'), n(c.qty),
    // коробки посчитаны не по всей категории — подписываем, по какой её части
    (c.qtyBoxed
      ? '<td class="n">' + c.boxes +
        (c.qtyBoxed < c.qty ? ' <span class="muted">за ' + c.qtyBoxed + ' шт</span>' : '') + '</td>'
      : n('—')),
    n(m(c.revenue / (c.qty || 1)) + ' ₸'),
    n(c.known ? m(c.net) + ' ₸' : '—')])}
  </tbody>
</table></div>

<h2>Места на карточках</h2>
${d.rank.days.length < 2 ? '<p>Срезов за неделю меньше двух — сравнивать не с чем.</p>' : `
<p>Замеры ${esc(d.rank.first)} → ${esc(d.rank.last)} по <strong>${esc(d.rank.cities)}</strong> городам.
   Место на карточке считается отдельно для каждого города: список продавцов Kaspi собирает под город
   покупателя, и кто туда не возит — в нём не появляется. Поэтому «первое место» без города ничего не значит.</p>
<div class="grid">
  ${kpi('Первые везде', m(d.rank.firstEverywhere), 'поз.', 'во всех ' + d.rank.cities + ' городах', 'up')}
  ${kpi('Первые хоть где-то', m(d.rank.firstSomewhere), 'поз.', 'минимум в одном городе')}
  ${kpi('Ниже десятого', m(d.rank.deep.length), 'поз.', 'хоть в одном городе', d.rank.deep.length ? 'down' : 'up')}
  ${kpi('Пропали везде', m(d.rank.gone.length), 'поз.', 'предложения нет ни в одном городе', d.rank.gone.length ? 'down' : 'up')}
</div>
<div class="scroll"><table>
  <thead><tr><th>Позиция</th><th class="n">Первых городов</th><th class="n">Лучшее / худшее место</th><th class="n">Наша цена</th><th class="n">Лучшая на карточке</th><th>Кто дешевле</th></tr></thead>
  <tbody>
  ${rows(d.rank.moves.slice(0, 14), (r) => [
    '<td>' + esc(short(r.name, 48)) + '</td>',
    '<td class="n"><span class="chip ' + (r.shift > 0 ? 'up' : 'down') + '">' + esc(r.first_was + ' → ' + r.first_now + ' из ' + r.cities_total) + '</span></td>',
    n((r.place_now ?? '—') + ' / ' + (r.worst_now ?? 'нет')),
    n(r.price_was !== r.price_now ? m(r.price_was) + ' → ' + m(r.price_now) : m(r.price_now)),
    n(r.best_price === null ? '—' : m(r.best_price) + ' ₸'),
    '<td class="muted">' + esc(r.best_price && r.price_now && r.best_price < r.price_now ? (r.best_seller || '') : '') + '</td>',
  ])}
  </tbody>
</table></div>
${d.rank.gone.length ? '<p><strong>Пропали со всех городов:</strong> ' + d.rank.gone.map((r) => esc(short(r.name, 34))).join(', ') + '.</p>' : ''}
${d.rank.deep.length ? `
<h3>Ниже десятого места хотя бы в одном городе</h3>
<div class="scroll"><table>
  <thead><tr><th>Позиция</th><th class="n">Худшее место</th><th class="n">Лучшее</th><th class="n">Первых городов</th><th class="n">Продавцов</th><th class="n">Наша цена</th><th class="n">Лучшая</th></tr></thead>
  <tbody>
  ${rows(d.rank.deep.slice(0, 10), (r) => ['<td>' + esc(short(r.name, 48)) + '</td>', n(r.worst_now), n(r.place_now ?? '—'), n(r.first_now + ' из ' + r.cities_total), n(r.offers_total), n(m(r.price_now) + ' ₸'), n(r.best_price === null ? '—' : m(r.best_price) + ' ₸')])}
  </tbody>
</table></div>` : ''}`}

<h2>Отмены, возвраты, рассрочка</h2>
<div class="scroll"><table>
  <thead><tr><th>Причина отмены</th><th class="n">Штук</th><th class="n">Сумма</th><th>Чья</th></tr></thead>
  <tbody>
  ${rows(d.cancelNow, (c) => ['<td>' + esc(c.ru) + '</td>', n(c.n), n(m(c.sum) + ' ₸'),
    '<td class="' + (c.ours ? '' : 'muted') + '">' + (c.ours ? '<span class="chip down">наша</span>' : 'покупателя') + '</td>'])}
  </tbody>
</table></div>
<p>Возвратов за неделю: <strong>${esc(a.returned)}</strong>.
   По нашей вине отменено <strong>${esc(ourFault)}</strong> из ${esc(a.cancelled)} — только эта часть чинится работой склада,
   остальное решает покупатель.</p>
<div class="scroll"><table>
  <thead><tr><th>Как платили</th><th class="n">Заказов</th><th class="n">Сумма</th><th class="n">Средний чек</th></tr></thead>
  <tbody>
  ${rows(d.now.terms, (t) => ['<td>' + esc(t.term === 'предоплата' ? 'предоплата' : 'рассрочка ' + t.term + ' мес') + '</td>',
    n(t.n), n(m(t.sum) + ' ₸'), n(m(t.sum / (t.n || 1)) + ' ₸')])}
  </tbody>
</table></div>

<h2>Логистика</h2>
<div class="grid">
  ${kpi('Отгружено', m(d.log.shipped), 'зак.', 'за неделю')}
  ${kpi('Срок отгрузки', (num(d.log.median_hours) / 24).toFixed(1), 'сут', 'медиана; девять из десяти за ' + (num(d.log.p90_hours) / 24).toFixed(1) + ' сут')}
  ${kpi('Дольше недели', m(d.log.over_week), 'зак.', 'хвост, из которого растут отмены', num(d.log.over_week) > 0 ? 'down' : 'up')}
  ${kpi('Накладная не вышла', m(d.log.waybill_failed), 'зак.', 'Kaspi не отдал PDF')}
</div>
${d.log.stuck.length ? `
<h3>Висят в работе дольше двух дней</h3>
<div class="scroll"><table>
  <thead><tr><th>Заказ</th><th>Магазин</th><th>День</th><th>Стадия</th><th class="n">Сумма</th></tr></thead>
  <tbody>
  ${rows(d.log.stuck, (s) => ['<td class="muted">' + esc(s.order_code) + '</td>', '<td>' + esc(s.store) + '</td>', '<td>' + esc(s.d) + '</td>', '<td>' + esc(s.stage) + '</td>', n(m(s.total) + ' ₸')])}
  </tbody>
</table></div>` : ''}

${d.alerts.length ? `
<h2>Тревоги за неделю</h2>
<div class="scroll"><table>
  <thead><tr><th>Когда</th><th>Что</th></tr></thead>
  <tbody>
  ${rows(d.alerts, (x) => ['<td class="muted">' + esc(x.created_at.slice(0, 16)) + '</td>',
    '<td><strong>' + esc(x.title) + '</strong><div class="muted" style="white-space:pre-line;font-size:13px">' + esc(x.message) + '</div></td>'])}
  </tbody>
</table></div>` : ''}

<h2>Реклама и продажи</h2>
${!d.ads.usd ? '<p>За эту неделю на рекламу не потрачено ничего.</p>' : `
<div class="grid">
  ${kpi('Расход', m(d.ads.kzt), '₸', d.ads.usd.toFixed(2) + ' $ · ' + d.payback.share.toFixed(2) + '% выручки')}
  ${kpi('Переходов', m(d.ads.clicks), '', 'по ' + m(d.ads.cpc) + ' ₸ · CTR ' + (d.ads.ctr || 0).toFixed(2) + '%')}
  ${kpi('Нужно заказов', d.payback.ordersNeeded === null ? '—' : d.payback.ordersNeeded.toFixed(1), '', 'чтобы вернуть вложенное — ' + (d.payback.ordersNeededShare === null ? '—' : d.payback.ordersNeededShare.toFixed(1) + '% всех заказов'))}
  ${kpi('Нужна конверсия', d.payback.conversionNeeded === null ? '—' : d.payback.conversionNeeded.toFixed(2) + '%', '',
    'замеренная у карточки ' + d.payback.conversionMeasured + '%',
    d.payback.conversionNeeded !== null && d.payback.conversionNeeded < d.payback.conversionMeasured ? 'up' : 'down')}
</div>

<div class="note">
  <strong>ROAS по этой рекламе посчитать нельзя, и это не пробел в данных.</strong>
  Пиксель на Kaspi не поставить — это чужой сайт, поэтому ни одна покупка не привязана
  к объявлению. Валовый ROAS ${esc(d.payback.grossRoas === null ? '—' : m(d.payback.grossRoas))} ₸ выручки
  на вложенный тенге печатаем только как масштаб: он приписывает рекламе всю выручку, включая
  заказы, которые пришли бы и без неё.
  Решение принимают по порогу: прибыль с заказа ${esc(m(d.payback.netPerOrder))} ₸, значит расход
  отбивают ${esc(d.payback.ordersNeeded === null ? '—' : d.payback.ordersNeeded.toFixed(1))} заказов,
  а для этого нужна конверсия перехода ${esc(d.payback.conversionNeeded === null ? '—' : d.payback.conversionNeeded.toFixed(2) + '%')}.
  ${d.payback.conversionNeeded !== null && d.payback.conversionNeeded < d.payback.conversionMeasured
    ? 'Замеренная конверсия нашей карточки — ' + d.payback.conversionMeasured + '%, то есть порог взят с запасом в '
      + (d.payback.conversionMeasured / d.payback.conversionNeeded).toFixed(1) + ' раза.'
    : 'Замеренная конверсия нашей карточки — ' + d.payback.conversionMeasured + '%, то есть такой расход не отбивается.'}
</div>

<h3>Куда вела реклама</h3>
<p>Назначение берём у группы объявлений, а не цель у кампании: цель задаётся на кампании,
   назначение — на группе, и они расходятся молча. Переходы в профиль Instagram и в переписку
   до карточки Kaspi не доходят.</p>
<div class="scroll"><table>
  <thead><tr><th>Направление</th><th class="n">Расход</th><th class="n">Доля</th><th class="n">Переходов</th><th class="n">Цена перехода</th><th class="n">CTR</th><th class="n">Кампаний</th></tr></thead>
  <tbody>
  ${rows(d.ads.dest, (x) => ['<td>' + esc(x.destination) + '</td>', n(m(x.kzt) + ' ₸'),
    n(pct(x.usd, d.ads.usd).toFixed(0) + '%'), n(m(x.clicks)), n(m(x.cpc) + ' ₸'),
    n((x.ctr || 0).toFixed(2) + '%'), n(x.campaigns)])}
  </tbody>
</table></div>`}

<h3>Реклама и выручка по неделям</h3>
<p>Восемь недель подряд. Расход на рекламу скачет в разы, выручка — нет: если бы связь была,
   столбцы шли бы рядом.</p>
<div class="scroll"><table>
  <thead><tr><th>Неделя</th><th class="n">Расход</th><th class="n">Выручка</th><th class="n">Доля расхода</th><th class="n">Заказов</th><th class="n">Валовый ROAS</th></tr></thead>
  <tbody>
  ${rows(d.adsWeeks, (w) => ['<td>' + esc(human(w.from) + ' — ' + human(w.to)) + '</td>',
    n(w.kzt ? m(w.kzt) + ' ₸' : '—'), n(m(w.revenue) + ' ₸'),
    n(w.kzt ? w.share.toFixed(2) + '%' : '—'), n(w.orders),
    n(w.roas === null ? '—' : m(w.roas))])}
  </tbody>
</table></div>
<h3>Реклама и выручка по месяцам</h3>
<p>Вся история расхода. На месяцах видно главное: самый большой расход и самая большая выручка
   приходятся на разные месяцы.</p>
<div class="scroll"><table>
  <thead><tr><th>Месяц</th><th class="n">Расход</th><th class="n">Переходов</th><th class="n">Выручка</th><th class="n">Доля расхода</th><th class="n">Заказов</th><th class="n">Валовый ROAS</th></tr></thead>
  <tbody>
  ${rows(d.adsMonths, (w) => ['<td>' + esc(w.mon) + '</td>', n(m(w.kzt) + ' ₸'), n(m(w.clicks)),
    n(m(w.revenue) + ' ₸'), n(w.share.toFixed(2) + '%'), n(w.orders), n(w.roas === null ? '—' : m(w.roas))])}
  </tbody>
</table></div>
<p class="muted">Курс пересчёта — ${esc(d.USD_KZT)} ₸ за доллар. Meta выставляет счёт в долларах;
   на долях процента оборота точность курса ничего не меняет.</p>

<h2>Чего не хватает в данных</h2>
<p>Отчёт обязан говорить, по какой части он молчит. Иначе «прибыль за неделю» читается как факт,
   хотя посчитана по тем позициям, у которых есть код технолога.</p>
<div class="grid">
  ${kpi('Себестоимость', g.prod.linked + ' / ' + g.prod.total, 'арт.', 'артикулов Kaspi с кодом технолога')}
  ${kpi('Изделия склада', g.wh.linked + ' / ' + g.wh.total, '', 'привязано к коду')}
  ${kpi('Цена не снялась', m(g.prod.no_price), 'арт.', 'нашего предложения нет на карточке')}
  ${kpi('Замер мест', m(g.rank.n), 'поз.', 'последний ' + g.rank.d)}
</div>

<h2>Что с этим делать</h2>
<ul class="todo">
  ${d.rank.gone.length ? '<li>Вернуть в продажу пропавшие с карточек: ' + d.rank.gone.map((r) => esc(short(r.name, 30))).join(', ') + '.</li>' : ''}
  ${d.rank.moves.filter((r) => r.shift < 0 && r.price_now > r.price_was).slice(0, 3).map((r) =>
    '<li>' + esc(short(r.name, 44)) + ': цену подняли ' + esc(m(r.price_was)) + ' → ' + esc(m(r.price_now)) +
    ', первых городов стало ' + esc(r.first_now) + ' вместо ' + esc(r.first_was) + '. Вернуть или смириться.</li>').join('')}
  ${d.disappeared.slice(0, 3).map((r) => '<li>Проверить остаток: ' + esc(short(r.name, 40)) + ' давала ' + esc(m(r.revenue)) + ' ₸ в неделю и перестала.</li>').join('')}
  ${d.rank.deep.slice(0, 2).map((r) => '<li>' + esc(short(r.name, 40)) + ' в худшем городе стоит ' + esc(r.worst_now) + '-м из ' + esc(r.offers_total) +
    '. Либо цена ' + esc(r.best_price === null ? '' : 'ниже ' + m(r.best_price) + ' ₸') + ', либо позиция не нужна.</li>').join('')}
  ${g.prod.total - g.prod.linked > 0 ? '<li>Проставить коды технолога оставшимся ' + esc(g.prod.total - g.prod.linked) + ' артикулам — тогда прибыль будет считаться по всей выручке, а не по ' + esc(M.coverage.toFixed(0)) + '%.</li>' : ''}
  ${num(d.log.over_week) > 0 ? '<li>Разобрать ' + esc(d.log.over_week) + ' заказ(ов), которые отгружались дольше недели.</li>' : ''}
</ul>

<footer>
  Собрано ${esc(new Date(d.generated).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }))} по алматинскому времени
  из боевой базы: заказы Kaspi, фактическая доставка из самих заказов, себестоимость технолога,
  ежедневный замер мест на карточках. Комиссия Kaspi взята ставкой 11,75%.
</footer>

</div>
</body>
</html>`;
}

module.exports = { renderText, renderHtml };
