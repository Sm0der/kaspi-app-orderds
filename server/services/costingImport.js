const axios = require('axios');
const db = require('../db/init');

// Перенос таблицы себестоимости главного технолога из Google Таблицы.
//
// Почему сервер ходит в таблицу сам, а не грузим файл руками: пока технолог переезжает,
// он продолжает вести таблицу, и импорт нужно повторять. Таблица открыта по ссылке,
// экспорт листа в CSV доступен без авторизации - этого достаточно.
//
// Структура таблицы: лист на каждое изделие (спецификация: позиция, количество, цена,
// сумма), лист «СметаПрисадки» (внутренние коды SH-4001 и нормы присадки) и сводные
// «ПРАЙС» и «Расчет рентабельности» - последние мы не переносим, они считаются сами.

const SHEET_ID = '1n3GUZcbzQ9a2hg-6nxjRFcUf6dx2bdQ7XaTf-HBDxvw';
const SERVICE_TABS = new Set(['Расчет рентабельности позиций', 'ПРАЙС', 'СметаПрисадки', 'ШАБЛОН']);

// Названия строк, которые в листе изделия идут после спецификации: это не материалы,
// а подписи тарифов и итогов. В спецификацию их пускать нельзя.
const TAIL_ROWS = [/^Итого/i, /^Стоимость работ/i, /^Отпрака|^Отправка/i, /^Прочие/i, /^Наименование$/i, /^Фурнитура$/i];

const csvUrl = (gid) => `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// В таблице числа записаны по-русски: пробелы как разделитель тысяч, запятая как дробная
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseFloat(String(value).replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isNaN(parsed) ? null : parsed;
}

async function fetchTabs() {
  const { data } = await axios.get(
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`,
    { timeout: 30000, responseType: 'text' }
  );
  const tabs = [];
  const re = /items\.push\(\{name: "([^"]+)"[\s\S]{0,200}?gid: "(\d+)"/g;
  let match;
  while ((match = re.exec(data))) tabs.push({ name: match[1], gid: match[2] });
  return tabs;
}

async function fetchSheet(gid) {
  const { data } = await axios.get(csvUrl(gid), { timeout: 30000, responseType: 'text' });
  return parseCsv(data);
}

// Единица измерения зашита в само название: «ЛДСП (Белый), кв», «ПВХ, м», «Штанга, м 760 - 2 шт»
function unitOf(name) {
  if (/,\s*кв\b|\(кв\s*м\)|\bкв\b/i.test(name)) return 'кв.м';
  if (/,\s*м\b|\(м\)|\bп\.\s*м\b/i.test(name)) return 'м';
  return 'шт';
}

function kindOf(name) {
  if (/^Упаковка/i.test(name)) return 'packaging';
  if (/^(ЛДСП|ХДФ|ПВХ|МДФ|Зеркало|Шлифовка)/i.test(name)) return 'material';
  return 'fittings';
}

function countsAs(name) {
  if (/^ЛДСП/i.test(name)) return 'saw_area';
  if (/^ПВХ/i.test(name)) return 'edge_length';
  return null;
}

// SH-4001 → категория SH, 4 двери, 0 ящиков, порядковый 01
function parseCode(code) {
  // Пятая цифра встречается у исполнений одного изделия (KM-13031 и KM-13032 - комод
  // Акрос в двух цветах). На разбор она не влияет, но код сохраняем целиком.
  const match = /^([A-Z]{2})-(\d)(\d)(\d{2})\d?$/.exec(String(code || '').trim());
  if (!match) return null;
  return { category: match[1], doors: +match[2], drawers: +match[3], serialNo: +match[4] };
}

const normalize = (s) => String(s || '').toLowerCase().replace(/[^а-яёa-z0-9]/gi, '');

async function runImport() {
  const tabs = await fetchTabs();
  if (tabs.length === 0) throw new Error('Не удалось прочитать список листов таблицы');

  // 1. Коды и нормы присадки - по ним изделия получают код SH-4001 и стоимость присадки
  const smetaTab = tabs.find(t => t.name === 'СметаПрисадки');
  const drillingByName = new Map();
  if (smetaTab) {
    for (const row of (await fetchSheet(smetaTab.gid)).slice(1)) {
      const code = String(row[1] || '').trim();
      if (!/^[A-Z]{2}-\d{4,5}$/.test(code)) continue;
      drillingByName.set(normalize(row[2]), {
        code,
        confirmats: num(row[3]), eccentrics: num(row[4]), screws: num(row[5]),
        shelfHolders: num(row[6]), handles: num(row[7]), hinges: num(row[8]),
        groove: num(row[9]), parts: num(row[10]), area: num(row[11]), seconds: num(row[12]),
        loadFactor: num(row[14]), extraSeconds: num(row[15]),
        payPerItem: num(row[16]), total: num(row[17])
      });
    }
  }

  // Сопоставляем лист изделия с кодом ОСТОРОЖНО. Нестрогое совпадение по вхождению
  // подставляет чужие коды: «Комод Берлин Дэй» получил бы код ТВ-тумбы Берлин дэй,
  // а «Шкаф Монро» - код комода Монро. Поэтому: точное совпадение, иначе единственное
  // совпадение по началу названия («Комод Венеция» → «Комод Венеция (Белый)»).
  // Если кандидатов несколько - у изделия в таблице несколько исполнений («Комод Акрос
  // (Б)», «(ДС)», «(ДС/Б)») - код не угадываем, его проставит технолог.
  function matchDrilling(title, tabName) {
    for (const key of [normalize(title), normalize(tabName)]) {
      if (drillingByName.has(key)) return { drilling: drillingByName.get(key) };
      const candidates = [...drillingByName.entries()].filter(([name]) => name.startsWith(key));
      if (candidates.length === 1) return { drilling: candidates[0][1] };
      if (candidates.length > 1) return { ambiguous: candidates.map(([, d]) => d.code) };
    }
    return {};
  }

  const productTabs = tabs.filter(t => !SERVICE_TABS.has(t.name));
  const report = { products: 0, items: 0, lines: 0, withCode: 0, skipped: [], needCode: [] };

  for (const tab of productTabs) {
    const rows = await fetchSheet(tab.gid);
    const title = String(rows[0]?.[0] || tab.name).trim();
    if (!title) { report.skipped.push(tab.name); continue; }

    const match = matchDrilling(title, tab.name);
    const drilling = match.drilling || null;
    const parsedCode = drilling ? parseCode(drilling.code) : null;
    if (!drilling) {
      report.needCode.push({
        name: title,
        // Технологу важно знать, почему кода нет: его вовсе нет в смете или исполнений несколько
        reason: match.ambiguous ? `несколько исполнений: ${match.ambiguous.join(', ')}` : 'нет в СметеПрисадки'
      });
    }

    // Тарифы работ подписаны в хвосте листа, у каждого изделия свои
    const tailValue = (re) => {
      const row = rows.find(r => re.test(String(r[0] || '')));
      return row ? num(row[2]) : null;
    };
    const ratePack = tailValue(/^Стоимость работы по упаковке/i);
    const rateShip = tailValue(/^Отпрака|^Отправка/i);
    const rateOverhead = tailValue(/^Прочие операционные/i);
    const rateSaw = tailValue(/^Стоимость работ по распилу/i);
    // Кромка: в подписях листов местами осталось 15, но весь ПРАЙС посчитан по 20 -
    // берём значение из листа только если оно есть, иначе ставим 20
    const rateEdge = tailValue(/^Стоимость работ по кромкооблицовке/i);

    // Изделие узнаём по ЛИСТУ, а не по названию: в таблице нашёлся лист «ТВТумбаВенеция2»
    // с заголовком «ТВ Тумба Милан Дэй» - лист скопировали и не переименовали. Привязка по
    // названию затёрла бы одно изделие другим молча.
    //
    // Код ставим, только если он свободен: тот же скопированный лист претендует на чужой код.
    let code = drilling?.code || null;
    if (code) {
      const taken = await db.query(
        'SELECT source_tab FROM cost_products WHERE code = $1 AND source_tab IS DISTINCT FROM $2',
        [code, tab.name]
      );
      if (taken.rows.length > 0) {
        report.needCode.push({
          name: title,
          reason: `код ${code} уже у листа «${taken.rows[0].source_tab}» — проверьте заголовок листа «${tab.name}»`
        });
        code = null;
      }
    }

    const existing = await db.query('SELECT id FROM cost_products WHERE source_tab = $1', [tab.name]);
    const values = [
      code, title, code ? parsedCode?.category ?? null : null,
      code ? parsedCode?.doors ?? null : null, code ? parsedCode?.drawers ?? null : null,
      code ? parsedCode?.serialNo ?? null : null,
      rateSaw ?? 100, rateEdge ?? 20, ratePack ?? 650, rateShip ?? 350, rateOverhead ?? 2000,
      drilling?.total ?? 0, tab.name
    ];

    let productId;
    if (existing.rows.length > 0) {
      productId = existing.rows[0].id;
      await db.query(
        `UPDATE cost_products SET code = $1, name = $2, category = $3, doors = $4, drawers = $5,
           serial_no = $6, rate_saw = $7, rate_edge = $8, rate_pack = $9, rate_ship = $10,
           rate_overhead = $11, drilling_cost = $12, source_tab = $13, updated_at = NOW()
         WHERE id = $14`,
        [...values, productId]
      );
    } else {
      const inserted = await db.query(
        `INSERT INTO cost_products (code, name, category, doors, drawers, serial_no,
           rate_saw, rate_edge, rate_pack, rate_ship, rate_overhead, drilling_cost, source_tab, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW()) RETURNING id`,
        values
      );
      productId = inserted.rows[0].id;
    }

    if (code) report.withCode++;
    report.products++;

    if (drilling) {
      await db.query(
        `INSERT INTO cost_drilling (product_id, confirmats, eccentrics, screws, shelf_holders,
           handles, hinges, groove, parts, area, seconds, load_factor, extra_seconds, pay_per_item, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (product_id) DO UPDATE SET
           confirmats = EXCLUDED.confirmats, eccentrics = EXCLUDED.eccentrics,
           screws = EXCLUDED.screws, shelf_holders = EXCLUDED.shelf_holders,
           handles = EXCLUDED.handles, hinges = EXCLUDED.hinges, groove = EXCLUDED.groove,
           parts = EXCLUDED.parts, area = EXCLUDED.area, seconds = EXCLUDED.seconds,
           load_factor = EXCLUDED.load_factor, extra_seconds = EXCLUDED.extra_seconds,
           pay_per_item = EXCLUDED.pay_per_item, total = EXCLUDED.total`,
        [productId, drilling.confirmats, drilling.eccentrics, drilling.screws, drilling.shelfHolders,
         drilling.handles, drilling.hinges, drilling.groove, drilling.parts, drilling.area,
         drilling.seconds, drilling.loadFactor, drilling.extraSeconds, drilling.payPerItem, drilling.total]
      );
    }

    // Спецификация. Переносим только строки с количеством: в листе больше шестидесяти
    // позиций, и почти все стоят с нулём - это шаблон, а не состав конкретного изделия.
    await db.query('DELETE FROM cost_product_items WHERE product_id = $1', [productId]);
    let position = 0;
    for (const row of rows) {
      const name = String(row[0] || '').trim();
      if (!name || TAIL_ROWS.some(re => re.test(name))) continue;
      const quantity = num(row[1]);
      const price = num(row[2]);
      if (!quantity || quantity <= 0) continue;

      position += 10;
      const item = await db.query(
        `INSERT INTO cost_items (name, unit, kind, counts_as, default_price, position)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (name) DO UPDATE SET
           unit = COALESCE(cost_items.unit, EXCLUDED.unit),
           default_price = COALESCE(cost_items.default_price, EXCLUDED.default_price)
         RETURNING id, (xmax = 0) AS inserted`,
        [name, unitOf(name), kindOf(name), countsAs(name), price, position]
      );
      if (item.rows[0].inserted) report.items++;

      await db.query(
        `INSERT INTO cost_product_items (product_id, item_id, quantity, price)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_id, item_id) DO UPDATE SET
           quantity = EXCLUDED.quantity, price = EXCLUDED.price`,
        [productId, item.rows[0].id, quantity, price ?? 0]
      );
      report.lines++;
    }
  }

  return report;
}

module.exports = { runImport, parseCode, parseCsv, num };
