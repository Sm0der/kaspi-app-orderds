'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import { apiFetch } from '@/lib/session';
import { PRODUCTION_ITEM_STATUS_LABELS } from '@/lib/labels';

interface Task {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  status: string;
  notes: string | null;
  imageUrl: string | null;
  workshopId: string;
  workshopName: string;
  doneHere: number;
  defectsHere: number;
  remaining: number;
}

interface Workshop {
  id: string;
  name: string;
  orderSequence: number;
}

interface Item {
  id: string;
  code: string;
  name: string;
  imageUrl: string | null;
}

interface Payload {
  tasks: Task[];
  workshops: Workshop[];
  items: Item[];
}

export default function ProductionBoardPage() {
  return <Protected area="productionStats">{() => <Board />}</Protected>;
}

function Board() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<Payload>('/api/production/board'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить доску');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-ink">Производство</h1>
            <p className="text-sm text-faint">Что в каком цехе стоит прямо сейчас</p>
          </div>
          <Link href="/dashboard" className="text-sm text-brass hover:underline">
            ← Ко всем разделам
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {error && <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{error}</div>}

        {!data ? (
          <p className="text-faint">Загрузка…</p>
        ) : (
          <>
            <Launch items={data.items} onLaunched={load} onError={setError} />

            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {data.workshops.map((workshop) => (
                <Column
                  key={workshop.id}
                  workshop={workshop}
                  tasks={data.tasks.filter((task) => task.workshopId === workshop.id)}
                  onChanged={load}
                  onError={setError}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Column({
  workshop,
  tasks,
  onChanged,
  onError,
}: {
  workshop: Workshop;
  tasks: Task[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  return (
    <section>
      <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold text-ink">
        {workshop.name}
        <span className="text-sm font-normal text-faint">{tasks.length}</span>
      </h2>

      <div className="space-y-3">
        {tasks.length === 0 ? (
          <p className="rounded-lg bg-surface p-4 text-sm text-faint shadow-flat">Пусто</p>
        ) : (
          tasks.map((task) => <Card key={task.id} task={task} onChanged={onChanged} onError={onError} />)
        )}
      </div>
    </section>
  );
}

function Card({
  task,
  onChanged,
  onError,
}: {
  task: Task;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const held = task.status === 'ON_HOLD';

  const act = async (init: RequestInit) => {
    setBusy(true);
    try {
      await apiFetch(`/api/production/tasks/${task.id}`, init);
      onError('');
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось изменить задачу');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-lg bg-surface p-4 shadow-flat ${held ? 'opacity-70' : ''}`}>
      <div className="flex gap-3">
        {task.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={task.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink">{task.name}</div>
          <div className="text-sm text-muted">
            {task.doneHere} / {task.quantity} {task.unit}
            {task.defectsHere > 0 && <span className="text-danger"> · брак {task.defectsHere}</span>}
          </div>
          <div className="text-xs text-faint">{PRODUCTION_ITEM_STATUS_LABELS[task.status] || task.status}</div>
        </div>
      </div>

      {task.notes && <p className="mt-2 text-sm text-muted">{task.notes}</p>}

      <div className="mt-3 flex gap-2">
        <button
          disabled={busy}
          onClick={() => act({ method: 'PATCH', body: JSON.stringify({ status: held ? 'PENDING' : 'ON_HOLD' }) })}
          className="rounded border border-line px-3 py-1 text-sm hover:bg-raised disabled:opacity-40"
        >
          {held ? 'Вернуть в работу' : 'Отложить'}
        </button>

        {/* Снять можно только нетронутую задачу - выработку рабочих не стираем */}
        {task.doneHere === 0 && task.defectsHere === 0 && (
          <button
            disabled={busy}
            onClick={() => act({ method: 'DELETE' })}
            className="rounded border border-line px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-40"
          >
            Снять
          </button>
        )}
      </div>
    </div>
  );
}

function Launch({
  items,
  onLaunched,
  onError,
}: {
  items: Item[];
  onLaunched: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Item | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const found = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items.slice(0, 8);
    return items
      .filter((item) => item.name.toLowerCase().includes(needle) || item.code.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [items, search]);

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ workshop: string }>('/api/production/board', {
        method: 'POST',
        body: JSON.stringify({ warehouseItemId: picked.id, quantity: Number(quantity), notes }),
      });
      setPicked(null);
      setSearch('');
      setQuantity('1');
      setNotes('');
      setOpen(false);
      onError('');
      onLaunched();
      // Куда именно ушла задача - неочевидно, цех определяется порядком в очереди
      window.alert(`Запущено в цех «${result.workshop}»`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось запустить');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="mb-6 flex justify-end">
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright"
        >
          Запустить в производство
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-lg bg-surface p-6 shadow-flat">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">Запустить в производство</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-faint hover:underline">
          Отмена
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-muted">Изделие</label>
          <input
            value={picked ? picked.name : search}
            onChange={(e) => {
              setPicked(null);
              setSearch(e.target.value);
            }}
            placeholder="название или артикул"
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          />

          {!picked && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-line">
              {found.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setPicked(item)}
                  className="flex w-full items-center gap-3 border-b border-line-soft p-2 text-left last:border-0 hover:bg-raised"
                >
                  {item.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" className="h-10 w-10 rounded object-cover" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{item.name}</span>
                    <span className="block text-xs text-faint">{item.code}</span>
                  </span>
                </button>
              ))}
              {found.length === 0 && <p className="p-3 text-sm text-faint">Ничего не нашлось</p>}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-muted">Количество</span>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="mt-1 w-32 rounded-lg border border-line px-3 py-2 text-lg"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-muted">Заметка для цеха</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="необязательно"
              className="mt-1 w-full rounded-lg border border-line px-3 py-2"
            />
          </label>

          <button
            onClick={submit}
            disabled={!picked || busy}
            className="rounded-lg bg-brass px-4 py-2 font-semibold text-on-brass hover:bg-brass-bright disabled:opacity-50"
          >
            {busy ? 'Запускаем…' : 'Запустить'}
          </button>
        </div>
      </div>
    </div>
  );
}
