const jwt = require('jsonwebtoken');
const db = require('../db/init');

// Вход в системе один, и выдаёт токен приложение склада (production/warehouse-production-app,
// раздел /sklad того же домена). Здесь мы токен только проверяем: тот же секрет, тот же
// алгоритм - никаких сетевых запросов, в отличие от прежней проверки через Supabase Auth.
//
// Секрет обязателен: без него любой смог бы подписать себе токен администратора, поэтому
// молча подставлять значение по умолчанию нельзя - лучше честно не пускать никого.
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('⚠️  JWT_SECRET не задан - вход работать не будет. Значение то же, что у приложения склада.');
}

// Ролей в системе семь (см. src/lib/roles.ts у склада), но дашборду заказов важны две:
// владелец видит настройки, менеджер работает с заказами. Всем остальным - упаковщику,
// кладовщику, цеху - здесь делать нечего, их место на складе.
const DASHBOARD_ROLES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
};

async function roleFor(email) {
  if (!email) return null;

  const result = await db.query(
    'SELECT role, is_active FROM production_users WHERE lower(email) = lower($1)',
    [email]
  );
  const person = result.rows[0];
  if (!person || !person.is_active) return null;

  return DASHBOARD_ROLES[person.role] || null;
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'Сервер не настроен: нет JWT_SECRET' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Недействительный или истёкший токен' });
  }

  try {
    // Роль читаем из базы, а не из токена: токен живёт неделю, и уволенный сотрудник
    // с уже выданным токеном иначе продолжал бы работать до самого истечения.
    const role = await roleFor(payload.email);
    if (!role) {
      return res.status(403).json({ error: 'Этот раздел вам не открыт - вам на склад' });
    }

    req.user = { id: payload.userId, email: payload.email };
    req.userRole = role;
    next();
  } catch (error) {
    console.error('Auth lookup failed:', error);
    res.status(500).json({ error: 'Не удалось проверить доступ' });
  }
}

// Настройки системы (правила упаковки, статусы CRM) - только владельцу.
// Менеджер работает с заказами: собирает, формирует накладные, двигает карточки.
function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Действие доступно только администратору' });
  }
  next();
}

module.exports = requireAuth;
module.exports.requireAdmin = requireAdmin;
