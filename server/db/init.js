const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const schema = `
-- Магазины
CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  api_token VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  kaspi_order_id VARCHAR(255) UNIQUE NOT NULL,
  order_code VARCHAR(100),
  status VARCHAR(100),
  state VARCHAR(50), -- 'NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'
  stage VARCHAR(50), -- 'active', 'shipping', 'completed', 'cancelled'
  delivery_date DATE,
  urgency VARCHAR(50), -- 'overdue', 'today', 'upcoming'
  raw_data JSONB,
  synced_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Каталог товаров магазина (наполняется из заказов и/или импортом из кабинета Kaspi).
-- Один товар (по артикулу) -> много позиций в order_items (один-ко-многим).
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  sku VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  category VARCHAR(255),
  price NUMERIC,
  image_url TEXT,
  units_per_space INTEGER DEFAULT 1, -- УСТАРЕЛО, оставлено для совместимости - см. spaces_per_unit
  spaces_per_unit NUMERIC(10,4) DEFAULT 1, -- сколько мест накладной занимает 1 единица товара.
                                            -- Для мелких товаров (много штук в одном месте) это дробь < 1
                                            -- (например 0.1 = 10 шт в 1 месте). Для крупных/громоздких
                                            -- товаров (несколько мест на 1 шт) это число >= 1
                                            -- (например 4 = 1 шт занимает 4 места).
  source VARCHAR(20) DEFAULT 'order', -- 'order' (найден в заказе) или 'import' (загружен из CSV)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, sku)
);

-- Позиции заказов
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  product_code VARCHAR(255),
  sku VARCHAR(255),
  name VARCHAR(500),
  quantity INTEGER,
  image_url TEXT,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(order_id, product_code)
);

-- История синхронизации
CREATE TABLE IF NOT EXISTS sync_history (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  status VARCHAR(50), -- 'success', 'error'
  message TEXT,
  synced_count INTEGER,
  error_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Push-уведомления (для Web Push API)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT UNIQUE NOT NULL,
  auth VARCHAR(255),
  p256dh VARCHAR(255),
  active BOOLEAN DEFAULT TRUE,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  last_updated TIMESTAMP DEFAULT NOW()
);

-- История уведомлений
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  message TEXT,
  data JSONB,
  sent_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_orders_store_id ON orders(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_date ON orders(delivery_date);
CREATE INDEX IF NOT EXISTS idx_orders_urgency ON orders(urgency);
CREATE INDEX IF NOT EXISTS idx_orders_stage ON orders(stage);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_code ON order_items(product_code);
CREATE INDEX IF NOT EXISTS idx_sync_history_store ON sync_history(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
`;

async function initDB() {
  try {
    // Test connection
    const result = await pool.query('SELECT NOW()');
    console.log('✓ Database connection established:', result.rows[0]);

    // Create schema
    await pool.query(schema);
    console.log('✓ Schema created/verified');

    // Миграция: добавить spaces_per_unit, если таблица products уже существовала без него,
    // и перенести старые значения units_per_space (шт. в 1 месте) в новый формат
    // (места на 1 шт = 1 / units_per_space).
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS spaces_per_unit NUMERIC(10,4) DEFAULT 1`);
    await pool.query(`
      UPDATE products
      SET spaces_per_unit = ROUND(1.0 / units_per_space, 4)
      WHERE units_per_space IS NOT NULL AND units_per_space > 1 AND spaces_per_unit = 1
    `);
    console.log('✓ Migration spaces_per_unit verified');

    return pool;
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

module.exports = {
  pool,
  initDB,
  query: (text, params) => pool.query(text, params)
};
