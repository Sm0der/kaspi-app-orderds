require('dotenv').config();
const db = require('./db/init');

async function seedMockData() {
  try {
    console.log('🌱 Добавляю мок-заказы для тестирования...\n');

    // Получить ID магазина
    const storesResult = await db.query('SELECT id FROM stores LIMIT 1');
    if (storesResult.rows.length === 0) {
      console.error('❌ Магазин не найден. Сначала запустите init-stores.js');
      process.exit(1);
    }

    const storeId = storesResult.rows[0].id;

    // Сегодня и даты
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Мок-заказы
    const mockOrders = [
      {
        kaspi_order_id: 'KZ2026081901',
        status: 'ACCEPTED_BY_MERCHANT',
        delivery_date: today,
        urgency: 'today',
        items: [
          { name: 'Кухонный стол', quantity: 1, sku: 'TABLE-001', code: 'TABLE-001' },
          { name: 'Стул кухонный', quantity: 4, sku: 'CHAIR-001', code: 'CHAIR-001' }
        ]
      },
      {
        kaspi_order_id: 'KZ2026081902',
        status: 'ACCEPTED_BY_MERCHANT',
        delivery_date: today,
        urgency: 'today',
        items: [
          { name: 'Диван угловой', quantity: 1, sku: 'SOFA-002', code: 'SOFA-002' }
        ]
      },
      {
        kaspi_order_id: 'KZ2026081903',
        status: 'ACCEPTED_BY_MERCHANT',
        delivery_date: yesterday,
        urgency: 'overdue',
        items: [
          { name: 'Шкаф встроенный', quantity: 1, sku: 'CABINET-001', code: 'CABINET-001' }
        ]
      },
      {
        kaspi_order_id: 'KZ2026081904',
        status: 'ACCEPTED_BY_MERCHANT',
        delivery_date: tomorrow,
        urgency: 'soon',
        items: [
          { name: 'Полка настенная', quantity: 3, sku: 'SHELF-001', code: 'SHELF-001' }
        ]
      },
      {
        kaspi_order_id: 'KZ2026081905',
        status: 'ACCEPTED_BY_MERCHANT',
        delivery_date: today,
        urgency: 'today',
        items: [
          { name: 'Стол офисный', quantity: 2, sku: 'DESK-001', code: 'DESK-001' },
          { name: 'Стул офисный', quantity: 2, sku: 'OFFICE-CHAIR', code: 'OFFICE-CHAIR' }
        ]
      }
    ];

    let addedCount = 0;
    for (const order of mockOrders) {
      const orderResult = await db.query(
        `INSERT INTO orders (store_id, kaspi_order_id, status, delivery_date, urgency, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kaspi_order_id) DO NOTHING
         RETURNING id`,
        [storeId, order.kaspi_order_id, order.status, order.delivery_date, order.urgency, JSON.stringify(order)]
      );

      if (orderResult.rows.length > 0) {
        const orderId = orderResult.rows[0].id;

        // Добавить позиции
        for (const item of order.items) {
          await db.query(
            `INSERT INTO order_items (order_id, product_code, sku, name, quantity)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [orderId, item.code, item.sku, item.name, item.quantity]
          );
        }

        console.log(`✅ ${order.kaspi_order_id} (${order.urgency})`);
        addedCount++;
      }
    }

    console.log(`\n✓ Добавлено ${addedCount} заказов`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

seedMockData();
