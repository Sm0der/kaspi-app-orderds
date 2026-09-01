require('dotenv').config();
const db = require('./db/init');

async function fixStoreName() {
  try {
    console.log('🔧 Исправляю название магазина...\n');

    // Обновить название магазина
    const result = await db.query(
      `UPDATE stores
       SET name = 'КухниKZ'
       WHERE api_token = $1
       RETURNING id, name, api_token`,
      ['WOG5c0tinMjxjeT8DhNU/HOZAfCg7Xvc9Av9rQ4jUCM=']
    );

    if (result.rows.length > 0) {
      const store = result.rows[0];
      console.log('✅ Магазин обновлен:');
      console.log(`   ID: ${store.id}`);
      console.log(`   Название: ${store.name}`);
      console.log(`   Токен (первые 30 символов): ${store.api_token.substring(0, 30)}...`);
    } else {
      console.log('ℹ️  Магазин не найден. Добавляю новый...\n');

      const insertResult = await db.query(
        `INSERT INTO stores (name, api_token)
         VALUES ($1, $2)
         RETURNING id, name`,
        ['КухниKZ', 'WOG5c0tinMjxjeT8DhNU/HOZAfCg7Xvc9Av9rQ4jUCM=']
      );

      const newStore = insertResult.rows[0];
      console.log('✅ Магазин добавлен:');
      console.log(`   ID: ${newStore.id}`);
      console.log(`   Название: ${newStore.name}`);
    }

    // Показать все магазины
    console.log('\n📋 Все магазины в БД:');
    const allStores = await db.query('SELECT id, name FROM stores');
    allStores.rows.forEach(store => {
      console.log(`   - [${store.id}] ${store.name}`);
    });

    console.log('\n✓ Готово!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

fixStoreName();
