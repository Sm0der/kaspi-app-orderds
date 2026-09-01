require('dotenv').config();
const db = require('./db/init');

async function initStores() {
  try {
    console.log('🏪 Инициализация магазинов...\n');

    // Добавить магазины
    const stores = [
      { name: 'КухниKZ', api_token: process.env.KASPI_API_TOKEN_1 }
    ];

    for (const store of stores) {
      if (!store.api_token) {
        console.log(`⚠️  Токен не найден для ${store.name}`);
        continue;
      }

      const result = await db.query(
        `INSERT INTO stores (name, api_token)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [store.name, store.api_token]
      );

      if (result.rows.length > 0) {
        console.log(`✅ Добавлен магазин: ${store.name} (ID: ${result.rows[0].id})`);
      } else {
        console.log(`ℹ️  Магазин ${store.name} уже существует`);
      }
    }

    console.log('\n✓ Инициализация завершена');
    process.exit(0);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

initStores();
