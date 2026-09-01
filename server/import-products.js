// Импорт полного каталога товаров магазина из CSV, выгруженного из личного кабинета Kaspi.
// Использование: node import-products.js <storeId> <путь_к_файлу.csv>
//
// Скрипт сам пытается найти нужные колонки по заголовку (артикул/sku и название/товар).
// Разделитель определяется автоматически (запятая, точка с запятой или таб).

require('dotenv').config();
const fs = require('fs');
const db = require('./db/init');

function detectDelimiter(headerLine) {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function parseCsvLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function findColumnIndex(headers, candidates) {
  const normalized = headers.map(h => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = normalized.findIndex(h => h.includes(candidate));
    if (idx !== -1) return idx;
  }
  return -1;
}

async function importProducts() {
  const storeId = process.argv[2];
  const filePath = process.argv[3];

  if (!storeId || !filePath) {
    console.error('Использование: node import-products.js <storeId> <путь_к_файлу.csv>');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Файл не найден: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);

  if (lines.length < 2) {
    console.error('Файл пустой или содержит только заголовок');
    process.exit(1);
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter);

  const skuIdx = findColumnIndex(headers, ['артикул', 'sku', 'штрихкод', 'код товара', 'код']);
  const nameIdx = findColumnIndex(headers, ['товар', 'название', 'наименование', 'name']);
  const priceIdx = findColumnIndex(headers, ['цена', 'price']);

  if (skuIdx === -1 || nameIdx === -1) {
    console.error('Не удалось найти колонки артикула и названия. Заголовки файла:', headers);
    process.exit(1);
  }

  console.log(`Заголовки: [${headers.join(' | ')}]`);
  console.log(`Колонка артикула: "${headers[skuIdx]}" (индекс ${skuIdx})`);
  console.log(`Колонка названия: "${headers[nameIdx]}" (индекс ${nameIdx})`);
  if (priceIdx !== -1) console.log(`Колонка цены: "${headers[priceIdx]}" (индекс ${priceIdx})`);

  let imported = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i], delimiter);
    const sku = row[skuIdx]?.trim();
    const name = row[nameIdx]?.trim();
    const priceRaw = priceIdx !== -1 ? row[priceIdx]?.replace(/[^\d.]/g, '') : null;
    const price = priceRaw ? parseFloat(priceRaw) : null;

    if (!sku || !name) {
      skipped++;
      continue;
    }

    await db.query(
      `INSERT INTO products (store_id, sku, name, price, source)
       VALUES ($1, $2, $3, $4, 'import')
       ON CONFLICT (store_id, sku) DO UPDATE SET
         name = EXCLUDED.name,
         price = COALESCE(EXCLUDED.price, products.price),
         source = 'import',
         updated_at = NOW()`,
      [storeId, sku, name, price]
    );
    imported++;
  }

  console.log(`\n✅ Импортировано/обновлено: ${imported}`);
  if (skipped > 0) console.log(`⚠️  Пропущено строк без артикула/названия: ${skipped}`);

  const total = await db.query('SELECT COUNT(*) FROM products WHERE store_id = $1', [storeId]);
  console.log(`📦 Всего товаров в каталоге магазина: ${total.rows[0].count}`);

  process.exit(0);
}

importProducts().catch(err => {
  console.error('Ошибка импорта:', err.message);
  process.exit(1);
});
