'use client';

// Вход у системы один. Логин, пароли и роли живут в приложении склада (раздел /sklad
// того же домена, таблица production_users), а дашборд заказов пользуется тем же токеном:
// один origin - один localStorage, поэтому вошедший на складе уже вошёл и здесь, и наоборот.
//
// Раньше здесь был Supabase Auth: отдельный пароль и заведение людей руками в чужой панели.
// Ключи те же, что у склада (src/lib/session.ts), - иначе сеанс не был бы общим.
const TOKEN_KEY = 'token';
const USER_KEY = 'user';

// Проксируется дашбордом на приложение склада, см. next.config.js
export const LOGIN_ENDPOINT = '/sklad/api/auth/login';
export const WAREHOUSE_PATH = '/sklad';

export function getToken() {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  if (typeof window === 'undefined') return null;
  try {
    return JSON.parse(window.localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveSession(token, user) {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}
