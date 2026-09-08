import axios from 'axios';
import { supabase } from './supabaseClient';

export const API_URL = process.env.NEXT_PUBLIC_API_URL;

// Отдельный экземпляр axios, а не глобальный: токен подставляется интерсептором на каждый
// запрос, поэтому не важно, в каком порядке смонтировались компоненты - заголовок будет
// даже у самого первого запроса при загрузке страницы.
export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use(async (config) => {
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) {
    config.headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  return config;
});

// Текст ошибки от нашего API, от Kaspi или сетевой - в одном месте, чтобы в компонентах
// не повторять одну и ту же цепочку проверок.
export function errorText(error, fallback = 'Что-то пошло не так') {
  return error?.response?.data?.error || error?.message || fallback;
}
