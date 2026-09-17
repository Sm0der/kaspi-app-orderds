const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin } = require('../middleware/requireAuth');

// Справочники, которые раньше правились только руками в базе: каталог товаров
// (категория, картинка, правило упаковки) и магазины с их токенами Kaspi. Правило
// упаковки уже редактировалось из «Отгрузки» по одному SKU за раз - здесь тот же
// эндпоинт, но с обзором всего каталога и поиском.
//
// Только владелец: токен Kaspi - это ключ от магазина целиком, и список товаров
// со всеми ценами закупки не нужен ни менеджеру, ни технологу.
router.use(requireAdmin);

// GET /api/admin/products - каталог с поиском и пагинацией
router.get('/products', async (req, res, next) => {
  try {
    const { q, storeId, missingImage } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage) || 50));

    const params = [];
    const where = ['1=1'];

    if (storeId) {
      params.push(Number(storeId));
      where.push(`p.store_id = $${params.length}`);
    }
    if (missingImage === '1') {
      where.push('p.image_url IS NULL');
    }
    // По словам и через И - как и везде в поиске каталога, чтобы не расходиться с фильтрами заказов
    if (q) {
      for (const word of String(q).trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
        params.push(`%${word}%`);
        where.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
      }
    }

    const whereSql = where.join(' AND ');
    const countResult = await db.query(`SELECT COUNT(*)::int AS total FROM products p WHERE ${whereSql}`, params);

    params.push(perPage, (page - 1) * perPage);
    const { rows } = await db.query(
      `SELECT p.id, p.sku, p.name, p.category, p.price, p.image_url, p.spaces_per_unit,
              p.source, p.store_id, s.name AS store_name, p.cost_product_id, cp.code AS cost_code
       FROM products p
       LEFT JOIN stores s ON s.id = p.store_id
       LEFT JOIN cost_products cp ON cp.id = p.cost_product_id
       WHERE ${whereSql}
       ORDER BY p.name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ products: rows, total: countResult.rows[0].total, page, perPage });
  } catch (error) {
    next(error);
  }
});

// PUT /api/admin/products/:id - категория, цена, картинка, правило упаковки
router.put('/products/:id', async (req, res, next) => {
  try {
    const { category, price, image_url: imageUrl, spaces_per_unit: spacesPerUnit } = req.body;

    if (spacesPerUnit !== undefined && spacesPerUnit !== null && Number(spacesPerUnit) <= 0) {
      return res.status(400).json({ error: 'Мест на 1 шт должно быть больше 0' });
    }

    const { rows } = await db.query(
      `UPDATE products SET
         category = COALESCE($2, category),
         price = COALESCE($3, price),
         image_url = COALESCE($4, image_url),
         spaces_per_unit = COALESCE($5, spaces_per_unit),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, sku, name, category, price, image_url, spaces_per_unit`,
      [req.params.id, category ?? null, price ?? null, imageUrl ?? null, spacesPerUnit ?? null]
    );

    if (!rows.length) return res.status(404).json({ error: 'Товар не найден' });
    res.json({ product: rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/products/categories - какие категории уже встречаются, для подсказки в форме
router.get('/products/categories', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category`
    );
    res.json({ categories: rows.map((r) => r.category) });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/stores - магазины. Токен не отдаём целиком: показываем последние 4
// символа, чтобы владелец мог узнать, какой токен вписан, не раскрывая его в трафике.
router.get('/stores', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.kaspi_merchant_uid,
              RIGHT(s.api_token, 4) AS token_tail,
              (SELECT COUNT(*)::int FROM products WHERE store_id = s.id) AS products_count,
              (SELECT COUNT(*)::int FROM orders WHERE store_id = s.id) AS orders_count
       FROM stores s ORDER BY s.name`
    );
    res.json({ stores: rows });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/stores - новый магазин
router.post('/stores', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const apiToken = String(req.body.apiToken || '').trim();
    const merchantUid = req.body.merchantUid ? String(req.body.merchantUid).trim() : null;

    if (!name) return res.status(400).json({ error: 'Укажите название магазина' });
    if (!apiToken) return res.status(400).json({ error: 'Укажите API-токен Kaspi' });

    const { rows } = await db.query(
      `INSERT INTO stores (name, api_token, kaspi_merchant_uid) VALUES ($1, $2, $3)
       RETURNING id, name, kaspi_merchant_uid`,
      [name, apiToken, merchantUid]
    );
    res.status(201).json({ store: rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/admin/stores/:id - переименовать или сменить токен (например, при ротации в
// кабинете Kaspi). Поле apiToken необязательно: пустое или отсутствующее не трогает старый.
router.put('/stores/:id', async (req, res, next) => {
  try {
    const name = req.body.name !== undefined ? String(req.body.name).trim() : null;
    const apiToken = req.body.apiToken ? String(req.body.apiToken).trim() : null;
    // merchantUid трогаем, только если поле реально прислали - пустая строка означает
    // "очистить", а отсутствие поля означает "не менять".
    const touchesMerchantUid = req.body.merchantUid !== undefined;
    const merchantUid = touchesMerchantUid ? String(req.body.merchantUid).trim() || null : null;

    const { rows } = await db.query(
      `UPDATE stores SET
         name = COALESCE($2, name),
         api_token = COALESCE($3, api_token),
         kaspi_merchant_uid = CASE WHEN $4 THEN $5 ELSE kaspi_merchant_uid END
       WHERE id = $1
       RETURNING id, name, kaspi_merchant_uid`,
      [req.params.id, name || null, apiToken, touchesMerchantUid, merchantUid]
    );

    if (!rows.length) return res.status(404).json({ error: 'Магазин не найден' });
    res.json({ store: rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
