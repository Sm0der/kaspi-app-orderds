require('dotenv').config();
const db = require('./db/init');

async function migrate() {
  try {
    console.log('🔧 Миграция: добавляю поле state и stage в orders...\n');

    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS state VARCHAR(50)`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stage VARCHAR(50)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_stage ON orders(stage)`);

    console.log('✅ Миграция завершена');
    process.exit(0);
  } catch (error) {
    console.error('❌ Ошибка миграции:', error.message);
    process.exit(1);
  }
}

migrate();
