// Перенести число мест из наклеек владельца в сервис.
//
//   node scripts/apply-boxes-from-stickers.js            # показать, что изменится
//   node scripts/apply-boxes-from-stickers.js --apply    # записать
//
// Откуда цифры. В штрихкоде каждой наклейки зашито «код технолога-номер места»
// (SH-4001-1), а подпись говорит «1/3». То есть сколько мест у изделия, владелец
// давно знает - это написано на коробках, которые уже едут. В сервисе же
// warehouse_items.boxes_per_unit у всех 86 изделий стоял 1: поле просто не заполняли,
// и формирование считало, что всё едет одной коробкой.
//
// Связываем через код технолога, а не по названию: названия на складе - это карточки
// Kaspi («Распашной шкаф Кухни Fourdoor»), а в наклейке внутреннее имя («Шкаф Федор»),
// и совпадений по тексту между ними почти нет. Код - единственная надёжная связь,
// поэтому обновляются только изделия, у которых код проставлен.
require('dotenv').config();
const db = require('../db/init');

const APPLY = process.argv.includes('--apply');

// Замерено по наклейкам из папки владельца (78 файлов, код прочитан из штрихкода).
// Здесь только коды, где мест больше одного - остальным и так стоит 1.
const PLACES = {
  'SH-5221': 5,
  'SH-3217': 4, 'SH-4220': 4, 'SH-6004': 4, 'SH-6215': 4,
  'SH-3219': 3, 'SH-4001': 3, 'SH-4202': 3, 'SH-4203': 3, 'SH-4224': 3,
  'SH-42041': 3, 'SH-42042': 3, 'SH-42043': 3, 'SH-42044': 3, 'SH-42045': 3,
  'SH-42046': 3, 'SH-42047': 3, 'SH-42048': 3, 'SH-42049': 3, 'SH-42050': 3,
  'SH-42051': 3, 'SH-42052': 3,
  'SH-2008': 2, 'SH-2009': 2, 'SH-2010': 2, 'SH-2207': 2, 'SH-3005': 2,
  'SH-3206': 2, 'SH-32061': 2, 'SH-32062': 2,
  'ST-0606': 2, 'ST-2303': 2, 'ST-3002': 2,
};

// В кодах владельца встречается кириллица, неотличимая на вид (КМ-0411, ТВ-0208)
const CYR = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X' };
const latin = (s) => [...String(s)].map((ch) => CYR[ch] || ch).join('').toUpperCase().trim();

(async () => {
  const { rows } = await db.query(`
    SELECT w.id, w.name, w.boxes_per_unit, p.code
    FROM warehouse_items w
    JOIN cost_products p ON p.id = w.cost_product_id
    ORDER BY w.name`);

  const plan = [];
  const unknown = [];
  for (const r of rows) {
    const want = PLACES[latin(r.code)] ?? 1;
    if (want === r.boxes_per_unit) continue;
    plan.push({ ...r, want });
  }

  const { rows: unlinked } = await db.query(
    'SELECT COUNT(*)::int AS n FROM warehouse_items WHERE cost_product_id IS NULL'
  );

  console.log(`Изделий склада с кодом технолога: ${rows.length}`);
  console.log(`Без кода (обновить нечем): ${unlinked[0].n}\n`);

  if (plan.length === 0) {
    console.log('Менять нечего - всё уже стоит правильно.');
    await db.pool.end();
    return;
  }

  console.log('код        было -> станет   изделие');
  for (const p of plan) {
    console.log(`  ${p.code.padEnd(10)} ${String(p.boxes_per_unit).padStart(2)} -> ${p.want}      ${p.name.slice(0, 46)}`);
  }

  if (!APPLY) {
    console.log(`\nИзменится строк: ${plan.length}. Записать: node scripts/apply-boxes-from-stickers.js --apply`);
    await db.pool.end();
    return;
  }

  for (const p of plan) {
    await db.query('UPDATE warehouse_items SET boxes_per_unit = $1, updated_at = NOW() WHERE id = $2',
      [p.want, p.id]);
  }
  console.log(`\nОбновлено изделий: ${plan.length}`);
  console.log('Вернуть как было: UPDATE warehouse_items SET boxes_per_unit = 1 WHERE id IN (' +
    plan.map((p) => `'${p.id}'`).join(', ') + ');');
  await db.pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
