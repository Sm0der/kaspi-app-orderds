'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, getUser } from '@/lib/session';
import { can, Area } from '@/lib/roles';
import type { User } from '@/types';

// Обёртка для страниц за логином. Три правила, одинаковые для всех разделов:
// нет токена - на вход; пароль выдан администратором - сперва сменить; нет права
// на раздел - честно сказать об этом, а не показывать пустой экран.
//
// Это только удобство интерфейса: настоящая проверка живёт в API (src/lib/guard.ts),
// потому что localStorage правится из консоли браузера за десять секунд.
export default function Protected({
  area,
  children,
}: {
  area?: Area;
  children: (user: User) => React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'denied'>('loading');

  useEffect(() => {
    const token = getToken();
    const stored = getUser();

    if (!token || !stored) {
      router.replace('/login');
      return;
    }

    if (stored.mustChangePassword) {
      router.replace('/profile/password');
      return;
    }

    setUser(stored);
    setState(!area || can(stored.role, area) ? 'ok' : 'denied');
  }, [area, router]);

  if (state === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-faint">Загрузка…</div>;
  }

  if (state === 'denied') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold text-ink">Этот раздел вам не открыт</h1>
        <p className="text-muted">Доступ выдаёт администратор. Попросите его изменить вашу роль.</p>
        <button
          onClick={() => router.replace('/dashboard')}
          className="rounded-lg bg-brass px-4 py-2 text-on-brass hover:bg-brass-bright"
        >
          К моим разделам
        </button>
      </div>
    );
  }

  return <>{user && children(user)}</>;
}
