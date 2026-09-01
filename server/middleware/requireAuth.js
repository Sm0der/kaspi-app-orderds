const { createClient } = require('@supabase/supabase-js');

// Проверяем JWT из заголовка Authorization через сам Supabase Auth (getUser делает
// запрос к auth-серверу и подтверждает, что токен подписан и не истёк) - не нужен
// service role key, достаточно anon-ключа, т.к. мы только валидируем чужой токен.
//
// URL нормализуем: реальный домен Supabase - ".supabase.co", а не ".supabase.com" -
// это лёгкая опечатка при ручном вводе переменной окружения (одна лишняя буква),
// из-за которой все запросы к auth-серверу падали с "fetch failed" (домен .com для
// этого проекта не существует). URL - публичное значение (не секрет), поэтому
// безопасно поправить его здесь же, не полагаясь на то, что в Vercel он введён без опечаток.
const rawUrl = process.env.SUPABASE_URL || 'https://aiatnvqgghdkzrbuqcmw.supabase.co';
const supabaseUrl = rawUrl.replace(/\.supabase\.com\/?$/i, '.supabase.co');
const supabase = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY);

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ error: 'Недействительный или истёкший токен' });
    }
    req.user = data.user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Не удалось проверить токен' });
  }
}

module.exports = requireAuth;
