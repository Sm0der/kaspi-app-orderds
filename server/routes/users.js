const express = require('express');
const router = express.Router();

// Кто я и что мне можно - этот запрос интерфейс делает сразу после входа, чтобы решить,
// показывать ли настройки.
//
// Заведение сотрудников, роли и пароли переехали в приложение склада: /sklad/admin/users.
// Раньше права лежали здесь, в app_users, а сами аккаунты - в панели Supabase; теперь
// у системы одна таблица людей (production_users) и один вход, поэтому двух панелей
// доступов быть не должно - разъедутся.
router.get('/me', (req, res) => {
  res.json({ email: req.user?.email || null, role: req.userRole });
});

module.exports = router;
