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
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-ink">Учётные записи</h1>
            <p className="text-sm text-faint">Один вход на заказы и на склад</p>
          </div>
          <Link href="/dashboard" className="text-sm text-brass hover:underline">
            ← Ко всем разделам
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {error && (
          <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{error}</div>
        )}

        <div className="mb-6 flex justify-end">
          <button
            onClick={() => setAdding((value) => !value)}
            className="rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright"
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
          <p className="text-faint">Загрузка…</p>
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
    <div className={`rounded-lg bg-surface p-4 shadow-flat ${person.isActive ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{person.fullName}</span>
            {isMe && <Badge tone="blue">это вы</Badge>}
            {!person.isActive && <Badge tone="gray">отключён</Badge>}
            {person.mustChangePassword && <Badge tone="amber">пароль временный</Badge>}
          </div>
          <div className="truncate text-sm text-faint">{person.email}</div>
          <div className="mt-1 text-sm text-muted">
            {roleLabel(person.role)}
            {workshop && ` · ${workshop.name}`}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={person.role}
            disabled={busy}
            onChange={(e) => changeRole(e.target.value as Role)}
            className="rounded border border-line px-2 py-1 text-sm"
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
              className="rounded border border-line px-2 py-1 text-sm"
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
            className="rounded border border-line px-3 py-1 text-sm hover:bg-raised"
          >
            Сбросить пароль
          </button>

          <button
            onClick={() => patch({ isActive: !person.isActive })}
            disabled={busy || isMe}
            title={isMe ? 'Себя отключить нельзя' : undefined}
            className="rounded border border-line px-3 py-1 text-sm hover:bg-raised disabled:opacity-40"
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
    <form onSubmit={submit} className="mb-6 rounded-lg bg-surface p-6 shadow-flat">
      <h2 className="mb-4 text-lg font-semibold text-ink">Новый сотрудник</h2>

      {error && <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{error}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-muted">Имя</span>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-muted">Почта — она же логин</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          />
          {/* Рабочему у сканера почта нужна только чтобы войти - настоящий ящик заводить не обязательно */}
          <span className="mt-1 block text-xs text-faint">Например, prisadka@artroom.kz</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-muted">Роль</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-faint">{ROLE_HINTS[role]}</span>
        </label>

        {needsWorkshop && (
          <label className="block">
            <span className="text-sm font-medium text-muted">Цех</span>
            <select
              value={workshopId}
              onChange={(e) => setWorkshopId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2"
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
          <span className="text-sm font-medium text-muted">Временный пароль</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          />
          <span className="mt-1 block text-xs text-faint">Сотрудник сменит его при первом входе</span>
        </label>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-6 rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright disabled:opacity-50"
      >
        {busy ? 'Создаём…' : 'Создать'}
      </button>
    </form>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'blue' | 'gray' | 'amber' }) {
  const tones = {
    blue: 'bg-brass-wash text-brass-strong',
    gray: 'bg-lifted text-muted',
    amber: 'bg-warn/15 text-warn',
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
