// Добавить столы Accord и пересчитать комплекты.
//
//   node scripts/seed-accord-tables.js            # показать, что изменится
//   node scripts/seed-accord-tables.js --apply    # записать
//
// Продолжение seed-accord-costing.js: владелец добавил в каждый комплект стол и назвал
// готовые суммы «себестоимость плюс работа», поэтому столы заводятся так же — тарифы в
// ноль, вся сумма одной строкой материала (см. CLAUDE.md, почему именно так).
//
// Столов три, а не четыре: в комплектах S и L стоит ОДИН и тот же стол - письменный
// 130x70x75 с одной тумбой (ящик сверху, дверца снизу), и себестоимость у него одна.
// Поэтому у него один код на две позиции, что у владельца уже норма (SH-2008 стоит на
// трёх изделиях). У M приставной стол без тумбы, у XL двухтумбовый.
//
// Прибыль растёт от маленького комплекта к большому: 15, 20, 25, 30 тысяч. Цены здесь
// не хранятся - их считает формула из CLAUDE.md, скрипт печатает их для сверки.
require('dotenv').config();
const db = require('../db/init');

const APPLY = process.argv.includes('--apply');
const money = (v) => Math.round(Number(v)).toLocaleString('ru-RU');

const ITEM_NAME = 'Себестоимость с работой (задана владельцем)';

// Код технолога: категория, двери, ящики, номер (см. CLAUDE.md)
const TABLES = [
  { code: 'ST-0010', doors: 0, drawers: 0, serial: 10, cost: 11000,
    name: 'Accord Стол приставной', note: 'без тумбы, в комплекте M' },
  { code: 'ST-1101', doors: 1, drawers: 1, serial: 1, cost: 16000,
    name: 'Accord Стол с тумбой', note: '130x70x75, ящик и дверца, в комплектах S и L' },
  { code: 'ST-1301', doors: 1, drawers: 3, serial: 1, cost: 16500,
    name: 'Accord Стол двухтумбовый', note: 'дверца и три ящика, в комплекте XL' },
];

// Модули заведены первым скриптом, суммы повторены здесь только для сверки итога
const MODULES = { 'А': 20000, 'Б': 16000, 'В': 15000, 'Г': 16900 };

const KITS = [
  { code: 'AC-0001', key: 'S',  parts: ['Б', 'А'],                       table: 'ST-1101', profit: 15000 },
  { code: 'AC-0002', key: 'M',  parts: ['Б', 'А', 'Б'],                  table: 'ST-0010', profit: 20000 },
  { code: 'AC-0003', key: 'L',  parts: ['А', 'В', 'А'],                  table: 'ST-1101', profit: 25000 },
  { code: 'AC-0004', key: 'XL', parts: ['Б', 'А', 'Г', 'А', 'Б'],        table: 'ST-1301', profit: 30000 },
];

// Доставка Kaspi - ступень с потолком 13 919 ₸ на заказ. Комплект со столом едет в
// пяти и более местах, то есть всегда в потолке. Комиссия 11,75%.
const SHIP_CAP = 13919;
const price = (cost, profit) => Math.round((cost + SHIP_CAP + profit) / 0.8825 / 100) * 100;

(async () => {
  const tableCost = Object.fromEntries(TABLES.map((t) => [t.code, t.cost]));

  const kits = KITS.map((k) => {
    const modules = k.parts.reduce((s, p) => s + MODULES[p], 0);
    const cost = modules + tableCost[k.table];
    return { ...k, modules, cost, price: price(cost, k.profit) };
  });

  console.log('НОВЫЕ ИЗДЕЛИЯ — СТОЛЫ\n');
  console.log('код        название                    себестоимость + работа   что это');
  for (const t of TABLES) {
    console.log(`${t.code.padEnd(11)}${t.name.padEnd(28)}${money(t.cost).padStart(14)} ₸      ${t.note}`);
  }

  console.log('\n\nКОМПЛЕКТЫ — НОВАЯ СЕБЕСТОИМОСТЬ\n');
  console.log('код        комплект   модули     стол    итого    прибыль      цена');
  for (const k of kits) {
    console.log(
      `${k.code.padEnd(11)}${('Accord ' + k.key).padEnd(11)}${money(k.modules).padStart(7)}` +
      `${money(tableCost[k.table]).padStart(9)}${money(k.cost).padStart(9)}${money(k.profit).padStart(11)}` +
      `${(money(k.price) + ' ₸').padStart(12)}`
    );
  }

  const { rows: taken } = await db.query(
    'SELECT code, name FROM cost_products WHERE code = ANY($1)',
    [TABLES.map((t) => t.code)]
  );
  if (taken.length > 0) {
    console.log('\nЭти коды уже заняты, нужно выбрать другие:');
    for (const t of taken) console.log(`  ${t.code} — ${t.name}`);
    await db.pool.end();
    process.exit(1);
  }

  // Комплекты должны существовать - их завёл первый скрипт
  const { rows: existing } = await db.query(
    `SELECT p.code, p.id, i.id AS line_id, i.price
     FROM cost_products p
     JOIN cost_product_items i ON i.product_id = p.id
     WHERE p.code = ANY($1) AND i.item_id = (SELECT id FROM cost_items WHERE name = $2)`,
    [kits.map((k) => k.code), ITEM_NAME]
  );
  const byCode = Object.fromEntries(existing.map((r) => [r.code, r]));
  const missing = kits.filter((k) => !byCode[k.code]);
  if (missing.length > 0) {
    console.log('\nНе нашлись комплекты (сначала seed-accord-costing.js):',
      missing.map((k) => k.code).join(', '));
    await db.pool.end();
    process.exit(1);
  }

  console.log('\n\nЧТО ИЗМЕНИТСЯ В БАЗЕ\n');
  for (const k of kits) {
    const was = Number(byCode[k.code].price);
    console.log(`  ${k.code}  было ${money(was).padStart(8)} ₸  ->  станет ${money(k.cost).padStart(8)} ₸`);
  }

  if (!APPLY) {
    console.log('\nЭто предпросмотр. Записать: node scripts/seed-accord-tables.js --apply');
    await db.pool.end();
    return;
  }

  const { rows: itemRows } = await db.query('SELECT id FROM cost_items WHERE name = $1', [ITEM_NAME]);
  if (itemRows.length === 0) {
    console.log('\nНе нашлась строка материала «' + ITEM_NAME + '» — сначала seed-accord-costing.js');
    await db.pool.end();
    process.exit(1);
  }
  const itemId = itemRows[0].id;

  console.log('\nЗавожу столы:');
  for (const t of TABLES) {
    const made = await db.query(
      `INSERT INTO cost_products
         (code, name, category, doors, drawers, serial_no,
          rate_saw, rate_edge, rate_pack, rate_ship, rate_overhead, drilling_cost,
          source_tab)
       VALUES ($1, $2, 'ST', $3, $4, $5, 0, 0, 0, 0, 0, 0, 'Accord')
       RETURNING id`,
      [t.code, t.name, t.doors, t.drawers, t.serial]
    );
    await db.query(
      'INSERT INTO cost_product_items (product_id, item_id, quantity, price) VALUES ($1, $2, 1, $3)',
      [made.rows[0].id, itemId, t.cost]
    );
    console.log(`  ${t.code} — ${t.name}: ${money(t.cost)} ₸`);
  }

  console.log('\nПересчитываю комплекты:');
  const rollback = [];
  for (const k of kits) {
    const row = byCode[k.code];
    await db.query('UPDATE cost_product_items SET price = $1 WHERE id = $2', [k.cost, row.line_id]);
    rollback.push(`UPDATE cost_product_items SET price = ${Number(row.price)} WHERE id = ${row.line_id};`);
    console.log(`  ${k.code} — Accord ${k.key}: ${money(k.cost)} ₸, цена ${money(k.price)} ₸`);
  }

  console.log('\nВернуть комплекты как было:');
  for (const r of rollback) console.log('  ' + r);
  console.log('Убрать столы: DELETE FROM cost_products WHERE code IN (' +
    TABLES.map((t) => `'${t.code}'`).join(', ') + ');');

  await db.pool.end();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
