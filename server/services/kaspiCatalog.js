const axios = require('axios');

// Официальный API продавца (kaspiService.js) отдаёт картинку только в одну сторону -
// когда сам продавец ЗАГРУЖАЕТ товар (поле images:[{url}] в фиде). Прочитать картинку по
// артикулу уже существующего товара через него нельзя. Зато у Kaspi есть две публичные
// ручки, которыми пользуется сайт для покупателей, и вместе они дают точное сопоставление:
//
//   1. поиск (SEARCH_URL) - по любому тексту возвращает карточки товаров с картинками;
//   2. предложения карточки (OFFERS_URL) - список продавцов этой карточки, и у каждого
//      есть merchantSku, то есть СОБСТВЕННЫЙ артикул продавца, тот же, что приходит нам
//      в составе заказа.
//
// Поэтому подбор идёт так: ищем карточки (по названию товара и по бренду магазина),
// у каждой смотрим предложения и берём картинку только той карточки, где предложение
// нашего магазина имеет ровно наш артикул. Совпадение точное, гадать по названию не нужно -
// а гадать нельзя: у одного «Комода Венеция» пять цветовых вариантов с разными фото.
//
// ВАЖНО: эти ручки нельзя дёргать из самого приложения (Vercel) - Kaspi блокирует их
// по IP: 30 из 30 запросов подряд получили 429 с HTML-страницей защиты от ботов вместо
// JSON, с первой же попытки (проверено логами прямо с продакшена). Официальный API
// заказов при этом не блокируется - это разные системы защиты. С обычного адреса всё
// работает, поэтому пополнение каталога картинками делается разово вручную:
// node scripts/fetch-product-images.js (см. комментарий в начале скрипта).
const SEARCH_URL = 'https://kaspi.kz/yml/product-view/pl/filters';
const OFFERS_URL = 'https://kaspi.kz/yml/offer-view/offers';
const ALMATY_CITY_ID = '750000000';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1200;

const client = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://kaspi.kz/shop/search/'
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetries(request) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const status = error.response?.status;
      const retriable = !error.response || status === 429 || status >= 500;
      if (!retriable || attempt >= MAX_RETRIES) {
        throw new Error(status ? `Kaspi ответил ${status}` : error.message);
      }
      await sleep(RETRY_DELAY * attempt);
    }
  }
}

// Карточки публичного поиска по произвольному тексту
async function searchCards(text, page = 0) {
  return withRetries(async () => {
    const { data } = await client.get(SEARCH_URL, {
      params: { text, page, all: false, fl: true, ui: 'd' }
    });
    return data?.data?.cards || [];
  });
}

// Предложения продавцов по карточке: merchantId, merchantSku, цена
async function cardOffers(cardId) {
  return withRetries(async () => {
    const { data } = await client.post(
      `${OFFERS_URL}/${cardId}`,
      { cityId: ALMATY_CITY_ID, id: String(cardId), merchantUID: '', limit: 20, page: 0, sort: true, installationId: '-1' },
      { headers: { 'Content-Type': 'application/json', Referer: `https://kaspi.kz/shop/p/-${cardId}/` } }
    );
    return data?.offers || [];
  });
}

function cardImage(card) {
  const image = card.previewImages?.[0];
  return image ? (image.medium || image.large || image.small) : null;
}

module.exports = { searchCards, cardOffers, cardImage };
