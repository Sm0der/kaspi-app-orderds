'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Protected from '@/components/Protected';
import ThemePicker from '@/components/ThemePicker';
import { clearSession } from '@/lib/session';
import { can, Area, roleLabel } from '@/lib/roles';
import type { User } from '@/types';

// Плитки только тех разделов, которые действительно существуют. Заготовки без страниц
// («Остатки склада», «Цехи», «Товары склада») отсюда убраны: плитка, ведущая на 404, хуже,
// чем её отсутствие - человек решает, что сломалось приложение.
const TILES: { title: string; description: string; href: string; area: Area; external?: boolean }[] = [
  {
    title: 'Заказы и накладные',
    description: 'Отгрузки Kaspi, формирование накладных, CRM',
    href: '/',
    area: 'orders',
    // Дашборд заказов - соседнее приложение в корне того же домена, поэтому обычная
    // ссылка, а не next/link: роутер склада приписал бы к ней свой basePath /sklad
    external: true,
  },
  {
    title: 'Этикетки на коробки',
    description: 'Печать 75×120 мм: фото, все названия с Kaspi, номер коробки, штрихкод',
    href: '/warehouse/labels',
    area: 'labels',
  },
  {
    title: 'Приём товара',
    description: 'Сканирование штрихкодов поступающих изделий',
    href: '/warehouse/receive',
    area: 'receive',
  },
  {
    title: 'Отгрузка заказов',
    description: 'Сборка заказа по сканеру и отгрузка',
    href: '/warehouse/ship',
    area: 'ship',
  },
  {
    title: 'Мой цех',
    description: 'Задачи, стоящие в вашем цехе, и отметка выработки',
    href: '/production/tasks',
    area: 'production',
  },
  {
    title: 'Производство',
    description: 'Доска по цехам и запуск изделий в работу',
    href: '/production/board',
    area: 'productionStats',
  },
  {
    title: 'Учётные записи',
    description: 'Сотрудники, роли, пароли',
    href: '/admin/users',
    area: 'admin',
  },
];

export default function DashboardPage() {
  return <Protected>{(user) => <Dashboard user={user} />}</Protected>;
}

function Dashboard({ user }: { user: User }) {
  const router = useRouter();
  const available = TILES.filter((tile) => can(user.role, tile.area));

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <h1 className="text-xl font-bold text-ink">Производство и склад</h1>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-sm font-medium text-ink">{user.fullName}</div>
              <div className="text-xs text-faint">{roleLabel(user.role)}</div>
            </div>
            <ThemePicker />
            <Link href="/profile/password" className="text-sm text-brass hover:underline">
              Сменить пароль
            </Link>
            <button
              onClick={() => {
                clearSession();
                router.replace('/login');
              }}
              className="rounded bg-brass px-4 py-2 text-sm text-on-brass hover:bg-brass-bright"
            >
              Выйти
            </button>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {available.length === 0 ? (
          <div className="rounded-lg bg-surface p-8 text-center shadow-flat">
            <h2 className="mb-2 text-lg font-semibold text-ink">Разделов для вашей роли пока нет</h2>
            <p className="text-muted">
              Экраны цехов ещё не сделаны. Как только они появятся, эта страница откроет их без вашего участия.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {available.map((tile) =>
              tile.external ? (
                <a key={tile.href} href={tile.href} className={tileClass}>
                  <Tile title={tile.title} description={tile.description} />
                </a>
              ) : (
                <Link key={tile.href} href={tile.href} className={tileClass}>
                  <Tile title={tile.title} description={tile.description} />
                </Link>
              )
            )}
          </div>
        )}
      </main>
    </div>
  );
}

const tileClass = 'block rounded-lg bg-surface p-6 shadow-flat transition-shadow hover:shadow-card';

function Tile({ title, description }: { title: string; description: string }) {
  return (
    <>
      <h4 className="mb-2 text-lg font-semibold text-ink">{title}</h4>
      <p className="text-muted">{description}</p>
    </>
  );
}
