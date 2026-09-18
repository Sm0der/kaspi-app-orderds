'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import { apiFetch } from '@/lib/session';

interface Warehouse {
  id: string;
  name: string;
  location: string | null;
  itemsCount: number;
  usersCount: number;
}

interface Workshop {
  id: string;
  name: string;
  orderSequence: number;
  description: string | null;
  usersCount: number;
  itemsCount: number;
}

// Склады и цехи - до сих пор заводились только SQL-вставкой (см. SETUP_GUIDE.md),
// формы не было вовсе. embed=1 в адресе - для встраивания внутрь единой админ-панели
// дашборда заказов (frontend/app/components/AdminPanel.js): прячет свою шапку с
// дублирующей навигацией, там уже есть общая.
export default function WarehousesPage() {
  return (
    <Protected area="admin">
      {() => <Screen />}
    </Protected>
  );
}

function Screen() {
  const [embed, setEmbed] = useState(false);
  const [tab, setTab] = useState<'warehouses' | 'workshops'>('warehouses');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setEmbed(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);

  const load = useCallback(async () => {
    try {
      const [w, s] = await Promise.all([
        apiFetch<Warehouse[]>('/api/admin/warehouses'),
        apiFetch<Workshop[]>('/api/admin/workshops'),
      ]);
      setWarehouses(w);
      setWorkshops(s);
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
      {!embed && (
        <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
            <div>
              <h1 className="text-xl font-bold text-ink">Склады и цехи</h1>
              <p className="text-sm text-faint">Места хранения и очередь цехов производства</p>
            </div>
            <Link href="/dashboard" className="text-sm text-brass hover:underline">
              ← Ко всем разделам
            </Link>
          </div>
        </nav>
      )}

      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => setTab('warehouses')}
            className={`rounded-full px-4 py-1.5 text-sm ${tab === 'warehouses' ? 'bg-brass text-on-brass' : 'border border-line text-muted'}`}
          >
            Склады
          </button>
          <button
            onClick={() => setTab('workshops')}
            className={`rounded-full px-4 py-1.5 text-sm ${tab === 'workshops' ? 'bg-brass text-on-brass' : 'border border-line text-muted'}`}
          >
            Цехи
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{error}</div>
        )}

        {loading ? (
          <p className="text-faint">Загрузка…</p>
        ) : tab === 'warehouses' ? (
          <WarehousesTab warehouses={warehouses} onChanged={load} />
        ) : (
          <WorkshopsTab workshops={workshops} onChanged={load} />
        )}
      </main>
    </div>
  );
}

function WarehousesTab({ warehouses, onChanged }: { warehouses: Warehouse[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          onClick={() => setAdding((v) => !v)}
          className="rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright"
        >
          {adding ? 'Отмена' : 'Новый склад'}
        </button>
      </div>

      {adding && (
        <AddWarehouse
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {warehouses.length === 0 ? (
        <p className="text-faint">Складов пока нет</p>
      ) : (
        <div className="space-y-3">
          {warehouses.map((w) => (
            <WarehouseRow key={w.id} warehouse={w} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function WarehouseRow({ warehouse, onChanged }: { warehouse: Warehouse; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/admin/warehouses/${warehouse.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/admin/warehouses/${warehouse.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить');
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg bg-surface p-4 shadow-flat">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <EditableText value={warehouse.name} disabled={busy} onSave={(v) => patch({ name: v })} className="font-semibold text-ink" />
          <div className="mt-1 text-sm text-muted">
            <EditableText value={warehouse.location || ''} disabled={busy} placeholder="адрес не указан" onSave={(v) => patch({ location: v })} />
          </div>
          <div className="mt-1 text-xs text-faint">{warehouse.itemsCount} изделий · {warehouse.usersCount} сотрудников</div>
          {error && <div className="mt-2 text-xs text-danger">{error}</div>}
        </div>

        {confirmingDelete ? (
          <div className="flex flex-none flex-col gap-1 text-xs">
            <span className="text-muted">Удалить склад?</span>
            <div className="flex gap-2">
              <button onClick={remove} disabled={busy} className="rounded border border-danger px-2 py-1 text-danger hover:bg-danger/10">Да</button>
              <button onClick={() => setConfirmingDelete(false)} className="rounded border border-line px-2 py-1">Нет</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            className="flex-none rounded border border-line px-3 py-1 text-sm text-muted hover:bg-raised"
          >
            Удалить
          </button>
        )}
      </div>
    </div>
  );
}

function AddWarehouse({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/admin/warehouses', { method: 'POST', body: JSON.stringify({ name, location: location || null }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-6 rounded-lg bg-surface p-6 shadow-flat">
      <h2 className="mb-4 text-lg font-semibold text-ink">Новый склад</h2>
      {error && <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{error}</div>}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-muted">Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-muted">Адрес</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
      </div>
      <button type="submit" disabled={busy} className="mt-4 rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright disabled:opacity-60">
        {busy ? 'Создаём…' : 'Создать склад'}
      </button>
    </form>
  );
}

function WorkshopsTab({ workshops, onChanged }: { workshops: Workshop[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          onClick={() => setAdding((v) => !v)}
          className="rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright"
        >
          {adding ? 'Отмена' : 'Новый цех'}
        </button>
      </div>

      {adding && (
        <AddWorkshop
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {workshops.length === 0 ? (
        <p className="text-faint">Цехов пока нет</p>
      ) : (
        <div className="space-y-3">
          {workshops.map((w) => (
            <WorkshopRow key={w.id} workshop={w} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkshopRow({ workshop, onChanged }: { workshop: Workshop; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/admin/workshops/${workshop.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/admin/workshops/${workshop.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить');
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg bg-surface p-4 shadow-flat">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-faint">#<EditableText value={String(workshop.orderSequence)} disabled={busy} numeric onSave={(v) => Number(v) >= 1 && patch({ orderSequence: Number(v) })} /></span>
            <EditableText value={workshop.name} disabled={busy} onSave={(v) => patch({ name: v })} className="font-semibold text-ink" />
          </div>
          <div className="mt-1 text-sm text-muted">
            <EditableText value={workshop.description || ''} disabled={busy} placeholder="без описания" onSave={(v) => patch({ description: v })} />
          </div>
          <div className="mt-1 text-xs text-faint">{workshop.usersCount} сотрудников · {workshop.itemsCount} изделий в работе</div>
          {error && <div className="mt-2 text-xs text-danger">{error}</div>}
        </div>

        {confirmingDelete ? (
          <div className="flex flex-none flex-col gap-1 text-xs">
            <span className="text-muted">Удалить цех?</span>
            <div className="flex gap-2">
              <button onClick={remove} disabled={busy} className="rounded border border-danger px-2 py-1 text-danger hover:bg-danger/10">Да</button>
              <button onClick={() => setConfirmingDelete(false)} className="rounded border border-line px-2 py-1">Нет</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            className="flex-none rounded border border-line px-3 py-1 text-sm text-muted hover:bg-raised"
          >
            Удалить
          </button>
        )}
      </div>
    </div>
  );
}

function AddWorkshop({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/admin/workshops', { method: 'POST', body: JSON.stringify({ name, description: description || null }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-6 rounded-lg bg-surface p-6 shadow-flat">
      <h2 className="mb-4 text-lg font-semibold text-ink">Новый цех</h2>
      {error && <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{error}</div>}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-muted">Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-muted">Описание</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
      </div>
      <span className="mt-1 block text-xs text-faint">Место в очереди производства встанет автоматически - последним; поправить его можно потом прямо в списке</span>
      <button type="submit" disabled={busy} className="mt-4 rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright disabled:opacity-60">
        {busy ? 'Создаём…' : 'Создать цех'}
      </button>
    </form>
  );
}

function EditableText({
  value,
  onSave,
  disabled,
  numeric,
  placeholder,
  className,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
  numeric?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  if (!editing) {
    return (
      <button
        disabled={disabled}
        onClick={() => setEditing(true)}
        className={`underline decoration-dotted decoration-line underline-offset-2 hover:decoration-brass ${!value ? 'text-faint' : ''} ${className || ''}`}
      >
        {value || placeholder || 'указать'}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft.trim());
    else setDraft(value);
  };

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      className={`rounded border border-line px-1.5 py-0.5 text-sm ${numeric ? 'w-14 text-right' : 'w-48'}`}
    />
  );
}
