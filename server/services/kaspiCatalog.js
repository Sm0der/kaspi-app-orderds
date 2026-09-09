const axios = require('axios');

// Официальный API продавца (kaspiService.js) отдаёт картинку только в одну сторону -
// когда сам продавец ЗАГРУЖАЕТ товар (поле images:[{url}] в фиде). Прочитать картинку по
// артикулу уже существующего товара через него нельзя. Зато у Kaspi есть публичный поиск
// (тот же, что видит покупатель на сайте) - он не требует токена и по точному артикулу
// почти всегда возвращает ровно одну карточку с готовыми ссылками на CDN.
const SEARCH_URL = 'https://kaspi.kz/yml/product-view/pl/filters';
const MAX_RETRIES = 2;
const RETRY_DELAY = 800;

const client = axios.create({
  timeout: 15000,
  headers: {
    // Без правдоподобного User-Agent и Referer публичный поиск Kaspi отдаёт пустой ответ -
    // это не авторизация, а обычная защита от простейших ботов.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://kaspi.kz/shop/search/'
  }
});

// Найти картинку товара по артикулу (коду оффера) через публичный поиск Kaspi.
// Возвращает null, если товар не нашёлся или совпадение неточное - лучше остаться
// без картинки, чем случайно подставить чужую по похожему запросу (поиск нечёткий).
async function findImageBySku(sku) {
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await client.get(SEARCH_URL, {
        params: { text: sku, page: 0, all: false, fl: true, ui: 'd' }
      });
      const data = response.data;

      const cards = data?.data?.cards || [];
      const exact = cards.find(c => String(c.configSku) === String(sku) || String(c.id) === String(sku));

      // ВРЕМЕННАЯ диагностика: production (30/30 не нашлись) резко разошлась с ручной
      // проверкой тех же артикулов (5/8 нашлись) - похоже на разницу в реакции Kaspi на
      // адрес Vercel против обычного адреса, а не на логику сопоставления. Снять после
      // того, как причина будет понятна по этим логам.
      console.log(
        `[kaspiCatalog] sku=${sku} status=${response.status} contentType=${response.headers['content-type']} ` +
        `cards=${cards.length} exact=${!!exact} ids=[${cards.slice(0, 3).map(c => c.id).join(',')}]`
      );

      if (!exact) return null;

      const image = exact.previewImages?.[0];
      return image ? { imageUrl: image.medium || image.large || image.small, title: exact.title } : null;
    } catch (error) {
      attempt++;
      const status = error.response?.status;
      const retriable = !error.response || status === 429 || status >= 500;

      console.log(
        `[kaspiCatalog] sku=${sku} ОШИБКА status=${status ?? 'нет ответа'} ` +
        `code=${error.code || '-'} message=${error.message} ` +
        `body=${JSON.stringify(error.response?.data).slice(0, 200)}`
      );

      if (!retriable || attempt >= MAX_RETRIES) {
        throw new Error(status ? `Kaspi ответил ${status}` : error.message);
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY * attempt));
    }
  }
}

module.exports = { findImageBySku };
