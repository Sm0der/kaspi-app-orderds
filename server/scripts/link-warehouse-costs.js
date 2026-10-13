// Привязать изделия склада к кодам технолога.
//
//   node scripts/link-warehouse-costs.js            # показать, что будет связано
//   node scripts/link-warehouse-costs.js --apply    # записать
//
// Пары подобраны сопоставлением названий и выверены глазами. Сопоставлять пришлось не
// по буквам: на складе стоит имя карточки Kaspi со всем довеском («Распашной шкаф Art
// Room Home Шкаф Мадлен 3D, 136x240х60 см, белый»), у технолога короткое («Шкаф Мадлен
// 3Д»), и расходятся они транслитерацией (Berlin Day / Берлин дэй, BesTree / Бестри),
// буквой Д против D и опечатками (Ловтика / лофтика).
//
// Главное правило: совпасть должен ТИП изделия, а не только модель. Иначе прикроватная
// тумба 50x50x38 уезжает на код «ТВ Тумба Венеция», а это чужая себестоимость.
// Четыре пары, которые автоматика предложила, сюда НЕ вошли: три тумбы просились на
// общий код «ТВ Тумба» при живой своей модели, а «A BLVD Garand» — на «Шкаф Гаранд»,
// хотя у владельца заведён отдельный «Шкаф Гаранд БВЛД» (BLVD и есть БВЛД).
//
// После привязки код раскладывается по артикулам изделия - тем же запросом, что и
// syncProductCostLinks в складе. Без этого маржа в «Аналитике» останется прочерком:
// она считается по строке заказа, а строка знает только артикул.
require('dotenv').config();
const db = require('../db/init');

const APPLY = process.argv.includes('--apply');

// изделие склада -> код технолога
const PAIRS = [
  ['Комод Берлин Найт', 'KM-0407'],
  ['Комод Монро Артрум', 'KM-4014'],
  ['комод Монро Артрум Шарли Green', 'KM-4014'],
  ['Комод Токио', 'KM-0402'],
  ['Письменный стол Памир', 'ST-3002'],
  ['Распашной шкаф A BLVD Garand', 'SH-2009'],
  ['Распашной шкаф Garand Mebel ', 'SH-2008'],
  ['Распашной шкаф Art Room Home Шкаф Мадлен 3D, 136x240х60 см, белый, светло-коричневый', 'SH-3327'],
  ['Распашной шкаф Кухни  Lux', 'SH-3217'],
  ['Распашной шкаф Кухни  КМ', 'SH-4001'],
  ['Стол компьютерный Артрум Кастор', 'ST-0606'],
  ['Стол письменный Кастор, 151х65x75 см, белый', 'ST-0606'],
  ['Стол Лион', 'ST-0007'],
  ['Тв тумба  Артрум Тянь - Шань', 'TB-3015'],
  ['ТВ-тумба напольная Art Room Home Тв Тумба Венеция , 180x48x35 см, белый, светло-коричневый', 'TB-6016'],
  ['ТВ-тумба напольная Art Room Home Тв тумба Венеция Зеленая, 180x48x35 см, коричневый, зеленый', 'TB-6016'],
  ['ТВ-тумба напольная Art Room Home Тв тумба Тянь Шань , 180x48x35 см, коричневый, темно-серый', 'TB-3015'],
  ['ТВ-тумба напольная Art Room Home Тв тумба Тянь Шань Шарли Грин, 180x48x35 см, белый, зеленый', 'TB-3015'],
  ['ТВ-тумба напольная Berlin Day', 'TB-0209'],
  ['Тумба для обуви', 'TB-2107'],
  ['Шкаф Турин 135', 'SH-3219'],
];

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

(async () => {
  const { rows: items } = await db.query(
    'SELECT id, name, cost_product_id FROM warehouse_items ORDER BY name'
  );
  const { rows: codes } = await db.query('SELECT id, code, name FROM cost_products WHERE code IS NOT NULL');
  const byCode = Object.fromEntries(codes.map((c) => [c.code, c]));

  const plan = [];
  const problems = [];

  for (const [itemName, code] of PAIRS) {
    const found = items.filter((i) => norm(i.name) === norm(itemName));
    if (found.length === 0) { problems.push(`не нашлось изделие «${itemName}»`); continue; }
    if (found.length > 1) { problems.push(`изделий с именем «${itemName}» несколько (${found.length})`); continue; }
    const c = byCode[code];
    if (!c) { problems.push(`нет кода ${code}`); continue; }
    if (found[0].cost_product_id) { problems.push(`у «${itemName}» код уже стоит, не трогаю`); continue; }
    plan.push({ item: found[0], code: c });
  }

  console.log('Будет связано:\n');
  console.log('изделие склада                                        код       изделие технолога');
  for (const p of plan) {
    console.log(`  ${p.item.name.replace(/\s+/g, ' ').trim().slice(0, 50).padEnd(52)}${p.code.code.padEnd(10)}${p.code.name}`);
  }

  if (problems.length) {
    console.log('\nПропущено:');
    for (const p of problems) console.log('  ' + p);
  }

  const { rows: left } = await db.query(
    'SELECT COUNT(*)::int n FROM warehouse_items WHERE cost_product_id IS NULL'
  );
  console.log(`\nСейчас без кода: ${left[0].n} из ${items.length}. После правки станет ${left[0].n - plan.length}.`);

  if (!APPLY) {
    console.log('\nЭто предпросмотр. Записать: node scripts/link-warehouse-costs.js --apply');
    await db.pool.end();
    return;
  }

  let skus = 0;
  for (const p of plan) {
    await db.query('UPDATE warehouse_items SET cost_product_id = $1, updated_at = NOW() WHERE id = $2',
      [p.code.id, p.item.id]);
    // то же, что syncProductCostLinks: код с изделия раскладываем по его артикулам
    const r = await db.query(
      `UPDATE products p SET cost_product_id = $1
       FROM warehouse_item_skus wis
       WHERE wis.warehouse_item_id = $2 AND p.store_id = wis.store_id AND p.sku = wis.sku
         AND p.cost_product_id IS DISTINCT FROM $1`,
      [p.code.id, p.item.id]
    );
    skus += r.rowCount;
    console.log(`  ${p.code.code} -> ${p.item.name.replace(/\s+/g, ' ').trim().slice(0, 46)}  (артикулов: ${r.rowCount})`);
  }

  console.log(`\nСвязано изделий: ${plan.length}, проставлено артикулов: ${skus}`);
  console.log('Вернуть как было:');
  console.log('  UPDATE warehouse_items SET cost_product_id = NULL WHERE id IN (' +
    plan.map((p) => `'${p.item.id}'`).join(', ') + ');');
  console.log('  UPDATE products SET cost_product_id = NULL WHERE (store_id, sku) IN (' +
    'SELECT store_id, sku FROM warehouse_item_skus WHERE warehouse_item_id IN (' +
    plan.map((p) => `'${p.item.id}'`).join(', ') + '));');

  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
