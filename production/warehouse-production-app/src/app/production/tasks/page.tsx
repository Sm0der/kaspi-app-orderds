'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import { apiFetch } from '@/lib/session';
import { PRODUCTION_ITEM_STATUS_LABELS } from '@/lib/labels';
import type { User } from '@/types';

interface Task {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  status: string;
  notes: string | null;
  imageUrl: string | null;
  code: string | null;
  workshopName: string;
  doneHere: number;
  defectsHere: number;
  remaining: number;
}

interface Workshop {
  id: string;
  name: string;
}

interface Payload {
  workshop: Workshop | null;
  tasks: Task[];
  workshops: Workshop[];
}

export default function WorkshopTasksPage() {
  return <Protected area="production">{(user) => <Screen user={user} />}</Protected>;
}

function Screen({ user }: { user: User }) {
  const [data, setData] = useState<Payload | null>(null);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (workshopId?: string) => {
    try {
      const query = workshopId ? `?workshopId=${workshopId}` : '';
      setData(await apiFetch<Payload>(`/api/production/tasks${query}`));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить задачи');
    }
  }, []);

  useEffect(() => {
    load(chosen || undefined);
  }, [load, chosen]);

  if (!data) {
    return <Shell title="Мой цех">{error ? <Alert text={error} /> : <p className="text-faint">Загрузка…</p>}</Shell>;
  }

  // У администратора своего цеха нет - ему нужен выбор, иначе страницу нечем наполнить
  const picker = user.role === 'ADMIN' && data.workshops.length > 0 && (
    <select
      value={chosen || data.workshop?.id || ''}
      onChange={(e) => setChosen(e.target.value)}
      className="rounded border border-line px-3 py-2 text-sm"
    >
      <option value="">Выберите цех</option>
      {data.workshops.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );

  if (!data.workshop) {
    return (
      <Shell title="Мой цех" right={picker}>
        <Empty
          title={user.role === 'ADMIN' ? 'Выберите цех сверху' : 'Ваша учётная запись не привязана к цеху'}
          text={
            user.role === 'ADMIN'
              ? 'У администратора своего цеха нет — посмотреть можно любой.'
              : 'Попросите администратора указать ваш цех в учётной записи.'
          }
        />
      </Shell>
    );
  }

  return (
    <Shell title={data.workshop.name} subtitle="Задачи, стоящие сейчас в вашем цехе" right={picker}>
      {error && <Alert text={error} />}
      {notice && (
        <div className="mb-4 rounded border border-ok bg-ok/10 p-3 text-sm text-ok">{notice}</div>
      )}

      {data.tasks.length === 0 ? (
        <Empty title="Задач нет" text="Как только мастер запустит изделие в производство, оно появится здесь." />
      ) : (
        <div className="space-y-4">
          {data.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onDone={(message) => {
                setNotice(message);
                setError('');
                load(chosen || undefined);
              }}
              onError={(message) => {
                setError(message);
                setNotice('');
              }}
            />
          ))}
        </div>
      )}
    </Shell>
  );
}

function TaskCard({
  task,
  onDone,
  onError,
}: {
  task: Task;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  // По умолчанию предлагаем закрыть весь остаток: чаще всего рабочий так и делает,
  // а поправить число - одно касание
  const [quantity, setQuantity] = useState(String(task.remaining));
  const [defect, setDefect] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await apiFetch<{ message: string }>(`/api/production/tasks/${task.id}/operations`, {
        method: 'POST',
        body: JSON.stringify({
          quantity: Number(quantity),
          status: defect ? 'DEFECTIVE' : 'COMPLETED',
          notes,
        }),
      });
      setDefect(false);
      setNotes('');
      onDone(result.message);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Не удалось записать');
    } finally {
      setBusy(false);
    }
  };

  const progress = Math.round((task.doneHere / task.quantity) * 100);

  return (
    <div className="rounded-lg bg-surface p-4 shadow-flat">
      <div className="flex gap-4">
        {task.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={task.imageUrl} alt="" className="h-24 w-24 shrink-0 rounded object-cover" />
        ) : (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded bg-canvas text-xs text-faint">
            без фото
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-ink">{task.name}</h3>
            <span className="rounded bg-canvas px-2 py-0.5 text-xs text-muted">
              {PRODUCTION_ITEM_STATUS_LABELS[task.status] || task.status}
            </span>
            {task.defectsHere > 0 && (
              <span className="rounded bg-danger/10 px-2 py-0.5 text-xs text-danger">
                брак: {task.defectsHere}
              </span>
            )}
          </div>

          {task.code && <div className="text-sm text-faint">{task.code}</div>}
          {task.notes && <p className="mt-1 text-sm text-muted">{task.notes}</p>}

          <div className="mt-3">
            <div className="mb-1 flex justify-between text-sm text-muted">
              <span>
                Сделано {task.doneHere} из {task.quantity} {task.unit}
              </span>
              <span className="font-semibold">осталось {task.remaining}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-lifted">
              <div className="h-full bg-brass" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line-soft pt-4">
        <label className="block">
          <span className="text-sm font-medium text-muted">Сколько {task.unit}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={task.remaining}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="mt-1 w-28 rounded-lg border border-line px-3 py-2 text-lg"
          />
        </label>

        <label className="flex items-center gap-2 pb-2 text-sm text-muted">
          <input type="checkbox" checked={defect} onChange={(e) => setDefect(e.target.checked)} className="h-4 w-4" />
          это брак
        </label>

        {defect && (
          <label className="block flex-1">
            <span className="text-sm font-medium text-muted">Что случилось</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="скол на кромке, сверло ушло в сторону…"
              className="mt-1 w-full rounded-lg border border-line px-3 py-2"
            />
          </label>
        )}

        <button
          onClick={submit}
          disabled={busy || task.remaining === 0}
          className={`rounded-lg px-6 py-3 font-semibold text-on-brass disabled:opacity-50 ${
            defect ? 'bg-danger hover:bg-danger' : 'bg-brass hover:bg-brass-bright'
          }`}
        >
          {busy ? 'Записываем…' : defect ? 'Записать брак' : 'Готово'}
        </button>
      </div>
    </div>
  );
}

function Shell({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-ink">{title}</h1>
            {subtitle && <p className="text-sm text-faint">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-4">
            {right}
            <Link href="/dashboard" className="text-sm text-brass hover:underline">
              ← Ко всем разделам
            </Link>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}

function Alert({ text }: { text: string }) {
  return <div className="mb-4 rounded border border-danger bg-danger/10 p-3 text-sm text-danger">{text}</div>;
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg bg-surface p-8 text-center shadow-flat">
      <h2 className="mb-2 text-lg font-semibold text-ink">{title}</h2>
      <p className="text-muted">{text}</p>
    </div>
  );
}
