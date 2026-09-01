const express = require('express');
const router = express.Router();

// Простая авторизация - в продакшене сделать правильно
// POST /api/auth/login - Логин (временная реализация)
router.post('/login', (req, res) => {
  const { password } = req.body;

  // Временная проверка - в продакшене использовать правильную авторизацию
  if (password === process.env.AUTH_SECRET || password === 'admin') {
    res.json({
      token: Buffer.from(JSON.stringify({ admin: true })).toString('base64'),
      message: 'Login successful'
    });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// GET /api/auth/verify - Проверить токен
router.get('/verify', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token' });
  }

  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    res.json({ valid: true, data: decoded });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
