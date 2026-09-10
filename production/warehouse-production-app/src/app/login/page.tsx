'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveSession, apiUrl } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error || 'Не удалось войти');
        return;
      }

      saveSession(data.data.token, data.data.user);

      // Пароль, выданный администратором, знает не только владелец учётки - меняем сразу,
      // до того как человек попадёт в разделы
      router.push(data.data.user.mustChangePassword ? '/profile/password' : '/dashboard');
    } catch (err) {
      setError('Произошла ошибка. Попробуйте ещё раз.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-8 shadow-card">
        {/* Тот же знак и та же подпись, что на входе в заказы: вход в системе один,
            и человек не должен гадать, туда ли он попал. Файл лежит в обоих
            приложениях - на общем домене хватило бы одного, но склад открывается
            и по собственному адресу, где чужой /brand/ не отдаётся. */}
        <div className="mb-1 flex items-baseline justify-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${process.env.NEXT_PUBLIC_BASE_PATH || ''}/brand/mark.webp`}
            alt=""
            className="h-5 w-5 self-center"
          />
          <span className="brand-mark text-[15px] text-ink">
            ARTROOM<span className="mx-1.5 text-brass">/</span>OPS
          </span>
        </div>
        <p className="mb-7 text-center text-[10px] tracking-[0.16em] text-faint uppercase">
          Склад и производство
        </p>

        {error && (
          <div className="mb-4 p-4 bg-danger/10 border border-danger text-danger rounded">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-muted">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full px-4 py-2 border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-brass"
              placeholder="почта, которую выдал администратор"
              disabled={loading}
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-muted">
              Пароль
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full px-4 py-2 border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-brass"
              placeholder="••••••••"
              disabled={loading}
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brass hover:bg-brass-bright text-on-brass font-bold py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>

        {/* Логины со страницы входа убраны намеренно: список рабочих учёток на публичной
            странице - половина работы взломщика. Их выдаёт администратор. */}
        <p className="mt-6 text-center text-sm text-faint">
          Логин и пароль выдаёт администратор
        </p>
      </div>
    </div>
  );
}
