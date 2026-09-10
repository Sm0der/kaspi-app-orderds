'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, getToken, getUser, saveUser } from '@/lib/session';
import type { User } from '@/types';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setUser(getUser());
  }, [router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (next !== repeat) {
      setError('Новый пароль и повтор не совпадают');
      return;
    }

    setBusy(true);
    try {
      await apiFetch('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });

      // Флаг снят на сервере - снимаем и в сохранённом сеансе, иначе Protected будет
      // возвращать сюда же на каждой странице
      if (user) saveUser({ ...user, mustChangePassword: false });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сменить пароль');
    } finally {
      setBusy(false);
    }
  };

  const forced = user?.mustChangePassword;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">Смена пароля</h1>
        <p className="mb-6 text-sm text-gray-600">
          {forced
            ? 'Этот пароль вам выдал администратор, значит его знаете не только вы. Придумайте свой — дальше система пустит уже с ним.'
            : 'Придумайте новый пароль. Прежний перестанет действовать сразу.'}
        </p>

        {error && (
          <div className="mb-4 rounded border border-red-400 bg-red-100 p-3 text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <Field label="Текущий пароль" value={current} onChange={setCurrent} autoComplete="current-password" />
          <Field label="Новый пароль" value={next} onChange={setNext} autoComplete="new-password" hint="Не короче 8 символов" />
          <Field label="Повторите новый" value={repeat} onChange={setRepeat} autoComplete="new-password" />

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-blue-600 py-2 font-bold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Сохраняем…' : 'Сменить пароль'}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required
        className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
      />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
