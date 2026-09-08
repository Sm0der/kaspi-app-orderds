const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin } = require('../middleware/requireAuth');

// Кто я и что мне можно - этот запрос делает интерфейс сразу после входа, чтобы решить,
// показывать ли настройки. Доступен любому вошедшему, поэтому объявлен до requireAdmin.
router.get('/me', (req, res) => {
  res.json({ email: req.user?.email || null, role: req.userRole });
});

// Всё остальное - только владельцу
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, email, role, note, created_at FROM app_users ORDER BY role, email'
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

// Добавить сотрудника или сменить ему роль.
// Сам аккаунт (почта + пароль) заводится в панели Supabase - здесь только права.
router.put('/', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = req.body.role === 'admin' ? 'admin' : 'manager';
    const note = String(req.body.note || '').trim() || null;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Нужна корректная почта' });
    }

    const result = await db.query(
      `INSERT INTO app_users (email, role, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, note = COALESCE(EXCLUDED.note, app_users.note)
       RETURNING id, email, role, note, created_at`,
      [email, role, note]
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    // Себя из списка администраторов не убираем: иначе панель доступов запрётся изнутри
    const target = await db.query('SELECT email FROM app_users WHERE id = $1', [req.params.id]);
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }
    if (target.rows[0].email.toLowerCase() === String(req.user?.email || '').toLowerCase()) {
      return res.status(400).json({ error: 'Нельзя убрать собственный доступ' });
    }

    await db.query('DELETE FROM app_users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
