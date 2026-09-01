const https = require('https');

// Тестирование Kaspi API для получения информации о фото товаров
const API_TOKEN = process.env.KASPI_API_TOKEN || 'WOG5c0tinMjxjeT8DhNU/HOZAfCg7Xvc9Av9rQ4jUCM=';
const MERCHANT_ID = '17600'; // Нужно узнать ID магазина

console.log('🔍 Тестирование Kaspi API...\n');
console.log('Token (first 20 chars):', API_TOKEN.substring(0, 20) + '***\n');

function makeRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'kaspi.kz',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'KaspiOrdersApp/0.1.0'
      }
    };

    console.log(`📍 ${method} ${path}`);

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log(`✓ Status: ${res.statusCode}\n`);

        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            resolve(data);
          }
        } else {
          console.log('❌ Error response:');
          console.log(data);
          console.log('\n');
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ Request error:', e.message);
      reject(e);
    });

    req.end();
  });
}

async function testAPI() {
  try {
    // 1. Получить список заказов
    console.log('1️⃣ ПОЛУЧЕНИЕ СПИСКА ЗАКАЗОВ:\n');
    const ordersPath = `/api/marketplace/orders?statuses=ACCEPTED_BY_MERCHANT&pageSize=10`;

    try {
      const ordersResponse = await makeRequest(ordersPath);
      console.log('📦 Orders response structure:');
      console.log(JSON.stringify(ordersResponse, null, 2).substring(0, 500) + '...\n');

      if (ordersResponse.orders && ordersResponse.orders.length > 0) {
        const firstOrder = ordersResponse.orders[0];
        console.log('🔎 Структура первого заказа:');
        console.log(JSON.stringify(firstOrder, null, 2).substring(0, 800) + '...\n');

        // Проверяем наличие фото в заказе
        if (firstOrder.items) {
          console.log('✓ Заказ содержит items\n');
          const firstItem = firstOrder.items[0];
          if (firstItem.image) {
            console.log('✅ ОТЛИЧНО! API отдаёт URL изображения прямо в items[].image');
            console.log('Image URL:', firstItem.image, '\n');
          } else if (firstItem.productCode) {
            console.log('⚠️  API НЕ отдаёт URL в items, но есть productCode - нужно получать фото отдельно');
            console.log('Product code:', firstItem.productCode, '\n');
          } else {
            console.log('❌ Нет ни image, ни productCode в items\n');
          }
        }
      }
    } catch (e) {
      console.log('⚠️  Не удалось получить заказы. Возможно, неверный токен или путь API.\n');
    }

    // 2. Получить информацию о товаре по SKU
    console.log('2️⃣ ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ТОВАРЕ (если нужна отдельно):\n');
    const productPath = `/api/marketplace/products?pageSize=5`;

    try {
      const productsResponse = await makeRequest(productPath);
      console.log('📦 Products response structure:');
      console.log(JSON.stringify(productsResponse, null, 2).substring(0, 500) + '...\n');
    } catch (e) {
      console.log('⚠️  Не удалось получить товары.\n');
    }

  } catch (error) {
    console.error('\n❌ API Test Failed:', error.message);
  }
}

testAPI();
