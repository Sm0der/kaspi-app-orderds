import { PrismaClient } from '@prisma/client';

// Порт пулера Supabase переставляем на transaction mode - по той же причине, что и в
// API заказов (см. server/db/init.js): на 5432 соединение держит реальный слот Postgres
// до отключения, а слотов на тарифе 60 на все три деплоя. На 6543 пулер мультиплексирует
// логические соединения поверх немногих реальных.
//
// pgbouncer=true велит Prisma не держать именованные prepared statements на стороне
// сервера. Supavisor их переживает (проверено), но соединение между запросами может
// достаться другому клиенту, и тогда заготовка просто не найдётся - флаг убирает этот
// класс отказов целиком.
//
// Локальный Postgres на 5433 условие не затрагивает.
function poolerUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith('.pooler.supabase.com')) return raw;
    if (u.port === '5432') u.port = '6543';
    if (u.port === '6543') u.searchParams.set('pgbouncer', 'true');
    return u.toString();
  } catch {
    return raw;
  }
}

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const url = poolerUrl(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    ...(url ? { datasources: { db: { url } } } : {}),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
