import type { NextConfig } from "next";

// Склад живёт не на своём домене, а разделом /sklad внутри дашборда заказов: тот
// проксирует сюда всё, что начинается с /sklad (см. frontend/next.config.js). basePath
// заставляет Next выдавать с этим префиксом и страницы, и статику, и вызовы своих API -
// без него проксированная страница попыталась бы забрать /_next/... из корня чужого сайта.
//
// Один домен - это ещё и один вход: localStorage общий, поэтому токен, полученный на
// странице входа, действует и на заказах, и на складе.
const BASE_PATH = '/sklad';

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  env: {
    // Роутер Next знает про basePath сам, а window.location и <img src> - нет
    NEXT_PUBLIC_BASE_PATH: BASE_PATH,
  },
};

export default nextConfig;
