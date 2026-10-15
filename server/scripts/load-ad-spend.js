// Расход на рекламу по дням — из выгрузки Meta Ads в таблицу ad_spend_daily.
//
//   node scripts/load-ad-spend.js                    # показать, что изменится
//   node scripts/load-ad-spend.js --apply            # записать
//   node scripts/load-ad-spend.js --file=путь.json   # другая выгрузка
//
// Откуда берутся данные. Токена Meta у сервиса нет и заводить его ради одной цифры
// в неделю незачем: выгрузку снимает человек через кабинет или через MCP Meta Ads
// (уровень ad set, time_increment = 1, date_preset = maximum, поля amount_spent,
// impressions, clicks, outbound_clicks, link_click, destination_type, campaign_name)
// и кладёт в server/data/ad-spend.json. Скрипт только переносит её в базу.
//
// Почему уровень ГРУППЫ, а не кампании: цель задаётся на кампании, а куда ведёт
// объявление - на группе, и они расходятся молча. Кампания «Этно комод 3.09 широкая»
// стоит с целью ПРОДАЖИ, а группа внутри неё ведёт в WhatsApp и Direct (196,76 $ и
// ни одного перехода на карточку). Считать направление по objective - значит
// записать эти деньги в трафик на Kaspi, которого там не было.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db/init');

const APPLY = process.argv.includes('--apply');
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const FILE = fileArg ? fileArg.slice(7) : path.join(__dirname, '..', 'data', 'ad-spend.json');

const m = (v) => Math.round(Number(v) || 0).toLocaleString('ru-RU');

(async () => {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const rows = raw.rows || [];
  if (!rows.length) {
    console.log('В выгрузке нет строк.');
    await db.pool.end();
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS ad_spend_daily (
      day              DATE NOT NULL,
      account_id       TEXT NOT NULL,
      adset_id         TEXT NOT NULL,
      adset_name       TEXT,
      campaign_name    TEXT,
      destination_type TEXT,
      objective        TEXT,
      spend_usd        NUMERIC(12,2) NOT NULL DEFAULT 0,
      impressions      INTEGER NOT NULL DEFAULT 0,
      clicks           INTEGER NOT NULL DEFAULT 0,
      outbound_clicks  INTEGER NOT NULL DEFAULT 0,
      link_clicks      INTEGER NOT NULL DEFAULT 0,
      loaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (day, adset_id)
    )`);
  await db.query('CREATE INDEX IF NOT EXISTS idx_ad_spend_day ON ad_spend_daily (day)');

  const { rows: before } = await db.query(
    'SELECT COUNT(*)::int AS n, COALESCE(SUM(spend_usd), 0)::numeric AS usd, MAX(day)::text AS last FROM ad_spend_daily'
  );
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const total = rows.reduce((a, r) => a + Number(r.spend_usd), 0);

  console.log(`Выгрузка ${FILE}`);
  console.log(`  строк ${rows.length}, дней ${days.length}: ${days[0]} — ${days[days.length - 1]}`);
  console.log(`  расход ${total.toFixed(2)} $`);
  console.log(`В базе сейчас: строк ${before[0].n}, ${Number(before[0].usd).toFixed(2)} $, последний день ${before[0].last || '—'}`);

  if (!APPLY) {
    console.log('\nЭто предпросмотр. Записать: node scripts/load-ad-spend.js --apply');
    await db.pool.end();
    return;
  }

  // Ключ (день, группа объявлений): повторная выгрузка того же периода должна
  // перезаписывать строки, а не удваивать расход.
  let written = 0;
  for (const r of rows) {
    await db.query(
      `INSERT INTO ad_spend_daily
         (day, account_id, adset_id, adset_name, campaign_name, destination_type, objective,
          spend_usd, impressions, clicks, outbound_clicks, link_clicks, loaded_at)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (day, adset_id) DO UPDATE SET
         adset_name = EXCLUDED.adset_name, campaign_name = EXCLUDED.campaign_name,
         destination_type = EXCLUDED.destination_type, objective = EXCLUDED.objective,
         spend_usd = EXCLUDED.spend_usd, impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks, outbound_clicks = EXCLUDED.outbound_clicks,
         link_clicks = EXCLUDED.link_clicks, loaded_at = NOW()`,
      [r.day, raw.account_id, r.adset_id, r.adset_name, r.campaign_name, r.destination_type,
        r.objective, r.spend_usd, r.impressions, r.clicks, r.outbound_clicks, r.link_clicks]
    );
    written += 1;
  }

  const { rows: after } = await db.query(
    'SELECT COUNT(*)::int AS n, COALESCE(SUM(spend_usd), 0)::numeric AS usd FROM ad_spend_daily'
  );
  console.log(`\nЗаписано ${written}. В базе: ${after[0].n} строк, ${Number(after[0].usd).toFixed(2)} $ (${m(Number(after[0].usd) * 449)} ₸ по курсу 449).`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
