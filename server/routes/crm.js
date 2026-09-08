const express = require('express');
const router = express.Router();
const db = require('../db/init');

// Статусы внутренней воронки компании (колонки канбан-доски). Их набор задаёт сам
// пользователь в интерфейсе, поэтому здесь обычный CRUD, а не захардкоженный список.

// GET /api/crm/statuses - колонки доски с количеством заказов в каждой
router.get('/statuses', async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT s.id, s.name, s.color, s.position,
             COUNT(o.id)::int AS orders_count
      FROM crm_statuses s
      LEFT JOIN orders o ON o.crm_status_id = s.id
      GROUP BY s.id
      ORDER BY s.position, s.id
    `);
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

// POST /api/crm/statuses - добавить колонку
router.post('/statuses', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const color = (req.body.color || '#8A8177').trim();

    if (!name) {
      return res.status(400).json({ error: 'Нужно название статуса' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'Название длиннее 100 символов' });
    }

    const result = await db.query(
      `INSERT INTO crm_statuses (name, color, position)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) FROM crm_statuses), 0) + 1)
       RETURNING id, name, color, position, 0 AS orders_count`,
      [name, color]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/crm/statuses/:id - переименовать или перекрасить
router.patch('/statuses/:id', async (req, res, next) => {
  try {
    const { name, color } = req.body;
    if (name === undefined && color === undefined) {
      return res.status(400).json({ error: 'Нечего менять: ожидается name или color' });
    }
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: 'Название не может быть пустым' });
    }

    const result = await db.query(
      `UPDATE crm_statuses
       SET name = COALESCE($2, name), color = COALESCE($3, color)
       WHERE id = $1
       RETURNING id, name, color, position`,
      [req.params.id, name !== undefined ? String(name).trim() : null, color ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Статус не найден' });
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/crm/statuses/order - новый порядок колонок: { ids: [3, 1, 2] }
router.put('/statuses/order', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'ids должен быть непустым массивом' });
    }

    // Один запрос вместо N: позиция берётся из порядка элементов в массиве
    await db.query(
      `UPDATE crm_statuses s
       SET position = new_order.position
       FROM (SELECT id, ordinality AS position FROM unnest($1::int[]) WITH ORDINALITY AS t(id, ordinality)) AS new_order
       WHERE s.id = new_order.id`,
      [ids]
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/crm/statuses/:id - удалить колонку (заказы из неё остаются без статуса)
router.delete('/statuses/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM crm_statuses WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Статус не найден' });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// PUT /api/crm/orders - перенести заказы в статус: { orderCodes: [...], statusId: 3 | null }
router.put('/orders', async (req, res, next) => {
  try {
    const { orderCodes, statusId } = req.body;
    if (!Array.isArray(orderCodes) || orderCodes.length === 0) {
      return res.status(400).json({ error: 'orderCodes должен быть непустым массивом' });
    }

    if (statusId !== null && statusId !== undefined) {
      const exists = await db.query('SELECT 1 FROM crm_statuses WHERE id = $1', [statusId]);
      if (exists.rows.length === 0) {
        return res.status(400).json({ error: 'Такого статуса нет' });
      }
    }

    const result = await db.query(
      `UPDATE orders
       SET crm_status_id = $1, crm_status_changed_at = NOW()
       WHERE order_code = ANY($2)
       RETURNING order_code, crm_status_id`,
      [statusId ?? null, orderCodes.map(String)]
    );

    res.json({ updated: result.rows.length, data: result.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
