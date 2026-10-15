// Разовая миграция: место на карточке становится местом В ГОРОДЕ.
//
//   node scripts/migrate-ranks-city.js            # показать, что будет сделано
//   node scripts/migrate-ranks-city.js --apply    # выполнить
//
// Зачем. В `kaspiCatalog.js` был жёстко зашит cityId Алматы, и место, которое отчёты
// называли «местом», было местом в Алматы. Замерено 15.10.2026 вживую: шкаф InHome
// Comfort 4D за 89 000 ₸ стоит ПЕРВЫМ в 14 городах из 15 и третьим только в Алматы;
// Aisha Pro 1103 - первая в 13 из 15, хуже только Алматы (4) и Шымкент (5). При этом
// Алматы даёт 11,4% заказов, а Астана, где мы первые, - 16,7%. То есть отчёт мерил
// самый трудный и не самый важный город и выдавал это за общую картину.
//
// Старые строки честно помечаем Алматы: они и были Алматы, других замеров не делалось.
//
// Схему меняем сырым SQL, а не Prisma: см. CLAUDE.md, `prisma db push` в этом проекте
// запускать нельзя.
require('dotenv').config();
const db = require('../db/init');

const APPLY = process.argv.includes('--apply');
const ALMATY = '750000000';

const STEPS = [
  ['добавить city_id в product_card_ranks',
    `ALTER TABLE product_card_ranks ADD COLUMN IF NOT EXISTS city_id VARCHAR(16)`],
  ['проставить Алматы старым строкам (ranks)',
    `UPDATE product_card_ranks SET city_id = '${ALMATY}' WHERE city_id IS NULL`],
  ['сделать city_id обязательным (ranks)',
    `ALTER TABLE product_card_ranks ALTER COLUMN city_id SET NOT NULL`],
  ['новый ключ (store_id, sku, city_id)',
    `ALTER TABLE product_card_ranks DROP CONSTRAINT IF EXISTS product_card_ranks_pkey`],
  ['', `ALTER TABLE product_card_ranks ADD PRIMARY KEY (store_id, sku, city_id)`],

  ['добавить city_id в product_card_rank_history',
    `ALTER TABLE product_card_rank_history ADD COLUMN IF NOT EXISTS city_id VARCHAR(16)`],
  ['проставить Алматы старым строкам (history)',
    `UPDATE product_card_rank_history SET city_id = '${ALMATY}' WHERE city_id IS NULL`],
  ['сделать city_id обязательным (history)',
    `ALTER TABLE product_card_rank_history ALTER COLUMN city_id SET NOT NULL`],
  ['новый ключ (checked_day, store_id, sku, city_id)',
    `ALTER TABLE product_card_rank_history DROP CONSTRAINT IF EXISTS product_card_rank_history_pkey`],
  ['', `ALTER TABLE product_card_rank_history ADD PRIMARY KEY (checked_day, store_id, sku, city_id)`],
  ['индекс по дню и городу',
    `CREATE INDEX IF NOT EXISTS idx_card_rank_history_day_city
       ON product_card_rank_history (checked_day DESC, city_id)`],
];

(async () => {
  const before = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM product_card_ranks) AS ranks,
            (SELECT COUNT(*)::int FROM product_card_rank_history) AS history,
            (SELECT COUNT(DISTINCT checked_day)::int FROM product_card_rank_history) AS days`
  );
  console.log('Сейчас в базе:', JSON.stringify(before.rows[0]));
  console.log(`Все эти строки будут помечены городом Алматы (${ALMATY}) — они им и были.\n`);

  if (!APPLY) {
    for (const [label, sql] of STEPS) if (label) console.log('  ' + label);
    console.log('\nЭто предпросмотр. Выполнить: node scripts/migrate-ranks-city.js --apply');
    await db.pool.end();
    return;
  }

  for (const [label, sql] of STEPS) {
    await db.query(sql);
    if (label) console.log('  ✓ ' + label);
  }

  const after = await db.query(
    `SELECT city_id, COUNT(*)::int AS n FROM product_card_rank_history GROUP BY 1 ORDER BY 1`
  );
  console.log('\nИстория по городам:');
  for (const r of after.rows) console.log(`  ${r.city_id}: ${r.n}`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
