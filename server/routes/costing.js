const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireCosting } = require('../middleware/requireAuth');
const { runImport } = require('../services/costingImport');
const { calculate } = require('../services/costingMath');

// Себестоимость изделий. Перенос таблицы главного технолога: спецификация, нормы присадки,
// тарифы работ. Цены считаются здесь, а не хранятся: в таблице сводные листы отставали от
// листов изделий (74 позиции в ПРАЙС против 61 в рентабельности), и расхождение никто не замечал.
router.use(requireCosting);

const LINES_SQL = `
  SELECT pi.id, pi.item_id, pi.quantity, pi.price,
         i.name, i.unit, i.kind, i.counts_as, i.position
  FROM cost_product_items pi
  JOIN cost_items i ON i.id = pi.item_id
  WHERE pi.product_id = $1
  ORDER BY i.position, i.name`;

// GET /api/costing/products - список изделий с посчитанной себестоимостью и ценами
router.get('/products', async (req, res, next) => {
  try {
    const { rows: products } = await db.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM products k WHERE k.cost_product_id = p.id)::int AS linked_skus
       FROM cost_products p ORDER BY p.category NULLS LAST, p.code NULLS LAST, p.name`
    );
    const { rows: allLines } = await db.query(`
      SELECT pi.product_id, pi.quantity, pi.price, i.kind, i.counts_as
      FROM cost_product_items pi JOIN cost_items i ON i.id = pi.item_id`);

    const byProduct = new Map();
    for (const line of allLines) {
      if (!byProduct.has(line.product_id)) byProduct.set(line.product_id, []);
      byProduct.get(line.product_id).push(line);
    }

    res.json({
      products: products.map(p => ({ ...p, totals: calculate(p, byProduct.get(p.id) || []) }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/costing/products/:id - изделие целиком: спецификация, присадка, расчёт
router.get('/products/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cost_products WHERE id = $1', [req.params.id]);
    const product = rows[0];
    if (!product) return res.status(404).json({ error: 'Изделие не найдено' });

    const { rows: lines } = await db.query(LINES_SQL, [product.id]);
    const { rows: drilling } = await db.query('SELECT * FROM cost_drilling WHERE product_id = $1', [product.id]);
    const { rows: skus } = await db.query(
      `SELECT p.sku, p.name, p.store_id, s.name AS store_name
       FROM products p LEFT JOIN stores s ON s.id = p.store_id
       WHERE p.cost_product_id = $1 ORDER BY p.store_id, p.name`,
      [product.id]
    );

    res.json({ product, lines, drilling: drilling[0] || null, skus, totals: calculate(product, lines) });
  } catch (error) {
    next(error);
  }
});

// PUT /api/costing/products/:id - название, код и тарифы работ
router.put('/products/:id', async (req, res, next) => {
  try {
    const { name, code, rate_saw, rate_edge, rate_pack, rate_ship, rate_overhead,
            drilling_cost, margin_divisor, margin_rate, kaspi_markup } = req.body;

    // Код разбираем на составляющие здесь же: SH-4001 - шкаф, 4 двери, 0 ящиков, номер 01.
    // Пятая цифра - исполнение одного изделия (KM-13031, KM-13032): на разбор не влияет.
    let parts = { category: null, doors: null, drawers: null, serial_no: null };
    if (code) {
      const match = /^([A-Z]{2})-(\d)(\d)(\d{2})\d?$/.exec(String(code).trim().toUpperCase());
      if (!match) {
        return res.status(400).json({ error: 'Код в формате SH-4001: две буквы категории, двери, ящики, номер (и цифра исполнения, если оно не одно)' });
      }
      parts = { category: match[1], doors: +match[2], drawers: +match[3], serial_no: +match[4] };
    }

    const { rows } = await db.query(
      `UPDATE cost_products SET
         name = COALESCE($2, name),
         code = COALESCE($3, code),
         category = COALESCE($4, category),
         doors = COALESCE($5, doors),
         drawers = COALESCE($6, drawers),
         serial_no = COALESCE($7, serial_no),
         rate_saw = COALESCE($8, rate_saw),
         rate_edge = COALESCE($9, rate_edge),
         rate_pack = COALESCE($10, rate_pack),
         rate_ship = COALESCE($11, rate_ship),
         rate_overhead = COALESCE($12, rate_overhead),
         drilling_cost = COALESCE($13, drilling_cost),
         margin_divisor = COALESCE($14, margin_divisor),
         margin_rate = COALESCE($15, margin_rate),
         kaspi_markup = COALESCE($16, kaspi_markup),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name ?? null, code ? String(code).trim().toUpperCase() : null,
       parts.category, parts.doors, parts.drawers, parts.serial_no,
       rate_saw ?? null, rate_edge ?? null, rate_pack ?? null, rate_ship ?? null,
       rate_overhead ?? null, drilling_cost ?? null, margin_divisor ?? null,
       margin_rate ?? null, kaspi_markup ?? null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Изделие не найдено' });

    const { rows: lines } = await db.query(LINES_SQL, [req.params.id]);
    res.json({ product: rows[0], totals: calculate(rows[0], lines) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Такой код уже занят другим изделием' });
    next(error);
  }
});

// PUT /api/costing/lines/:id - количество и цена строки спецификации
router.put('/lines/:id', async (req, res, next) => {
  try {
    const { quantity, price } = req.body;
    const { rows } = await db.query(
      `UPDATE cost_product_items SET quantity = COALESCE($2, quantity), price = COALESCE($3, price)
       WHERE id = $1 RETURNING product_id`,
      [req.params.id, quantity ?? null, price ?? null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Строка не найдена' });
    res.json({ ok: true, productId: rows[0].product_id });
  } catch (error) {
    next(error);
  }
});

// POST /api/costing/products/:id/lines - добавить позицию в спецификацию
router.post('/products/:id/lines', async (req, res, next) => {
  try {
    const { itemId, name, quantity, price } = req.body;
    let finalItemId = itemId;

    if (!finalItemId) {
      if (!name) return res.status(400).json({ error: 'Нужна позиция: выберите из справочника или впишите название' });
      const { rows } = await db.query(
        `INSERT INTO cost_items (name, unit, kind, default_price)
         VALUES ($1, 'шт', 'fittings', $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [String(name).trim(), price ?? null]
      );
      finalItemId = rows[0].id;
    }

    const { rows } = await db.query(
      `INSERT INTO cost_product_items (product_id, item_id, quantity, price)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (product_id, item_id) DO UPDATE SET
         quantity = EXCLUDED.quantity, price = EXCLUDED.price
       RETURNING id`,
      [req.params.id, finalItemId, quantity || 0, price || 0]
    );
    res.json({ ok: true, lineId: rows[0].id });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/costing/lines/:id
router.delete('/lines/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM cost_product_items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// PUT /api/costing/items/:id/price - поднять цену позиции сразу во всех изделиях.
// Ровно та работа, ради которой переезжали: в таблице цену навеса приходилось править
// в 74 листах руками. Цена при этом остаётся своей у каждого изделия - здесь просто
// массовая замена, и она возвращает, сколько изделий затронула.
router.put('/items/:id/price', async (req, res, next) => {
  try {
    const price = Number(req.body.price);
    if (!(price >= 0)) return res.status(400).json({ error: 'Цена - число от 0' });
    const onlyOldPrice = req.body.onlyOldPrice !== undefined ? Number(req.body.onlyOldPrice) : null;

    const params = [req.params.id, price];
    let where = 'item_id = $1';
    if (onlyOldPrice !== null) {
      params.push(onlyOldPrice);
      where += ` AND price = $3`;
    }

    const { rowCount } = await db.query(
      `UPDATE cost_product_items SET price = $2 WHERE ${where}`, params
    );
    await db.query('UPDATE cost_items SET default_price = $2 WHERE id = $1', [req.params.id, price]);
    res.json({ ok: true, updated: rowCount });
  } catch (error) {
    next(error);
  }
});

// PUT /api/costing/rates - поставить тариф работ сразу всем изделиям.
// Тарифы в листах разошлись (кромка 15 у 63 изделий и 20 у 11, притом весь ПРАЙС
// посчитан по 20), и править их по одному - та же работа, от которой уходим.
const RATE_FIELDS = ['rate_saw', 'rate_edge', 'rate_pack', 'rate_ship', 'rate_overhead',
                     'margin_divisor', 'margin_rate', 'kaspi_markup'];

router.put('/rates', async (req, res, next) => {
  try {
    const { field } = req.body;
    const value = Number(req.body.value);
    if (!RATE_FIELDS.includes(field)) return res.status(400).json({ error: 'Неизвестный тариф' });
    if (!(value >= 0)) return res.status(400).json({ error: 'Значение - число от 0' });

    const { rowCount } = await db.query(
      `UPDATE cost_products SET ${field} = $1, updated_at = NOW() WHERE ${field} IS DISTINCT FROM $1`,
      [value]
    );
    res.json({ ok: true, updated: rowCount });
  } catch (error) {
    next(error);
  }
});

// GET /api/costing/items - справочник позиций с разбросом цен по изделиям.
// Разброс показываем специально: именно он подсказывает технологу, где цена отстала.
router.get('/items', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT i.id, i.name, i.unit, i.kind, i.default_price,
             COUNT(pi.id)::int AS used_in,
             MIN(pi.price) AS min_price,
             MAX(pi.price) AS max_price,
             COUNT(DISTINCT pi.price)::int AS price_variants
      FROM cost_items i
      LEFT JOIN cost_product_items pi ON pi.item_id = i.id
      GROUP BY i.id
      ORDER BY price_variants DESC, used_in DESC, i.name`);
    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

// PUT /api/costing/products/:id/skus - какие артикулы Kaspi считать этим изделием.
// От этой связи зависит и себестоимость по заказам, и код изделия на этикетке коробки.
router.put('/products/:id/skus', async (req, res, next) => {
  try {
    const skus = Array.isArray(req.body.skus) ? req.body.skus.map(s => String(s).trim()).filter(Boolean) : [];
    await db.query('UPDATE products SET cost_product_id = NULL WHERE cost_product_id = $1', [req.params.id]);
    if (skus.length > 0) {
      await db.query('UPDATE products SET cost_product_id = $1 WHERE sku = ANY($2)', [req.params.id, skus]);
    }
    const { rows } = await db.query(
      'SELECT sku, name, store_id FROM products WHERE cost_product_id = $1 ORDER BY store_id, name',
      [req.params.id]
    );
    res.json({ ok: true, skus: rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/costing/unlinked - товары Kaspi без изделия, чтобы связь можно было доделать
router.get('/unlinked', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [];
    let where = 'p.cost_product_id IS NULL';
    if (q) {
      for (const word of q.split(/\s+/).slice(0, 6)) {
        params.push(`%${word}%`);
        where += ` AND p.name ILIKE $${params.length}`;
      }
    }
    const { rows } = await db.query(
      `SELECT p.sku, p.name, p.store_id, s.name AS store_name
       FROM products p LEFT JOIN stores s ON s.id = p.store_id
       WHERE ${where} ORDER BY p.name LIMIT 60`, params
    );
    res.json({ products: rows });
  } catch (error) {
    next(error);
  }
});

// POST /api/costing/import - перенести данные из Google Таблицы технолога.
// Нужен, пока таблица остаётся источником правды: технолог правит её, сервис догоняет.
router.post('/import', async (req, res, next) => {
  try {
    const report = await runImport();
    res.json({ ok: true, ...report });
  } catch (error) {
    console.error('Costing import failed:', error.message);
    res.status(502).json({ error: `Не удалось прочитать таблицу: ${error.message}` });
  }
});

module.exports = router;
