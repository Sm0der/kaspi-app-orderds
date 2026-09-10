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
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Производство</h1>
            <p className="text-sm text-gray-500">Что в каком цехе стоит прямо сейчас</p>
          </div>
          <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
            ← Ко всем разделам
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {error && <div className="mb-4 rounded border border-red-400 bg-red-100 p-3 text-sm text-red-700">{error}</div>}

        {!data ? (
          <p className="text-gray-500">Загрузка…</p>
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
      <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold text-gray-900">
        {workshop.name}
        <span className="text-sm font-normal text-gray-500">{tasks.length}</span>
      </h2>

      <div className="space-y-3">
        {tasks.length === 0 ? (
          <p className="rounded-lg bg-white p-4 text-sm text-gray-500 shadow">Пусто</p>
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
    <div className={`rounded-lg bg-white p-4 shadow ${held ? 'opacity-70' : ''}`}>
      <div className="flex gap-3">
        {task.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={task.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-gray-900">{task.name}</div>
          <div className="text-sm text-gray-600">
            {task.doneHere} / {task.quantity} {task.unit}
            {task.defectsHere > 0 && <span className="text-red-700"> · брак {task.defectsHere}</span>}
          </div>
          <div className="text-xs text-gray-500">{PRODUCTION_ITEM_STATUS_LABELS[task.status] || task.status}</div>
        </div>
      </div>

      {task.notes && <p className="mt-2 text-sm text-gray-600">{task.notes}</p>}

      <div className="mt-3 flex gap-2">
        <button
          disabled={busy}
          onClick={() => act({ method: 'PATCH', body: JSON.stringify({ status: held ? 'PENDING' : 'ON_HOLD' }) })}
          className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
        >
          {held ? 'Вернуть в работу' : 'Отложить'}
        </button>

        {/* Снять можно только нетронутую задачу - выработку рабочих не стираем */}
        {task.doneHere === 0 && task.defectsHere === 0 && (
          <button
            disabled={busy}
            onClick={() => act({ method: 'DELETE' })}
            className="rounded border border-gray-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40"
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
          className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700"
        >
          Запустить в производство
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-lg bg-white p-6 shadow">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Запустить в производство</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:underline">
          Отмена
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700">Изделие</label>
          <input
            value={picked ? picked.name : search}
            onChange={(e) => {
              setPicked(null);
              setSearch(e.target.value);
            }}
            placeholder="название или артикул"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />

          {!picked && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-gray-200">
              {found.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setPicked(item)}
                  className="flex w-full items-center gap-3 border-b border-gray-100 p-2 text-left last:border-0 hover:bg-gray-50"
                >
                  {item.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" className="h-10 w-10 rounded object-cover" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-gray-900">{item.name}</span>
                    <span className="block text-xs text-gray-500">{item.code}</span>
                  </span>
                </button>
              ))}
              {found.length === 0 && <p className="p-3 text-sm text-gray-500">Ничего не нашлось</p>}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Количество</span>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="mt-1 w-32 rounded-lg border border-gray-300 px-3 py-2 text-lg"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Заметка для цеха</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="необязательно"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
            />
          </label>

          <button
            onClick={submit}
            disabled={!picked || busy}
            className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Запускаем…' : 'Запустить'}
          </button>
        </div>
      </div>
    </div>
  );
}
