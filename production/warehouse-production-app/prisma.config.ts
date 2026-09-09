import { defineConfig } from 'prisma/config';
import dotenv from 'dotenv';

// Next сам читает .env.local, а Prisma и tsx - нет: у dotenv по умолчанию только .env.
// Секреты держим в .env.local (он в .gitignore), поэтому загружаем его явно, а .env
// оставляем запасным вариантом для окружений, где переменные кладут туда.
dotenv.config({ path: '.env.local' });
dotenv.config();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
