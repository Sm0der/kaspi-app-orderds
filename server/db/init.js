const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Побольше соединений в пуле - синхронизация теперь обрабатывает заказы параллельно
  // (см. services/syncService.js), а в проде это Supabase Postgres через transaction pooler
  // (PgBouncer), который сам мультиплексирует много логических соединений поверх немногих
  // реальных - раздувать пул с нашей стороны безопасно.
  max: 20
});

const schema = `
-- Весь скрипт уходит одним простым запросом, то есть одной неявной транзакцией, и
-- держит AccessExclusiveLock на таблицах до самого конца. Два холодных старта разом
-- (на serverless это норма) успевали взять блокировки навстречу друг другу и один из
-- них падал с deadlock detected, унося с собой весь инстанс. Консультативная блокировка
-- выстраивает их в очередь: второй просто дождётся первого и увидит уже готовую схему.
-- Именно xact-версия, а не сессионная: она снимается по концу транзакции, что
-- обязательно при работе через PgBouncer в transaction-режиме.
SELECT pg_advisory_xact_lock(918273645);

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

-- Миграция: spaces_per_unit вместо старого units_per_space (шт. в 1 месте).
-- Переносим старые значения в новый формат: мест на 1 шт = 1 / units_per_space.
ALTER TABLE products ADD COLUMN IF NOT EXISTS spaces_per_unit NUMERIC(10,4) DEFAULT 1;
UPDATE products
SET spaces_per_unit = ROUND(1.0 / units_per_space, 4)
WHERE units_per_space IS NOT NULL AND units_per_space > 1 AND spaces_per_unit = 1;

-- Миграция: дата создания заказа в Kaspi (order_date) - отдельно от delivery_date
-- (плановая дата доставки клиенту) и synced_at (когда мы сами его затянули в базу).
-- Нужна для фильтра "новые заказы за сегодня/вчера/месяц".
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_date TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);

-- Миграция: плановая дата передачи курьеру (kaspiDelivery.courierTransmissionPlanningDate).
-- Именно её продавец видит в кабинете Kaspi как «Планируемая дата передачи курьеру», и
-- именно по ней он планирует день отгрузки. delivery_date - это другая дата, плановое
-- прибытие к клиенту (обычно на 1-3 дня позже), поэтому фильтр по дням отгрузки на неё
-- опираться не может: за один и тот же день числа расходятся в разы.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_date DATE;
CREATE INDEX IF NOT EXISTS idx_orders_ship_date ON orders(ship_date);

-- Первая плановая дата передачи курьеру, какой мы её увидели. Kaspi переписывает
-- courierTransmissionPlanningDate под фактическую передачу - у всех 1690 отгруженных
-- заказов план и факт совпадали день в день, то есть по данным Kaspi перенос срока
-- вообще не наблюдаем. Запоминаем дату сами при первой встрече заказа и больше её не
-- трогаем: расхождение с текущей ship_date и есть перенос (см. routes/analytics.js).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_date_first DATE;

-- Момент формирования накладной - Kaspi хранит его только внутри PDF (/CreationDate),
-- читает services/waybillStamps.js. Именно timestamptz: значение пишется из Node, а в
-- колонке без пояса node-pg толкует время по поясу процесса (локально Алматы, на Vercel
-- UTC), и один штамп показывался то в 16:52, то в 21:52. Синхронизация эти колонки не
-- трогает - её UPSERT перечисляет столбцы поимённо.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS waybill_made_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS waybill_stamped_number VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_orders_waybill_made_at ON orders(waybill_made_at);

-- Миграция: хеш присланного Kaspi JSON заказа. У Kaspi нет фильтра "изменённые с ...",
-- он всегда отдаёт все заказы за 14 дней, поэтому изменившиеся мы вычисляем сами -
-- сравнением хеша. Без этого каждая синхронизация переписывала все ~1300 заказов,
-- хотя реально между запусками меняются единицы (см. services/syncService.js).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_hash TEXT;

-- Внутренние статусы компании (CRM-режим) - своя воронка работы поверх статусов Kaspi.
-- Пользователь переименовывает, добавляет и удаляет их прямо в интерфейсе, поэтому это
-- таблица, а не список в коде. Заказ ссылается на статус; при удалении статуса заказы
-- не пропадают, а просто остаются без внутреннего статуса.
CREATE TABLE IF NOT EXISTS crm_statuses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#8A8177',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS crm_status_id INTEGER
  REFERENCES crm_statuses(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crm_status_changed_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_orders_crm_status ON orders(crm_status_id);

-- Таблицы app_users здесь больше нет: люди и роли всей системы живут в production_users,
-- которую ведёт приложение склада (production/warehouse-production-app). Две таблицы
-- пользователей означали два пароля и два места, где выдавать доступ.
-- Саму app_users в базе не трогаем - в ней запись владельца, пусть останется следом.

-- ── Себестоимость ───────────────────────────────────────────────────────────
-- Перенос таблицы главного технолога (Google Таблица, 74 листа изделий + ПРАЙС +
-- СметаПрисадки). В таблице цена одной и той же фурнитуры лежит в каждом листе своя,
-- и владелец попросил так и оставить: цена живёт в строке спецификации изделия.
-- cost_items - только справочник названий и единиц, чтобы строки не расползались
-- в опечатках и чтобы можно было поднять цену позиции сразу во всех изделиях.
CREATE TABLE IF NOT EXISTS cost_items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL UNIQUE,
  unit VARCHAR(20),
  -- 'material' | 'fittings' | 'packaging'; packaging - строка «Упаковка», её количество
  -- и есть число коробок, от которого считаются упаковка, отправка и накладные расходы
  kind VARCHAR(20) NOT NULL DEFAULT 'fittings',
  -- Что позиция даёт работам: 'saw_area' - квадратура для распила (ЛДСП),
  -- 'edge_length' - метры для кромки (ПВХ). Так расчёт повторяет формулы из ПРАЙС.
  counts_as VARCHAR(20),
  default_price NUMERIC(12,2),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cost_products (
  id SERIAL PRIMARY KEY,
  -- Внутренний код: SH-4001 - две буквы категория, затем двери, ящики, порядковый номер
  code VARCHAR(20) UNIQUE,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(4),
  doors SMALLINT,
  drawers SMALLINT,
  serial_no SMALLINT,
  -- Тарифы работ у каждого изделия свои - в листах они внизу и местами расходятся
  rate_saw NUMERIC(10,2) NOT NULL DEFAULT 100,
  rate_edge NUMERIC(10,2) NOT NULL DEFAULT 20,
  rate_pack NUMERIC(10,2) NOT NULL DEFAULT 650,
  rate_ship NUMERIC(10,2) NOT NULL DEFAULT 350,
  rate_overhead NUMERIC(10,2) NOT NULL DEFAULT 2000,
  -- Присадка приходит из листа СметаПрисадки готовой суммой
  drilling_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Наценка как в ПРАЙС: база = себестоимость / 0.74, маржа = 25% базы,
  -- опт = себестоимость + маржа, цена Kaspi = опт * 1.25
  margin_divisor NUMERIC(6,4) NOT NULL DEFAULT 0.74,
  margin_rate NUMERIC(6,4) NOT NULL DEFAULT 0.25,
  kaspi_markup NUMERIC(6,4) NOT NULL DEFAULT 0.25,
  source_tab VARCHAR(80),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cost_products_code ON cost_products(code);

CREATE TABLE IF NOT EXISTS cost_product_items (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES cost_products(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES cost_items(id),
  quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE (product_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_cost_product_items_product ON cost_product_items(product_id);

-- Нормы присадки: сколько операций и времени уходит на изделие
CREATE TABLE IF NOT EXISTS cost_drilling (
  product_id INTEGER PRIMARY KEY REFERENCES cost_products(id) ON DELETE CASCADE,
  confirmats INTEGER, eccentrics INTEGER, screws INTEGER, shelf_holders INTEGER,
  handles INTEGER, hinges INTEGER, groove NUMERIC(8,2),
  parts INTEGER, area NUMERIC(8,2), seconds NUMERIC(10,2),
  load_factor NUMERIC(6,3), extra_seconds NUMERIC(10,2),
  pay_per_item NUMERIC(10,2), total NUMERIC(10,2)
);
-- Время присадки технолог считает с половинами (929,5 секунды у шкафа LUX и ещё у
-- пятнадцати изделий), а колонки были целыми - импорт падал на первой такой ячейке
ALTER TABLE cost_drilling ALTER COLUMN seconds TYPE NUMERIC(10,2);
ALTER TABLE cost_drilling ALTER COLUMN extra_seconds TYPE NUMERIC(10,2);

-- Связь товара Kaspi с изделием: по ней и себестоимость видна по заказам,
-- и код изделия попадает на этикетку коробки
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_product_id INTEGER
  REFERENCES cost_products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_cost_product ON products(cost_product_id);

-- Номер магазина на Kaspi. Раньше существовал только в живой базе (заведён вручную
-- в Supabase), в этом файле - в схеме-как-коде - миграции не было вовсе: пересборка
-- с нуля (новый Supabase-проект, восстановление после сбоя) осталась бы без колонки,
-- и initialize() падал бы на первом же SELECT из index.js.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS kaspi_merchant_uid VARCHAR(20);

-- Стартовый набор колонок доски - только если пользователь ещё ничего не заводил
INSERT INTO crm_statuses (name, color, position)
SELECT * FROM (VALUES
  ('Новый',       '#6E93B8', 1),
  ('В работе',    '#D6A756', 2),
  ('Собран',      '#7FA07F', 3),
  ('Отгружен',    '#5F7D8C', 4),
  ('Проблемный',  '#E0524A', 5)
) AS seed(name, color, position)
WHERE NOT EXISTS (SELECT 1 FROM crm_statuses);
`;

// Схема и все миграции выполняются одним запросом, а не по одному на выражение.
// Это происходит на каждом холодном старте функции, а до базы (Supabase в Токио) круг
// занимает сотни миллисекунд - десяток отдельных запросов заметно задерживал и синк,
// и первый ответ дашборду. Параметров здесь нет, поэтому весь скрипт уходит одним пакетом.
async function initDB() {
  try {
    await pool.query(schema);
    console.log('✓ Schema and migrations verified');
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
