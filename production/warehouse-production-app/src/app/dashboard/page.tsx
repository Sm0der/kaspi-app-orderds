'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface User {
  id: string;
  email: string;
  fullName: string;
  role: string;
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  WORKSHOP_WORKER: 'Работник цеха',
  WORKSHOP_MASTER: 'Мастер цеха',
  WAREHOUSE_RECEIVER: 'Кладовщик (приём)',
  WAREHOUSE_SHIPPER: 'Кладовщик (отгрузка)',
  MANAGER: 'Руководитель',
};

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('token');
      const userData = localStorage.getItem('user');

      if (!token || !userData) {
        router.push('/login');
        return;
      }

      try {
        setUser(JSON.parse(userData));
      } catch {
        router.push('/login');
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [router]);

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen">Загрузка...</div>;
  }

  if (!user) {
    return null;
  }

  const warehouseMenuItems = [
    {
      title: 'Приём товара',
      description: 'Сканирование штрихкодов поступающих изделий',
      href: '/warehouse/receive',
      roles: ['WAREHOUSE_RECEIVER', 'ADMIN'],
    },
    {
      title: 'Отгрузка заказов',
      description: 'Сборка и отгрузка заказов Kaspi',
      href: '/warehouse/ship',
      roles: ['WAREHOUSE_SHIPPER', 'ADMIN'],
    },
    {
      title: 'Этикетки на коробки',
      description: 'Печать этикеток с именем изделия, фото и штрихкодом',
      href: '/warehouse/labels',
      roles: ['WAREHOUSE_RECEIVER', 'WORKSHOP_MASTER', 'ADMIN'],
    },
    {
      title: 'Остатки склада',
      description: 'Текущие остатки товаров',
      href: '/warehouse/inventory',
      roles: ['WAREHOUSE_RECEIVER', 'WAREHOUSE_SHIPPER', 'MANAGER', 'ADMIN'],
    },
  ];

  const productionMenuItems = [
    {
      title: 'Мои задачи',
      description: 'Просмотр и выполнение операций цеха',
      href: '/production/tasks',
      roles: ['WORKSHOP_WORKER', 'WORKSHOP_MASTER', 'ADMIN'],
    },
    {
      title: 'Дашборд производства',
      description: 'Статус и метрики по цехам',
      href: '/production/dashboard',
      roles: ['WORKSHOP_MASTER', 'MANAGER', 'ADMIN'],
    },
  ];

  const adminMenuItems = [
    {
      title: 'Пользователи',
      description: 'Управление пользователями системы',
      href: '/admin/users',
      roles: ['ADMIN'],
    },
    {
      title: 'Цехи',
      description: 'Настройка цехов производства',
      href: '/admin/workshops',
      roles: ['ADMIN'],
    },
    {
      title: 'Товары склада',
      description: 'Управление номенклатурой и штрихкодами',
      href: '/admin/items',
      roles: ['ADMIN'],
    },
  ];

  const getAvailableItems = (items: any[]) => {
    return items.filter((item) => item.roles.includes(user.role));
  };

  const warehouseAvailable = getAvailableItems(warehouseMenuItems);
  const productionAvailable = getAvailableItems(productionMenuItems);
  const adminAvailable = getAvailableItems(adminMenuItems);

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">Производство и склад</h1>
          <div className="flex items-center gap-4">
            <span className="text-gray-700">{user.fullName}</span>
            <button
              onClick={() => {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                router.push('/login');
              }}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Выйти
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-2">Добро пожаловать, {user.fullName}</h2>
          <p className="text-gray-600">Роль: {ROLE_LABELS[user.role] || user.role}</p>
        </div>

        {warehouseAvailable.length > 0 && (
          <section className="mb-12">
            <h3 className="text-xl font-bold text-gray-900 mb-4">Склад</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {warehouseAvailable.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="p-6 bg-white rounded-lg shadow hover:shadow-lg transition-shadow"
                >
                  <h4 className="text-lg font-semibold text-gray-900 mb-2">{item.title}</h4>
                  <p className="text-gray-600">{item.description}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {productionAvailable.length > 0 && (
          <section className="mb-12">
            <h3 className="text-xl font-bold text-gray-900 mb-4">Производство</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {productionAvailable.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="p-6 bg-white rounded-lg shadow hover:shadow-lg transition-shadow"
                >
                  <h4 className="text-lg font-semibold text-gray-900 mb-2">{item.title}</h4>
                  <p className="text-gray-600">{item.description}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {adminAvailable.length > 0 && (
          <section className="mb-12">
            <h3 className="text-xl font-bold text-gray-900 mb-4">Администрирование</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {adminAvailable.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="p-6 bg-white rounded-lg shadow hover:shadow-lg transition-shadow"
                >
                  <h4 className="text-lg font-semibold text-gray-900 mb-2">{item.title}</h4>
                  <p className="text-gray-600">{item.description}</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
