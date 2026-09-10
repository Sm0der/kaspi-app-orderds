'use client';

import type { User } from '@/types';

// Сеанс на стороне браузера. Хранится в localStorage, а не в cookie, потому что тот же
// токен читает и дашборд заказов: после переезда склада на /sklad обе части системы
// живут на одном домене, и общий localStorage - это ровно то, что делает вход единым.
const TOKEN_KEY = 'token';
const USER_KEY = 'user';

// Приложение собрано с basePath '/sklad', но на fetch это не распространяется: браузер
// возьмёт '/api/...' от корня домена и попадёт в дашборд заказов, а не сюда. Поэтому
// адрес любого нашего запроса собираем через apiUrl(), а не пишем строкой.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export function apiUrl(path: string): string {
  return `${BASE_PATH}${path}`;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function saveUser(user: User) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * fetch с токеном и разбором ответа нашего API. Возвращает data или бросает Error с
 * человеческим текстом - в компонентах остаётся только try/catch, а не разбор
 * success/error/HTTP-кода в каждом месте.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  // Истёкший токен - не ошибка формы, а повод войти заново: иначе человек видит
  // «Недействительный токен» в углу и не понимает, что делать
  if (response.status === 401) {
    clearSession();
    // Именно window.location, а не router: перезагрузка страницы гарантированно сбрасывает
    // всё состояние умершего сеанса. basePath приходится подставлять руками - его знает
    // роутер Next, но не браузерный адрес.
    if (typeof window !== 'undefined') {
      window.location.href = apiUrl('/login');
    }
    throw new Error('Сеанс истёк, войдите заново');
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new Error(body?.error || 'Что-то пошло не так');
  }
  return body.data as T;
}
