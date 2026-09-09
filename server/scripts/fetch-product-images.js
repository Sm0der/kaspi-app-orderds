// Подобрать картинки товарам, у которых их ещё нет.
//
//   node scripts/fetch-product-images.js            # показать, что нашлось
//   node scripts/fetch-product-images.js --apply    # записать найденное в products
//
// Запускать ВРУЧНУЮ и не с сервера: публичный каталог Kaspi блокирует IP Vercel
// (подробности в services/kaspiCatalog.js). Нужен DATABASE_URL от нужной базы.
//
// Сопоставление точное - через merchantSku в предложениях карточки, а не по названию:
// у одной модели бывает пять цветовых вариантов, и подстановка «похожей» картинки
// хуже, чем её отсутствие. Товар, для которого точного совпадения не нашлось,
// остаётся без картинки и попадает в список в конце.
require('dotenv').config();
const db = require('../db/init');
const { searchCards, cardOffers, cardImage } = require('../services/kaspiCatalog');

const APPLY = process.argv.includes('--apply');

// Собственные торговые марки магазинов - ими же имеет смысл начинать обход каталога
const STORE_QUERIES = {
  1: ['Кухни kz'],
  2: ['Art Room Home']
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function collectCards(queries) {
  const cards = new Map();
  for (const query of queries) {
    // Поиск отдаёт две-три страницы и потом отвечает 400 - это нормально, просто конец выдачи
    for (let page = 0; page < 3; page++) {
      let found;
      try {
        found = await searchCards(query, page);
      } catch {
        break;
      }
      if (found.length === 0) break;
      for (const card of found) if (cardImage(card)) cards.set(String(card.id), card);
      await sleep(300);
    }
  }
  return cards;
}

(async () => {
  const { rows } = await db.query(
    'SELECT store_id, sku, name FROM products WHERE image_url IS NULL ORDER BY store_id, sku'
  );
  if (rows.length === 0) {
    console.log('Все товары уже с картинками.');
    process.exit(0);
  }

  const byStore = new Map();
  for (const product of rows) {
    if (!byStore.has(product.store_id)) byStore.set(product.store_id, new Map());
    byStore.get(product.store_id).set(String(product.sku), product);
  }

  let total = 0;

  for (const [storeId, products] of byStore) {
    console.log(`\n=== магазин ${storeId}: ищем ${products.size} артикулов`);

    // Запросы: бренд магазина плюс название каждого ненайденного товара. Поиск нечёткий,
    // но это не важно - лишние карточки отсеются на сверке артикула.
    const queries = [...(STORE_QUERIES[storeId] || []), ...[...products.values()].map(p => p.name)];
    const cards = await collectCards(queries);
    console.log(`карточек-кандидатов: ${cards.size}`);

    for (const card of cards.values()) {
      if (products.size === 0) break;

      let offers;
      try {
        offers = await cardOffers(card.id);
      } catch (error) {
        console.log(`  ! карточка ${card.id}: ${error.message}`);
        continue;
      }

      for (const offer of offers) {
        const product = products.get(String(offer.merchantSku));
        if (!product) continue;

        console.log(`НАШЁЛ  ${product.sku}  ${product.name.trim().slice(0, 40)}  ->  ${card.title.slice(0, 60)}`);
        if (APPLY) {
          await db.query(
            'UPDATE products SET image_url = $1, updated_at = NOW() WHERE store_id = $2 AND sku = $3',
            [cardImage(card), storeId, product.sku]
          );
        }
        products.delete(String(offer.merchantSku));
        total++;
      }
      await sleep(250);
    }

    for (const product of products.values()) {
      console.log(`нет    ${product.sku}  ${product.name.trim().slice(0, 55)}`);
    }
  }

  console.log(`\nНашли ${total} из ${rows.length}${APPLY ? ' и записали в базу' : ' (пробный прогон, ничего не записано)'}`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
