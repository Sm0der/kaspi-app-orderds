// Забрать с Kaspi актуальные цены наших товаров.
//
//   node scripts/fetch-product-prices.js            # показать, что изменилось
//   node scripts/fetch-product-prices.js --apply    # записать цены в products
//
// Запускать ВРУЧНУЮ и не с сервера: публичный каталог Kaspi блокирует IP Vercel
// (подробности в services/kaspiCatalog.js). Нужен DATABASE_URL от нужной базы.
//
// Откуда берётся цена. Официальный API продавца отдаёт заказы, но не прайс, поэтому цену
// читаем из публичных предложений карточки - тех же, что видит покупатель. Карточку не
// ищем по названию: её номер лежит в самом заказе (relationships.product.data.id, base64),
// то есть Kaspi сам сказал, к какой карточке относится наш артикул. Дальше в списке
// предложений карточки берём СВОЁ: merchantId совпадает с kaspi_merchant_uid магазина,
// а merchantSku - с нашим артикулом. Номер карточки и артикул продавца выглядят как
// одинаковые числа, но это разные вещи (карточка 166513982, наш артикул на ней 335962720),
// поэтому сверяем именно по паре merchantId + merchantSku, без догадок.
//
// Если нашего предложения на карточке нет - товар снят с продажи или закончился; такой
// попадает в список в конце, а старая цена не затирается.
require('dotenv').config();
const db = require('../db/init');
const { cardOffers } = require('../services/kaspiCatalog');

const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));

(async () => {
  const { rows } = await db.query(`
    WITH cards AS (
      SELECT o.store_id, oi.sku,
             -- берём карточку из самого свежего заказа: товар мог переехать на другую
             (ARRAY_AGG(oi.raw_data->'relationships'->'product'->'data'->>'id'
                        ORDER BY o.order_date DESC NULLS LAST))[1] AS card_b64
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.raw_data->'relationships'->'product'->'data'->>'id' IS NOT NULL
      GROUP BY o.store_id, oi.sku
    )
    SELECT p.id, p.store_id, p.sku, p.name, p.price, s.name AS store_name,
           s.kaspi_merchant_uid AS merchant_uid, c.card_b64
    FROM products p
    JOIN stores s ON s.id = p.store_id
    LEFT JOIN cards c ON c.store_id = p.store_id AND c.sku = p.sku
    ORDER BY p.store_id, p.name`);

  const { rows: merchants } = await db.query(
    'SELECT kaspi_merchant_uid, name FROM stores WHERE kaspi_merchant_uid IS NOT NULL'
  );
  const ourMerchants = new Map(merchants.map((m) => [String(m.kaspi_merchant_uid), m.name]));

  const changed = [];
  const same = [];
  const missing = [];

  for (const product of rows) {
    if (!product.card_b64) {
      missing.push({ ...product, reason: 'товар ни разу не продавался - номера карточки нет' });
      continue;
    }
    const cardId = Buffer.from(product.card_b64, 'base64').toString('utf8');

    // Карточка отдаёт по 20 предложений за раз и сортирует их по цене. У ходовой модели
    // продавцов бывает под тридцать, и наше предложение легко оказывается на второй
    // странице - без обхода страниц мы решили бы, что товар снят с продажи.
    let offers = [];
    try {
      for (let page = 0; page < 6; page++) {
        const chunk = await cardOffers(cardId, page);
        offers = offers.concat(chunk);
        if (chunk.length < 20) break;
        await sleep(300);
      }
    } catch (error) {
      missing.push({ ...product, reason: `карточка ${cardId}: ${error.message}` });
      continue;
    }
    await sleep(300);

    // Карточка - это один товар, поэтому ищем по ней своё предложение, а не свой артикул:
    //   1) точное совпадение магазина и артикула - обычный случай;
    //   2) наш же магазин, но артикул другой - на Kaspi его пересоздали;
    //   3) второй наш магазин - позицию перенесли между своими юрлицами, а в каталоге
    //      осталась строка старого: заказов под новым ещё не было, и строку создать некому.
    let ours =
      offers.find(
        (offer) =>
          String(offer.merchantId) === String(product.merchant_uid) && String(offer.merchantSku) === String(product.sku)
      ) || offers.find((offer) => String(offer.merchantId) === String(product.merchant_uid));

    let movedTo = null;
    if (!ours) {
      const sibling = offers.find((offer) => ourMerchants.has(String(offer.merchantId)));
      if (sibling) {
        ours = sibling;
        movedTo = ourMerchants.get(String(sibling.merchantId));
      }
    }

    if (!ours || !(Number(ours.price) > 0)) {
      // Карточка жива, продавцов на ней много, а нашего нет: на Kaspi предложение либо
      // снято, либо кончился остаток - в выдаче такие не показываются вовсе.
      missing.push({
        ...product,
        reason: `нет нашего предложения среди ${offers.length} на карточке ${cardId} - снято или нет в наличии`,
      });
      continue;
    }

    // Минимум по карточке показываем для справки: видно, где мы дороже рынка.
    // В базу не пишем - это чужая цена, она живёт своей жизнью каждый день.
    const rivals = offers.filter((offer) => !ourMerchants.has(String(offer.merchantId)));
    const best = rivals.length ? Math.min(...rivals.map((offer) => Number(offer.price))) : null;
    const row = { ...product, newPrice: Number(ours.price), rivals: rivals.length, best, movedTo };

    if (Number(product.price) === Number(ours.price)) same.push(row);
    else changed.push(row);
  }

  const width = 44;
  console.log(`\nТовары с новой ценой: ${changed.length}`);
  for (const r of changed) {
    console.log(
      '  ' + r.name.slice(0, width).padEnd(width + 2) + r.store_name.padEnd(14) +
      (money(r.price) + ' → ' + money(r.newPrice)).padStart(22) +
      (r.movedTo ? '   продаёт ' + r.movedTo : '') +
      (r.best ? '   у конкурентов от ' + money(r.best) + (r.best < r.newPrice ? ' (мы дороже)' : '') : '')
    );
  }

  console.log(`\nЦена не изменилась: ${same.length}`);
  if (missing.length) {
    console.log(`\nНе удалось забрать (${missing.length}):`);
    for (const r of missing) {
      console.log('  ' + r.store_name.padEnd(15) + r.name.slice(0, width).padEnd(width + 2) + r.sku.padEnd(20) + r.reason);
    }
  }

  if (!APPLY) {
    console.log('\nЭто предпросмотр. Записать: node scripts/fetch-product-prices.js --apply');
    process.exit(0);
  }

  for (const r of changed) {
    await db.query('UPDATE products SET price = $1, updated_at = NOW() WHERE id = $2', [r.newPrice, r.id]);
  }
  console.log(`\nЗаписано цен: ${changed.length}`);
  process.exit(0);
})().catch((error) => {
  console.error('Не получилось:', error.message);
  process.exit(1);
});
