const { createClient } = require('@supabase/supabase-js');

// Проверяем JWT из заголовка Authorization через сам Supabase Auth (getUser делает
// запрос к auth-серверу и подтверждает, что токен подписан и не истёк) - не нужен
// service role key, достаточно anon-ключа, т.к. мы только валидируем чужой токен.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      console.error('requireAuth: getUser rejected token:', error?.message || 'no user', {
        supabaseUrlSet: !!process.env.SUPABASE_URL,
        supabaseKeySet: !!process.env.SUPABASE_ANON_KEY
      });
      return res.status(401).json({ error: 'Недействительный или истёкший токен' });
    }
    req.user = data.user;
    next();
  } catch (err) {
    console.error('requireAuth: getUser threw:', err.message, {
      supabaseUrlSet: !!process.env.SUPABASE_URL,
      supabaseKeySet: !!process.env.SUPABASE_ANON_KEY
    });
    res.status(401).json({ error: 'Не удалось проверить токен' });
  }
}

module.exports = requireAuth;
