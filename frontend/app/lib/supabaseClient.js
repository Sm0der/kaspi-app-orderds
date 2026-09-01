import { createClient } from '@supabase/supabase-js';

// Публичный (anon) ключ - его можно безопасно использовать в браузере,
// доступ к данным ограничивается на бэкенде проверкой токена (см. server/middleware/requireAuth.js).
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
