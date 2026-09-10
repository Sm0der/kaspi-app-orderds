import axios from 'axios';
import { clearSession, getToken } from './session';

export const API_URL = process.env.NEXT_PUBLIC_API_URL;

// Отдельный экземпляр axios, а не глобальный: токен подставляется интерсептором на каждый
// запрос, поэтому не важно, в каком порядке смонтировались компоненты - заголовок будет
// даже у самого первого запроса при загрузке страницы.
export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Токен живёт неделю и однажды истекает прямо посреди рабочего дня. Без этой обработки
// человек видит подряд несколько красных плашек и не догадывается, что надо просто войти.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      clearSession();
      if (typeof window !== 'undefined') window.location.reload();
    }
    return Promise.reject(error);
  }
);

// Текст ошибки от нашего API, от Kaspi или сетевой - в одном месте, чтобы в компонентах
// не повторять одну и ту же цепочку проверок.
export function errorText(error, fallback = 'Что-то пошло не так') {
  return error?.response?.data?.error || error?.message || fallback;
}

// Скачивание файла с авторизацией. Простая ссылка <a href> сюда не годится: браузер
// откроет её без заголовка Authorization и получит 401 - все файловые эндпоинты за
// логином. Поэтому забираем файл запросом и отдаём браузеру уже готовый blob.
export async function downloadFile(path, filename) {
  let response;
  try {
    response = await api.get(path, { responseType: 'blob' });
  } catch (error) {
    // При ошибке сервер отвечает JSON-ом, но axios всё равно отдаёт его как blob -
    // разворачиваем, иначе пользователь увидит невнятное "Request failed with status code 404"
    const body = error?.response?.data;
    if (body instanceof Blob) {
      const text = await body.text();
      try {
        throw new Error(JSON.parse(text).error || text);
      } catch (parseError) {
        throw new Error(parseError instanceof SyntaxError ? text : parseError.message);
      }
    }
    throw error;
  }

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
