// На каком месте наше предложение на общей карточке Kaspi.
//
//   node scripts/fetch-card-ranks.js            # показать, ничего не записывая
//   node scripts/fetch-card-ranks.js --apply    # записать и показать, что изменилось
//
// Запускать РАЗ В СУТКИ. Ответ на вопрос «где мы стоим» даёт и один замер, но нужный
// вопрос другой - «что изменилось со вчера». 07.10.2026 цену на InHome Comfort 4D
// подняли с 87 890 до 94 500, мы уехали со 2-го места на 8-е, и продажи упали с
// одиннадцати штук в день до двух; заметили это через двое суток. С --apply каждый
// запуск кладёт срез в product_card_rank_history и печатает разницу с прошлым.
//
// Запускать ВРУЧНУЮ и не с сервера: публичный каталог Kaspi блокирует IP Vercel
// (подробности в services/kaspiCatalog.js). Нужен DATABASE_URL от нужной базы.
//
// Что считаем местом. Карточку товара на Kaspi делят несколько продавцов, и список их
// предложений покупателю показывается отсортированным по цене. Место в этом списке и
// есть ответ на вопрос «какие мы по счёту»: первый - значит самый дешёвый и попадаем
// в кнопку «Купить», десятый - значит нас не видно без разворачивания списка.
//
// Своё предложение ищем по паре merchantId + merchantSku, как и цены: номер карточки и
// артикул продавца выглядят одинаковыми числами, но это разные вещи. Позиции переезжают
// между нашими двумя магазинами, поэтому своим считаем предложение любого нашего
// merchantId - иначе переехавший товар выглядел бы снятым с продажи.
require('dotenv').config();
const db = require('../db/init');
const { cardOffers } = require('../services/kaspiCatalog');

const APPLY = process.argv.includes('--apply');
// День по Алматы: замер делают утром по местному времени, а на сервере UTC - без
// сдвига утренний запуск попадал бы во вчерашний день.
const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const PAGES = 8; // 160 предложений - больше на карточке мебели не встречалось
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));

(async () => {
  const { rows } = await db.query(`
    WITH cards AS (
      -- Карточку берём из самого свежего заказа: товар мог переехать на другую
      SELECT o.store_id, oi.sku,
             (ARRAY_AGG(oi.raw_data->'relationships'->'product'->'data'->>'id'
                        ORDER BY o.order_date DESC NULLS LAST))[1] AS card_b64
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.raw_data->'relationships'->'product'->'data'->>'id' IS NOT NULL
      GROUP BY o.store_id, oi.sku
    )
    SELECT p.store_id, p.sku, p.name, p.price, s.name AS store_name,
           s.kaspi_merchant_uid AS merchant_uid, c.card_b64
    FROM products p
    JOIN stores s ON s.id = p.store_id
    JOIN cards c ON c.store_id = p.store_id AND c.sku = p.sku
    ORDER BY p.store_id, p.name`);

  const { rows: merchants } = await db.query(
    'SELECT kaspi_merchant_uid, name FROM stores WHERE kaspi_merchant_uid IS NOT NULL'
  );
  const ourMerchants = new Map(merchants.map((m) => [String(m.kaspi_merchant_uid), m.name]));

  const found = [];
  const absent = [];
  const errors = [];

  for (const product of rows) {
    const cardId = Buffer.from(product.card_b64, 'base64').toString('utf8');

    let offers = [];
    try {
      for (let page = 0; page < PAGES; page++) {
        const chunk = await cardOffers(cardId, page);
        offers = offers.concat(chunk);
        if (chunk.length < 20) break;
        await sleep(300);
      }
    } catch (error) {
      errors.push({ ...product, reason: `карточка ${cardId}: ${error.message}` });
      continue;
    }
    await sleep(300);

    // Kaspi отдаёт страницы уже отсортированными по цене, но страниц несколько, и
    // полагаться на порядок склейки нельзя - пересортируем сами по той же цене.
    const sorted = [...offers].sort((a, b) => Number(a.price) - Number(b.price));
    const index = sorted.findIndex((offer) => ourMerchants.has(String(offer.merchantId)));
    const rivals = sorted.filter((offer) => !ourMerchants.has(String(offer.merchantId)));
    const best = rivals.length ? rivals[0] : null;

    const row = {
      store_id: product.store_id,
      sku: product.sku,
      card_id: cardId,
      place: index >= 0 ? index + 1 : null,
      offers_total: sorted.length,
      our_price: index >= 0 ? Number(sorted[index].price) : null,
      best_price: best ? Number(best.price) : null,
      best_seller: best ? String(best.merchantName || best.merchantId).slice(0, 200) : null,
      name: product.name,
      store_name: product.store_name,
    };

    (row.place === null ? absent : found).push(row);
  }

  found.sort((a, b) => a.place - b.place || b.offers_total - a.offers_total);

  const width = 42;
  console.log(`\nНашли своё предложение: ${found.length}`);
  for (const r of found) {
    const gap = r.best_price !== null ? r.our_price - r.best_price : null;
    console.log(
      '  ' + String(r.place).padStart(3) + ' из ' + String(r.offers_total).padEnd(4) +
      r.name.slice(0, width).padEnd(width + 2) + r.store_name.padEnd(15) +
      money(r.our_price).padStart(10) +
      (gap === null ? '' : gap > 0 ? `   дешевле всех ${money(r.best_price)} (мы на ${money(gap)} дороже)` : '   мы самые дешёвые')
    );
  }

  if (absent.length) {
    console.log(`\nНашего предложения на карточке нет - снято с продажи или нет остатка (${absent.length}):`);
    for (const r of absent) {
      console.log('  ' + r.name.slice(0, width).padEnd(width + 2) + r.store_name.padEnd(15) +
        `${r.offers_total} чужих предложений на карточке ${r.card_id}`);
    }
  }

  if (errors.length) {
    console.log(`\nНе удалось спросить (${errors.length}):`);
    for (const r of errors) console.log('  ' + r.name.slice(0, width).padEnd(width + 2) + r.reason);
  }

  if (!APPLY) {
    console.log('\nЭто предпросмотр. Записать: node scripts/fetch-card-ranks.js --apply');
    await db.pool.end();
    return;
  }

  // Прошлый срез читаем ДО записи нового: иначе повторный запуск в тот же день
  // сравнивал бы сегодняшние цифры сами с собой и всегда показывал «без изменений».
  const { rows: previous } = await db.query(
    // checked_day обязательно ::text: node-pg превращает DATE в Date по поясу процесса,
    // и при печати через toISOString день уезжает на сутки назад.
    `SELECT *, checked_day::text AS day_text FROM product_card_rank_history
     WHERE checked_day = (
       SELECT MAX(checked_day) FROM product_card_rank_history WHERE checked_day < $1::date
     )`,
    [today]
  );
  const was = new Map(previous.map((r) => [`${r.store_id}:${r.sku}`, r]));

  for (const r of [...found, ...absent]) {
    await db.query(
      `INSERT INTO product_card_ranks
         (store_id, sku, card_id, place, offers_total, our_price, best_price, best_seller, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (store_id, sku) DO UPDATE SET
         card_id = EXCLUDED.card_id, place = EXCLUDED.place,
         offers_total = EXCLUDED.offers_total, our_price = EXCLUDED.our_price,
         best_price = EXCLUDED.best_price, best_seller = EXCLUDED.best_seller,
         checked_at = NOW()`,
      [r.store_id, r.sku, r.card_id, r.place, r.offers_total, r.our_price, r.best_price, r.best_seller]
    );
    await db.query(
      `INSERT INTO product_card_rank_history
         (checked_day, store_id, sku, card_id, place, offers_total, our_price, best_price, best_seller)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (checked_day, store_id, sku) DO UPDATE SET
         card_id = EXCLUDED.card_id, place = EXCLUDED.place,
         offers_total = EXCLUDED.offers_total, our_price = EXCLUDED.our_price,
         best_price = EXCLUDED.best_price, best_seller = EXCLUDED.best_seller`,
      [today, r.store_id, r.sku, r.card_id, r.place, r.offers_total, r.our_price, r.best_price, r.best_seller]
    );
  }
  console.log(`
Записано строк: ${found.length + absent.length}, день ${today}`);

  if (previous.length === 0) {
    console.log('Это первый сохранённый срез - сравнивать пока не с чем, завтра будет.');
    await db.pool.end();
    return;
  }

  // Разница с прошлым срезом. Печатаем только то, что сдвинулось: когда из ста с лишним
  // строк меняются три, их надо увидеть, а не искать глазами в полном списке.
  const changes = [];
  for (const r of [...found, ...absent]) {
    const b = was.get(`${r.store_id}:${r.sku}`);
    if (!b) continue;
    const notes = [];

    if (b.place !== null && r.place === null) notes.push('нашего предложения больше НЕТ на карточке');
    if (b.place === null && r.place !== null) notes.push(`снова на карточке, ${r.place}-е место`);
    if (b.place !== null && r.place !== null && r.place !== b.place) {
      notes.push(`${r.place > b.place ? 'УПАЛИ' : 'поднялись'} ${b.place} -> ${r.place} из ${r.offers_total}`);
    }

    const moved = (before, now) =>
      before !== null && now !== null && Math.round(Number(before)) !== Math.round(Number(now));
    if (moved(b.our_price, r.our_price)) {
      const diff = Number(r.our_price) - Number(b.our_price);
      notes.push(`наша цена ${money(b.our_price)} -> ${money(r.our_price)} (${diff > 0 ? '+' : ''}${money(diff)})`);
    }
    if (moved(b.best_price, r.best_price)) {
      notes.push(`рынок ${money(b.best_price)} -> ${money(r.best_price)}`);
    }

    if (notes.length) changes.push({ ...r, was: b, notes });
  }

  // Сверху то, где стало хуже: ушли с карточки или уехали вниз
  const worse = (x) =>
    (x.was.place !== null && x.place === null) ||
    (x.place !== null && x.was.place !== null && x.place > x.was.place);
  changes.sort((a, b) => (worse(b) ? 1 : 0) - (worse(a) ? 1 : 0));

  const since = previous[0].day_text;
  console.log(`
Изменилось с ${since}: ${changes.length} из ${found.length + absent.length}`);
  if (changes.length === 0) {
    console.log('  всё на своих местах');
  } else {
    for (const ch of changes) {
      console.log(
        `  ${worse(ch) ? '!' : ' '} ${ch.name.slice(0, 40).padEnd(42)}${ch.store_name.padEnd(15)}${ch.notes.join('; ')}`
      );
    }
  }

  await db.pool.end();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
