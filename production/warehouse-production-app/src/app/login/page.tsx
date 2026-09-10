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
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <div className="bg-surface p-8 rounded-lg shadow-card w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center">Учёт производства и склада</h1>

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
