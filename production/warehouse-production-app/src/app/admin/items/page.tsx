'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import { apiFetch } from '@/lib/session';

interface Sku {
  id: number;
  sku: string;
  storeId: number;
  storeName: string;
  costCode: string | null;
}

interface Item {
  id: string;
  code: string;
  name: string;
  imageUrl: string | null;
  boxesPerUnit: number;
  quantityOnHand: number;
  warehouseId: string | null;
  warehouseName: string | null;
  skus: Sku[];
}

interface Warehouse {
  id: string;
  name: string;
}

export default function ItemsPage() {
  return (
    <Protected area="admin">
      {() => <ItemsScreen />}
    </Protected>
  );
}

function ItemsScreen() {
  const [items, setItems] = useState<Item[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ items: Item[]; warehouses: Warehouse[] }>('/api/admin/items');
      setItems(data.items);
      setWarehouses(data.warehouses);
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

  const query = q.trim().toLowerCase();
  const filtered = query
    ? items.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.code.toLowerCase().includes(query) ||
          item.skus.some((s) => s.sku.toLowerCase().includes(query))
      )
    : items;

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-ink">Изделия склада</h1>
            <p className="text-sm text-faint">Что печатают на этикетках и сканируют на приёмке</p>
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

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по названию, коду или артикулу"
            className="w-full max-w-xs rounded-lg border border-line px-3 py-2 text-sm sm:w-auto"
          />
          <button
            onClick={() => setAdding((value) => !value)}
            className="rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright"
          >
            {adding ? 'Отмена' : 'Новое изделие'}
          </button>
        </div>

        {adding && (
          <AddItem
            warehouses={warehouses}
            onDone={() => {
              setAdding(false);
              load();
            }}
          />
        )}

        {loading ? (
          <p className="text-faint">Загрузка…</p>
        ) : filtered.length === 0 ? (
          <p className="text-faint">{query ? 'Ничего не найдено' : 'Изделий пока нет'}</p>
        ) : (
          <div className="space-y-3">
            {filtered.map((item) => (
              <ItemRow key={item.id} item={item} warehouses={warehouses} onChanged={load} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ItemRow({ item, warehouses, onChanged }: { item: Item; warehouses: Warehouse[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linking, setLinking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/admin/items/${item.id}`, { method: 'PATCH', body: JSON.stringify(body) });
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
      await apiFetch(`/api/admin/items/${item.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить');
      setBusy(false);
    }
  };

  const unlink = async (skuId: number) => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/admin/items/${item.id}/skus/${skuId}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отвязать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg bg-surface p-4 shadow-flat">
      <div className="flex flex-wrap items-start gap-4">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt="" className="h-14 w-14 flex-none rounded object-cover" />
        ) : (
          <div className="flex h-14 w-14 flex-none items-center justify-center rounded border border-dashed border-line text-xs text-faint">
            нет фото
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <EditableText value={item.name} disabled={busy} onSave={(v) => patch({ name: v })} className="font-semibold text-ink" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>
              Код: <EditableText value={item.code} disabled={busy} onSave={(v) => patch({ code: v })} mono />
            </span>
            <span>
              Коробок в 1 шт:{' '}
              <EditableText value={String(item.boxesPerUnit)} disabled={busy} numeric onSave={(v) => Number(v) >= 1 && patch({ boxesPerUnit: Number(v) })} />
            </span>
            <span>
              Остаток:{' '}
              <EditableText value={String(item.quantityOnHand)} disabled={busy} numeric onSave={(v) => Number(v) >= 0 && patch({ quantityOnHand: Number(v) })} />
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-faint">Склад:</span>
            <select
              value={item.warehouseId || ''}
              disabled={busy}
              onChange={(e) => patch({ warehouseId: e.target.value || null })}
              className="rounded border border-line px-2 py-1 text-sm"
            >
              <option value="">— не задан —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {item.skus.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full bg-raised px-3 py-1 text-xs">
                <span className="font-medium text-ink">{s.storeName}</span>
                <span className="text-muted">{s.sku}</span>
                {s.costCode && <span className="text-brass">{s.costCode}</span>}
                <button onClick={() => unlink(s.id)} disabled={busy} className="text-faint hover:text-danger" title="Отвязать">
                  ×
                </button>
              </span>
            ))}
            {linking ? (
              <LinkSku itemId={item.id} onDone={() => { setLinking(false); onChanged(); }} onCancel={() => setLinking(false)} />
            ) : (
              <button onClick={() => setLinking(true)} disabled={busy} className="rounded-full border border-dashed border-line px-3 py-1 text-xs text-muted hover:bg-raised">
                + артикул Kaspi
              </button>
            )}
          </div>

          {error && <div className="mt-2 text-xs text-danger">{error}</div>}
        </div>

        {confirmingDelete ? (
          <div className="flex flex-none flex-col gap-1 text-xs">
            <span className="text-muted">Удалить изделие?</span>
            <div className="flex gap-2">
              <button onClick={remove} disabled={busy} className="rounded border border-danger px-2 py-1 text-danger hover:bg-danger/10">
                Да
              </button>
              <button onClick={() => setConfirmingDelete(false)} className="rounded border border-line px-2 py-1">
                Нет
              </button>
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

// Клик по значению превращает его в поле ввода - как в «Себестоимости» и «Настройках»
// дашборда заказов, чтобы правка не открывала отдельную форму на 80 изделиях разом.
function EditableText({
  value,
  onSave,
  disabled,
  numeric,
  mono,
  className,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
  numeric?: boolean;
  mono?: boolean;
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
        className={`underline decoration-dotted decoration-line underline-offset-2 hover:decoration-brass ${mono ? 'font-mono' : ''} ${className || ''}`}
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== value) onSave(draft.trim());
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
      className={`rounded border border-line px-1.5 py-0.5 text-sm ${numeric ? 'w-16 text-right' : 'w-40'} ${mono ? 'font-mono' : ''}`}
    />
  );
}

function LinkSku({ itemId, onDone, onCancel }: { itemId: string; onDone: () => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ sku: string; name: string; storeId: number; storeName: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch<{ sku: string; name: string; storeId: number; storeName: string }[]>(
          `/api/admin/skus?q=${encodeURIComponent(query)}`
        );
        setFound(data);
      } catch {
        setFound([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const link = async (row: { sku: string; storeId: number }) => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/admin/items/${itemId}/skus`, {
        method: 'POST',
        body: JSON.stringify({ sku: row.sku, storeId: row.storeId }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось привязать');
      setBusy(false);
    }
  };

  return (
    <div className="w-full rounded-lg border border-line bg-raised p-3">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Название или артикул на Kaspi"
          className="flex-1 rounded border border-line px-2 py-1 text-sm"
          disabled={busy}
        />
        <button onClick={onCancel} className="text-sm text-faint hover:text-ink">
          Отмена
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      {found.length > 0 && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {found.map((row) => (
            <button
              key={`${row.storeId}-${row.sku}`}
              onClick={() => link(row)}
              disabled={busy}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface"
            >
              <span className="text-ink">{row.name}</span>{' '}
              <span className="text-faint">· {row.storeName} · {row.sku}</span>
            </button>
          ))}
        </div>
      )}
      {query.trim().length > 1 && found.length === 0 && (
        <p className="mt-2 text-xs text-faint">Ничего не нашлось, либо все совпадения уже привязаны</p>
      )}
    </div>
  );
}

function AddItem({ warehouses, onDone }: { warehouses: Warehouse[]; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [boxesPerUnit, setBoxesPerUnit] = useState('1');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/admin/items', {
        method: 'POST',
        body: JSON.stringify({ code, name, boxesPerUnit: Number(boxesPerUnit), warehouseId: warehouseId || null }),
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
      <h2 className="mb-4 text-lg font-semibold text-ink">Новое изделие</h2>

      {error && <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{error}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-muted">Код изделия</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            placeholder="Например, WH-2024-01"
            className="mt-1 w-full rounded-lg border border-line px-3 py-2 font-mono"
          />
          {/* Внутренний склад-код, не путать с кодом себестоимости SH-4001 - тот приходит */}
          {/* из «Себестоимости» и виден в карточке только через привязанный артикул */}
          <span className="mt-1 block text-xs text-faint">Внутренний идентификатор склада, должен быть уникален</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-muted">Название</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-muted">Коробок в 1 штуке</span>
          <input
            type="number"
            min={1}
            value={boxesPerUnit}
            onChange={(e) => setBoxesPerUnit(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          />
          <span className="mt-1 block text-xs text-faint">На каждую печатается своя этикетка «N из M»</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-muted">Склад</span>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          >
            <option value="">— не задан —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-4 rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright disabled:opacity-60"
      >
        {busy ? 'Создаём…' : 'Создать изделие'}
      </button>
    </form>
  );
}
