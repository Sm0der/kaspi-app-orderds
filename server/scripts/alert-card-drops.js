// Тревога по карточкам: что перестало продаваться и почему.
//
//   node scripts/alert-card-drops.js          # показать тревоги
//   node scripts/alert-card-drops.js --quiet  # только записать, без разбора по полкам
//
// Запускается сразу после fetch-card-ranks.js (см. daily-ranks.cmd). Замер мест идёт
// каждое утро с 7 октября, но молча: 12 октября шкаф IMPERIAL Алёна исчез с карточки,
// и заметили это на пятый день - 760 тысяч тенге выручки.
//
// Место считается по четырём городам (CITIES в services/kaspiCatalog.js): список
// предложений Kaspi собирает под город покупателя, и одно число без города врёт.
// Поэтому тревожим не по «месту», а по тому, в скольких городах мы первые.
//
// Ловим три вещи, и вторая важнее первой:
//   1. позиция пропала из выдачи или провалилась ниже пятого места;
//   2. позиция ПРОДАВАЛАСЬ и перестала, даже если место на вид в порядке. У IMPERIAL
//      заказы кончились 8 октября, а с карточки она ушла 12-го - четыре дня разницы;
//   3. цену подняли, и место следом упало. Так было со шкафом для документов:
//      плюс тысяча тенге - минус первое место.
//
// Порог один: позиция должна продавать хотя бы полштуки в день за последние 30 дней.
// Ниже этого колебания места ничего не стоят, и тревожить незачем.
//
// Код выхода 1, если есть что показать - по нему daily-ranks.cmd выводит уведомление.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db/init');

const QUIET = process.argv.includes('--quiet');
const MIN_PER_DAY = 0.5;   // меньше — не тревожим
const DEEP_PLACE = 5;      // ниже этого места покупатель не доходит
const SILENT_DAYS = 3;     // столько дней без заказа у ходовой позиции — уже тревога

const money = (v) => Math.round(Number(v) || 0).toLocaleString('ru-RU');

(async () => {
  // Два последних среза. checked_day обязательно ::text - node-pg иначе сдвинет дату
  // на сутки по часовому поясу процесса.
  // По умолчанию два последних среза. Можно задать свои: --days=2026-10-09,2026-10-12 -
  // так проверяют, поймала бы тревога уже случившееся.
  const arg = process.argv.find((a) => a.startsWith('--days='));
  let today, prev;
  if (arg) {
    const [a, b] = arg.slice(7).split(',');
    [prev, today] = [a, b];
    if (!a || !b) { console.log('Нужно два дня: --days=ГГГГ-ММ-ДД,ГГГГ-ММ-ДД'); process.exit(2); }
  } else {
    const { rows: days } = await db.query(
      `SELECT DISTINCT checked_day::text AS d FROM product_card_rank_history
       ORDER BY d DESC LIMIT 2`
    );
    if (days.length < 2) {
      console.log('Срезов меньше двух - сравнивать не с чем.');
      await db.pool.end();
      return;
    }
    [today, prev] = [days[0].d, days[1].d];
  }

  // Продажи считаем ПО КАРТОЧКЕ, а не по паре «магазин + артикул». Позиции переезжают
  // между двумя нашими магазинами с новым артикулом: 9 октября ассортимент ушёл из
  // КухниKZ в ART ROOM, и счёт по артикулу показал бы шесть мёртвых бестселлеров там,
  // где товар просто продаётся из другой витрины. Номер карточки лежит в заказе:
  // order_items.raw_data.relationships.product.data.id (см. CLAUDE.md).
  //
  // Место при этом остаётся своим у каждого магазина: на одной карточке мы стоим дважды.
  const { rows } = await db.query(
    `WITH sales AS (
       -- в заказе номер карточки лежит в base64 («MTA4NDMwOTQ1»), а в замере мест
       -- обычным числом («108430945») — иначе ничего не сойдётся
       SELECT convert_from(decode(oi.raw_data->'relationships'->'product'->'data'->>'id', 'base64'), 'UTF8') AS card_id,
              SUM((oi.raw_data->'attributes'->>'quantity')::int)
                FILTER (WHERE to_timestamp((o.raw_data->'attributes'->>'creationDate')::bigint/1000)
                        >= NOW() - INTERVAL '30 days')::int AS qty30,
              SUM((oi.raw_data->'attributes'->>'totalPrice')::numeric)
                FILTER (WHERE to_timestamp((o.raw_data->'attributes'->>'creationDate')::bigint/1000)
                        >= NOW() - INTERVAL '30 days')::numeric AS sum30,
              MAX(to_timestamp((o.raw_data->'attributes'->>'creationDate')::bigint/1000)
                  AT TIME ZONE 'Asia/Almaty')::date AS last_sale
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.stage <> 'cancelled'
         AND to_timestamp((o.raw_data->'attributes'->>'creationDate')::bigint/1000) >= NOW() - INTERVAL '60 days'
       GROUP BY 1
     ),
     -- Одна карточка — две наши витрины И ЧЕТЫРЕ ГОРОДА. По витринам берём лучшее
     -- место (предложение одно, просто выставлено дважды), а города НЕ схлопываем
     -- в одно число: список предложений Kaspi собирает под город покупателя, и
     -- «первые в трёх городах из четырёх» — это не то же самое, что «первые».
     -- Поэтому считаем, в скольких городах мы первые и в скольких нас вовсе нет.
     per_city AS (
       SELECT card_id, checked_day, city_id, MIN(place) AS place
       FROM product_card_rank_history
       WHERE checked_day IN ($1::date, $2::date)
       GROUP BY 1, 2, 3
     ),
     best AS (
       SELECT card_id, checked_day,
              MIN(place) AS place,
              MAX(place) AS place_worst,
              COUNT(*) FILTER (WHERE place = 1)::int AS cities_first,
              COUNT(*) FILTER (WHERE place IS NULL)::int AS cities_absent,
              COUNT(*)::int AS cities_total
       FROM per_city GROUP BY 1, 2
     )
     SELECT s.name AS store, p.name,
            n.sku, n.card_id,
            bn.place AS place_now, bo.place AS place_was,
            bn.place_worst AS worst_now, bo.place_worst AS worst_was,
            bn.cities_first AS first_now, bo.cities_first AS first_was,
            bn.cities_absent AS absent_now, bo.cities_absent AS absent_was,
            bn.cities_total AS cities_total, bo.cities_total AS cities_was_total,
            n.our_price AS price_now, o.our_price AS price_was,
            n.best_price, n.offers_total,
            COALESCE(sa.qty30, 0) AS qty30, COALESCE(sa.sum30, 0) AS sum30,
            sa.last_sale::text AS last_sale,
            (CURRENT_DATE - sa.last_sale) AS silent_days
     FROM product_card_rank_history n
     JOIN product_card_rank_history o
       ON o.store_id = n.store_id AND o.sku = n.sku AND o.city_id = n.city_id
      AND o.checked_day = $2::date
     JOIN stores s ON s.id = n.store_id
     LEFT JOIN products p ON p.store_id = n.store_id AND p.sku = n.sku
     LEFT JOIN sales sa ON sa.card_id = n.card_id
     LEFT JOIN best bn ON bn.card_id = n.card_id AND bn.checked_day = $1::date
     LEFT JOIN best bo ON bo.card_id = n.card_id AND bo.checked_day = $2::date
     WHERE n.checked_day = $1::date
       -- Карточка попадает сюда ОДИН раз: цена и название у неё одни, а мест теперь
       -- четыре (по городу) и витрин две. Строку-представителя берём из наименьшего
       -- магазина и наименьшего города, а всё, что зависит от города, уже посчитано
       -- в best: сколько городов первых, в скольких нас нет, лучшее и худшее место.
       AND n.store_id = (SELECT MIN(store_id) FROM product_card_rank_history x
                         WHERE x.card_id = n.card_id AND x.checked_day = $1::date)
       AND n.city_id = (SELECT MIN(city_id) FROM product_card_rank_history x
                        WHERE x.card_id = n.card_id AND x.checked_day = $1::date
                          AND x.store_id = n.store_id)`,
    [today, prev]
  );

  const alerts = [];
  for (const r of rows) {
    const perDay = Number(r.qty30) / 30;
    if (perDay < MIN_PER_DAY) continue;

    const name = (r.name || r.sku || '?').replace(/\s+/g, ' ').trim();
    const lost = money(Number(r.sum30) / 30);

    const cities = Number(r.cities_total) || 1;
    // Сравнивать «первые в N городах» можно только когда городов в обоих срезах
    // поровну. 15.10.2026 замер стал четырёхгородским, и сравнение с однодневным
    // прошлым дало бы чушь в обе стороны. Такие дни молчат по городам, но правило
    // «продавалась и перестала» работает и там - оно про заказы, а не про место.
    const sameCoverage = Number(r.cities_was_total || r.cities_total) === cities;
    const priceUp = r.price_now && r.price_was && Number(r.price_now) > Number(r.price_was);
    const priceNote = priceUp ? `, цену подняли ${money(r.price_was)} → ${money(r.price_now)}` : '';

    // Пропала — значит пропала ВЕЗДЕ. Исчезновение в одном городе из четырёх это не
    // «сняли с продажи», а «в этот город кто-то начал возить»; оно ловится ниже.
    if (sameCoverage && Number(r.absent_now) === cities && Number(r.absent_was) < cities) {
      alerts.push({
        level: 1,
        head: 'ПРОПАЛА С КАРТОЧКИ',
        name, store: r.store,
        why: `нашего предложения нет ни в одном из ${cities} городов — снято с продажи или кончился остаток`,
        lost,
      });
      continue;
    }

    // Потеряли первое место в городах. Это и есть главный сигнал: «место 2» в среднем
    // по больнице ничего не говорит, а «были первыми в четырёх городах, стали в одном» —
    // говорит всё.
    if (sameCoverage && Number(r.first_was) > Number(r.first_now)) {
      alerts.push({
        level: 2,
        head: 'ПОТЕРЯЛИ ПЕРВОЕ МЕСТО',
        name, store: r.store,
        why: `были первыми в ${r.first_was} городах из ${cities}, стали в ${r.first_now}` +
             `. Худшее место ${r.worst_now ?? 'нет предложения'}${priceNote}`,
        lost,
      });
      continue;
    }

    // Провалились глубоко хотя бы где-то: ниже пятого места покупатель не доходит.
    if (sameCoverage && r.worst_now !== null && r.worst_was !== null &&
        r.worst_now > DEEP_PLACE && r.worst_now - r.worst_was >= 2) {
      alerts.push({
        level: 2,
        head: 'ПРОВАЛИЛАСЬ В ВЫДАЧЕ',
        name, store: r.store,
        why: `худшее место ${r.worst_was} → ${r.worst_now} из ${r.offers_total}` +
             `, первые в ${r.first_now} городах из ${cities}${priceNote}`,
        lost,
      });
      continue;
    }

    if (r.silent_days !== null && Number(r.silent_days) >= SILENT_DAYS && perDay >= 1) {
      alerts.push({
        level: 2,
        head: 'ПРОДАВАЛАСЬ И ПЕРЕСТАЛА',
        name, store: r.store,
        why: `последний заказ ${r.last_sale}, это ${r.silent_days} дн. назад, а раньше брали ` +
             `${perDay.toFixed(1)} шт в день. Первые в ${r.first_now} городах из ${cities}, ` +
             `худшее место ${r.worst_now ?? 'нет предложения'} — проверить остаток и цену`,
        lost,
      });
      continue;
    }

    if (priceUp && r.worst_now !== null && r.worst_was !== null && r.worst_now > r.worst_was) {
      alerts.push({
        level: 3,
        head: 'цену подняли — место упало',
        name, store: r.store,
        why: `${money(r.price_was)} → ${money(r.price_now)} ₸, худшее место ${r.worst_was} → ${r.worst_now}` +
             (r.best_price ? `, лучшая на карточке ${money(r.best_price)}` : ''),
        lost,
      });
    }
  }

  alerts.sort((a, b) => a.level - b.level || Number(String(b.lost).replace(/\D/g, '')) - Number(String(a.lost).replace(/\D/g, '')));

  const logDir = path.join(__dirname, '..', 'logs');
  const alertFile = path.join(logDir, 'card-alert.txt');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* уже есть */ }

  // Разрыв между срезами печатаем всегда: компьютер владельца на выходных выключен,
  // замер пропускается, и понедельничное сравнение идёт с пятницей. Это нормально,
  // но «за сутки» и «за трое суток» - разные новости, и путать их нельзя.
  const gapDays = Math.round((new Date(today + 'T00:00:00Z') - new Date(prev + 'T00:00:00Z')) / 86400000);
  const span = gapDays > 1 ? ` (за ${gapDays} дн., замер пропускался)` : '';

  if (alerts.length === 0) {
    console.log(`Сравнение ${prev} → ${today}${span}: всё на местах, ходовые позиции продаются.`);
    try { fs.unlinkSync(alertFile); } catch { /* его и не было */ }
    await db.pool.end();
    return;
  }

  const head = alerts.filter((a) => a.level === 1).length
    ? `${alerts.filter((a) => a.level === 1).length} позиц. пропало с карточек`
    : `${alerts.length} позиц. требует внимания`;
  const firstLines = alerts.slice(0, 3).map((a) => `${a.name} — ${a.lost} ₸/день`).join('; ');
  fs.writeFileSync(alertFile, head + '\n' + firstLines, 'utf8');

  if (!QUIET) {
    console.log(`\nТРЕВОГА ПО КАРТОЧКАМ  (${prev} → ${today})\n`);
    for (const a of alerts) {
      console.log(`  [${a.head}]  ${a.name}  (${a.store})`);
      console.log(`     ${a.why}`);
      console.log(`     продавала на ${a.lost} ₸ в день\n`);
    }
  }

  await db.query(
    `INSERT INTO notifications (title, message, data, sent_count)
     VALUES ($1, $2, $3, 0)`,
    [
      'Карточки Kaspi: ' + head,
      alerts.map((a) => `${a.head}: ${a.name} (${a.store}) — ${a.why}. ${a.lost} ₸/день`).join('\n'),
      JSON.stringify({ kind: 'card-drop', day: today, prev, alerts }),
    ]
  );

  console.log(`Записано в уведомления: ${alerts.length}. Файл для оповещения: ${alertFile}`);
  await db.pool.end();
  process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
