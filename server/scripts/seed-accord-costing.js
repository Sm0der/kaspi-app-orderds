// Завести серию Accord в «Себестоимость».
//
//   node scripts/seed-accord-costing.js            # показать, что будет создано
//   node scripts/seed-accord-costing.js --apply    # создать
//
// Почему одной строкой, а не спецификацией. Владелец дал готовые суммы «себестоимость
// плюс работа» (зарплатный фонд в них уже учтён), а не раскладку по материалам. Формула
// calculate() складывает материалы с тарифами, поэтому тарифы у этих изделий ставим в
// ноль, а всю сумму кладём одной строкой материала - тогда расчёт отдаёт ровно ту цифру,
// которую назвал владелец, без округлений и домыслов. Когда технолог сделает настоящую
// спецификацию, строку надо убрать и вернуть тарифы.
//
// Изделия без спецификации аналитика считает неизвестными по себестоимости (см. CLAUDE.md),
// поэтому пустыми их оставлять нельзя - маржа по Accord просто не посчиталась бы.
require('dotenv').config();
const db = require('../db/init');

const APPLY = process.argv.includes('--apply');
const money = (v) => Math.round(Number(v)).toLocaleString('ru-RU');

// Строка-заглушка, через которую заводится вся сумма. Название говорит само за себя:
// увидев её в спецификации, технолог поймёт, что раскладки тут нет.
const ITEM_NAME = 'Себестоимость с работой (задана владельцем)';

const MODULES = {
  'А': { cost: 20000, code: 'SH-2015', category: 'SH', doors: 2, drawers: 0, serial: 15,
         name: 'Accord А', note: 'шкаф для документов 70x35x190' },
  'Б': { cost: 16000, code: 'SH-1014', category: 'SH', doors: 1, drawers: 0, serial: 14,
         name: 'Accord Б', note: 'узкий шкаф для документов 40x35x190' },
  'В': { cost: 15000, code: 'SL-0004', category: 'SL', doors: 0, drawers: 0, serial: 4,
         name: 'Accord В', note: 'открытый стеллаж для документов 70x35x190' },
  'Г': { cost: 16900, code: 'SH-2016', category: 'SH', doors: 2, drawers: 0, serial: 16,
         name: 'Accord Г', note: 'комбинированный шкаф для документов 70x35x190' },
};

// У комплектов своя категория AC: цифры кода у остальных означают двери и ящики одного
// изделия, а в комплекте их несколько - подставлять туда сумму дверей значило бы
// сломать смысл кода.
const KITS = [
  { key: 'S',  code: 'AC-0001', serial: 1, width: 110, parts: ['Б', 'А'] },
  { key: 'M',  code: 'AC-0002', serial: 2, width: 150, parts: ['Б', 'А', 'Б'] },
  { key: 'L',  code: 'AC-0003', serial: 3, width: 210, parts: ['А', 'В', 'А'] },
  { key: 'XL', code: 'AC-0004', serial: 4, width: 290, parts: ['Б', 'А', 'Г', 'А', 'Б'] },
];

(async () => {
  const planned = [];

  for (const [letter, m] of Object.entries(MODULES)) {
    planned.push({ ...m, cost: m.cost, parts: null, letter });
  }
  for (const k of KITS) {
    const cost = k.parts.reduce((s, p) => s + MODULES[p].cost, 0);
    planned.push({
      code: k.code, category: 'AC', doors: 0, drawers: 0, serial: k.serial,
      name: `Accord ${k.key}`,
      note: `комплект ${k.width} см: ${k.parts.join(' + ')}`,
      cost, parts: k.parts,
    });
  }

  console.log('Будет заведено в «Себестоимость»:\n');
  console.log('код         название     себестоимость + работа   состав');
  for (const p of planned) {
    console.log(
      `${p.code.padEnd(12)}${p.name.padEnd(13)}${money(p.cost).padStart(14)} ₸      ${p.note}`
    );
  }

  // Коды не должны столкнуться с существующими - владелец ведёт их сам
  const { rows: taken } = await db.query(
    'SELECT code, name FROM cost_products WHERE code = ANY($1)',
    [planned.map((p) => p.code)]
  );
  if (taken.length > 0) {
    console.log('\nЭти коды уже заняты, нужно выбрать другие:');
    for (const t of taken) console.log(`  ${t.code} — ${t.name}`);
    await db.pool.end();
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nЭто предпросмотр. Создать: node scripts/seed-accord-costing.js --apply');
    await db.pool.end();
    return;
  }

  // Одна строка-заглушка на всю серию, а не своя у каждого изделия
  let itemId;
  const existing = await db.query('SELECT id FROM cost_items WHERE name = $1', [ITEM_NAME]);
  if (existing.rows.length > 0) {
    itemId = existing.rows[0].id;
  } else {
    const made = await db.query(
      `INSERT INTO cost_items (name, unit, kind, counts_as, default_price, position)
       VALUES ($1, 'шт', 'material', NULL, NULL, 0) RETURNING id`,
      [ITEM_NAME]
    );
    itemId = made.rows[0].id;
    console.log(`Создана строка материала «${ITEM_NAME}» (id ${itemId})`);
  }

  for (const p of planned) {
    const made = await db.query(
      `INSERT INTO cost_products
         (code, name, category, doors, drawers, serial_no,
          rate_saw, rate_edge, rate_pack, rate_ship, rate_overhead, drilling_cost,
          source_tab)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 0, 0, 'Accord')
       RETURNING id`,
      [p.code, p.name, p.category, p.doors, p.drawers, p.serial]
    );
    await db.query(
      'INSERT INTO cost_product_items (product_id, item_id, quantity, price) VALUES ($1, $2, 1, $3)',
      [made.rows[0].id, itemId, p.cost]
    );
    console.log(`  ${p.code} — ${p.name}: ${money(p.cost)} ₸`);
  }

  console.log(`\nЗаведено изделий: ${planned.length}`);
  await db.pool.end();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
