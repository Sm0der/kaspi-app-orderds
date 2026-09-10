'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import { apiFetch } from '@/lib/session';
import { ROLES, ROLE_HINTS, ROLE_LABELS, ROLES_NEEDING_WORKSHOP, Role, roleLabel } from '@/lib/roles';

interface Person {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  workshopId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
}

interface Workshop {
  id: string;
  name: string;
  orderSequence: number;
}

export default function UsersPage() {
  return (
    <Protected area="admin">
      {(me) => <UsersScreen myId={me.id} />}
    </Protected>
  );
}

function UsersScreen({ myId }: { myId: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ users: Person[]; workshops: Workshop[] }>('/api/admin/users');
      setPeople(data.users);
      setWorkshops(data.workshops);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Учётные записи</h1>
            <p className="text-sm text-gray-500">Один вход на заказы и на склад</p>
          </div>
          <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
            ← Ко всем разделам
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {error && (
          <div className="mb-4 rounded border border-red-400 bg-red-100 p-3 text-sm text-red-700">{error}</div>
        )}

        <div className="mb-6 flex justify-end">
          <button
            onClick={() => setAdding((value) => !value)}
            className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700"
          >
            {adding ? 'Отмена' : 'Добавить сотрудника'}
          </button>
        </div>

        {adding && (
          <AddPerson
            workshops={workshops}
            onDone={() => {
              setAdding(false);
              load();
            }}
          />
        )}

        {loading ? (
          <p className="text-gray-500">Загрузка…</p>
        ) : (
          <div className="space-y-3">
            {people.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                workshops={workshops}
                isMe={person.id === myId}
                onChanged={load}
                onError={setError}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function PersonRow({
  person,
  workshops,
  isMe,
  onChanged,
  onError,
}: {
  person: Person;
  workshops: Workshop[];
  isMe: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const workshop = workshops.find((w) => w.id === person.workshopId);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await apiFetch(`/api/admin/users/${person.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onError('');
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = (role: Role) => {
    // Цех обязателен цеховым ролям: спрашиваем сразу, иначе API откажет, а человек
    // не поймёт, чего от него хотят
    if (ROLES_NEEDING_WORKSHOP.includes(role)) {
      const first = workshops[0];
      patch({ role, workshopId: person.workshopId || first?.id });
      return;
    }
    patch({ role, workshopId: null });
  };

  const resetPassword = () => {
    const password = window.prompt(`Новый пароль для «${person.fullName}» (не короче 8 символов).\nСотрудник сменит его при первом входе.`);
    if (password) patch({ password });
  };

  return (
    <div className={`rounded-lg bg-white p-4 shadow ${person.isActive ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gray-900">{person.fullName}</span>
            {isMe && <Badge tone="blue">это вы</Badge>}
            {!person.isActive && <Badge tone="gray">отключён</Badge>}
            {person.mustChangePassword && <Badge tone="amber">пароль временный</Badge>}
          </div>
          <div className="truncate text-sm text-gray-500">{person.email}</div>
          <div className="mt-1 text-sm text-gray-600">
            {roleLabel(person.role)}
            {workshop && ` · ${workshop.name}`}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={person.role}
            disabled={busy}
            onChange={(e) => changeRole(e.target.value as Role)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>

          {ROLES_NEEDING_WORKSHOP.includes(person.role) && (
            <select
              value={person.workshopId || ''}
              disabled={busy}
              onChange={(e) => patch({ role: person.role, workshopId: e.target.value })}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              {workshops.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={resetPassword}
            disabled={busy}
            className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
          >
            Сбросить пароль
          </button>

          <button
            onClick={() => patch({ isActive: !person.isActive })}
            disabled={busy || isMe}
            title={isMe ? 'Себя отключить нельзя' : undefined}
            className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
          >
            {person.isActive ? 'Отключить' : 'Включить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddPerson({ workshops, onDone }: { workshops: Workshop[]; onDone: () => void }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('PACKER');
  const [workshopId, setWorkshopId] = useState(workshops[0]?.id || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const needsWorkshop = ROLES_NEEDING_WORKSHOP.includes(role);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ fullName, email, password, role, workshopId: needsWorkshop ? workshopId : null }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-6 rounded-lg bg-white p-6 shadow">
      <h2 className="mb-4 text-lg font-semibold text-gray-900">Новый сотрудник</h2>

      {error && <div className="mb-4 rounded border border-red-400 bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Имя</span>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Почта — она же логин</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />
          {/* Рабочему у сканера почта нужна только чтобы войти - настоящий ящик заводить не обязательно */}
          <span className="mt-1 block text-xs text-gray-500">Например, prisadka@artroom.kz</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Роль</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-gray-500">{ROLE_HINTS[role]}</span>
        </label>

        {needsWorkshop && (
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Цех</span>
            <select
              value={workshopId}
              onChange={(e) => setWorkshopId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
            >
              {workshops.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Временный пароль</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />
          <span className="mt-1 block text-xs text-gray-500">Сотрудник сменит его при первом входе</span>
        </label>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-6 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Создаём…' : 'Создать'}
      </button>
    </form>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'blue' | 'gray' | 'amber' }) {
  const tones = {
    blue: 'bg-blue-100 text-blue-800',
    gray: 'bg-gray-200 text-gray-700',
    amber: 'bg-amber-100 text-amber-800',
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
