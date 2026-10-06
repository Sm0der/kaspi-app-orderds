// На каком месте наше предложение на общей карточке Kaspi.
//
//   node scripts/fetch-card-ranks.js            # показать, ничего не записывая
//   node scripts/fetch-card-ranks.js --apply    # записать в product_card_ranks
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
  }
  console.log(`\nЗаписано строк: ${found.length + absent.length}`);
  await db.pool.end();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
