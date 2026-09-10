/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'https://kaspi-app-orderds-api.vercel.app'
    // Ключей Supabase здесь больше нет: вход перестал ходить в Supabase Auth, а к базе
    // дашборд обращается только через свой бэкенд.
  },

  // Склад и производство - отдельное приложение (Next 16 + Prisma) и отдельный деплой,
  // но для человека это один сайт: /sklad проксируется туда. Так у системы один адрес
  // и один origin, а значит и один вход - токен в localStorage общий для обеих частей.
  //
  // Само приложение склада собрано с basePath: '/sklad', поэтому путь не срезаем:
  // /sklad/... уходит как /sklad/..., включая его статику /sklad/_next/...
  async rewrites() {
    const warehouse = process.env.WAREHOUSE_URL || 'https://kaspi-app-orderds-warehouse.vercel.app';

    return [
      { source: '/sklad', destination: `${warehouse}/sklad` },
      { source: '/sklad/:path*', destination: `${warehouse}/sklad/:path*` }
    ];
  }
};

module.exports = nextConfig;
