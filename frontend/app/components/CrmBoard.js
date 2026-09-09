'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../lib/api';
import { stageOf, urgencyOf, shipmentLabel, totalQuantity, formatMoney } from '../lib/labels';
import Thumb from './Thumb';

const TONE_COLOR = {
  red: 'var(--red)',
  amber: 'var(--amber)',
  steel: 'var(--steel)',
  faint: 'var(--text-faint)'
};

// Колонка для заказов, которых ещё не касались руками. Она виртуальная - в базе у таких
// заказов просто нет внутреннего статуса, отдельной строки в crm_statuses для неё не нужно.
const INBOX = { id: null, name: 'Без статуса', color: '#6E655A' };

const PALETTE = ['#6E93B8', '#D6A756', '#7FA07F', '#5F7D8C', '#E0524A', '#A98BC4', '#E39A3B', '#7C736A'];

export default function CrmBoard({ orders, loading, onOrdersChange, isAdmin }) {
  const [statuses, setStatuses] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragCode, setDragCode] = useState(null);
  const [overColumn, setOverColumn] = useState(undefined);
  // Только undefined, никогда null: id колонки «Без статуса» и есть null, иначе она
  // сразу открылась бы на переименование
  const [editing, setEditing] = useState(undefined);
  const [showDone, setShowDone] = useState(false);

  const loadStatuses = async () => {
    try {
      const { data } = await api.get('/api/crm/statuses');
      setStatuses(data.data || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить статусы'));
    }
  };

  useEffect(() => { loadStatuses(); }, []);

  // На доске держим только то, над чем ещё идёт работа: доставленные и отменённые заказы
  // копятся сотнями и превратили бы доску в архив. При необходимости их можно показать.
  const boardOrders = useMemo(
    () => orders.filter((o) => showDone || !['completed', 'cancelled'].includes(o.stage)),
    [orders, showDone]
  );

  const columns = useMemo(() => [INBOX, ...statuses], [statuses]);

  const byColumn = useMemo(() => {
    const map = new Map(columns.map((c) => [c.id, []]));
    for (const order of boardOrders) {
      const key = map.has(order.crm_status_id) ? order.crm_status_id : null;
      map.get(key).push(order);
    }
    return map;
  }, [columns, boardOrders]);

  // — перенос карточки —
  const moveOrder = async (orderCode, statusId) => {
    const order = orders.find((o) => o.order_code === orderCode);
    if (!order || order.crm_status_id === statusId) return;

    // Оптимистично: карточка переезжает сразу, ответ сервера только подтверждает
    onOrdersChange((prev) =>
      prev.map((o) => (o.order_code === orderCode ? { ...o, crm_status_id: statusId } : o))
    );

    try {
      await api.put('/api/crm/orders', { orderCodes: [orderCode], statusId });
    } catch (err) {
      setError(errorText(err, 'Не удалось перенести заказ'));
      onOrdersChange((prev) =>
        prev.map((o) => (o.order_code === orderCode ? { ...o, crm_status_id: order.crm_status_id } : o))
      );
    }
  };

  // — управление колонками —
  const addStatus = async () => {
    const name = window.prompt('Название нового статуса');
    if (!name?.trim()) return;

    setBusy(true);
    try {
      const color = PALETTE[statuses.length % PALETTE.length];
      const { data } = await api.post('/api/crm/statuses', { name: name.trim(), color });
      setStatuses((prev) => [...prev, data.data]);
    } catch (err) {
      setError(errorText(err, 'Не удалось создать статус'));
    } finally {
      setBusy(false);
    }
  };

  const saveStatus = async (id, patch) => {
    setStatuses((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    try {
      await api.patch(`/api/crm/statuses/${id}`, patch);
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить статус'));
      loadStatuses();
    }
  };

  const removeStatus = async (status) => {
    const count = byColumn.get(status.id)?.length || 0;
    const question = count
      ? `Удалить статус «${status.name}»? ${count} заказ(ов) вернутся в колонку «Без статуса».`
      : `Удалить статус «${status.name}»?`;
    if (!window.confirm(question)) return;

    try {
      await api.delete(`/api/crm/statuses/${status.id}`);
      setStatuses((prev) => prev.filter((s) => s.id !== status.id));
      onOrdersChange((prev) =>
        prev.map((o) => (o.crm_status_id === status.id ? { ...o, crm_status_id: null } : o))
      );
    } catch (err) {
      setError(errorText(err, 'Не удалось удалить статус'));
    }
  };

  const moveColumn = async (index, direction) => {
    const next = [...statuses];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;

    [next[index], next[target]] = [next[target], next[index]];
    setStatuses(next);

    try {
      await api.put('/api/crm/statuses/order', { ids: next.map((s) => s.id) });
    } catch (err) {
      setError(errorText(err, 'Не удалось изменить порядок'));
      loadStatuses();
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Внутренняя воронка</h1>
          <p className="panel-note" style={{ marginTop: 4 }}>
            {isAdmin
              ? 'Ваши статусы поверх статусов Kaspi. Карточки перетаскиваются мышью, колонки переименовываются по клику на название.'
              : 'Ваши статусы поверх статусов Kaspi. Перетаскивайте карточки мышью — набор колонок настраивает администратор.'}
          </p>
        </div>
        <div className="topbar-spacer" />
        <button className="chip" data-active={showDone} onClick={() => setShowDone(!showDone)}>
          Показывать завершённые
        </button>
        {isAdmin && <button className="btn" onClick={addStatus} disabled={busy}>+ Статус</button>}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="board">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="column">
              <div className="column-head"><div className="skeleton" style={{ width: '60%' }} /></div>
              <div className="column-body">
                {Array.from({ length: 3 }, (_, j) => <div key={j} className="skeleton" style={{ height: 62 }} />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="board rise">
          {columns.map((column, index) => {
            const cards = byColumn.get(column.id) || [];
            const isInbox = column.id === null;

            return (
              <section
                key={column.id ?? 'inbox'}
                className="column"
                data-over={overColumn === column.id}
                onDragOver={(e) => { e.preventDefault(); setOverColumn(column.id); }}
                onDragLeave={() => setOverColumn((prev) => (prev === column.id ? undefined : prev))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverColumn(undefined);
                  if (dragCode) moveOrder(dragCode, column.id);
                  setDragCode(null);
                }}
              >
                <header className="column-head">
                  <span className="dot" style={{ background: column.color }} />

                  {isAdmin && editing === column.id ? (
                    <input
                      className="input"
                      style={{ padding: '4px 8px', fontSize: 13 }}
                      defaultValue={column.name}
                      autoFocus
                      onBlur={(e) => {
                        const value = e.target.value.trim();
                        if (value && value !== column.name) saveStatus(column.id, { name: value });
                        setEditing(undefined);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.target.blur();
                        if (e.key === 'Escape') setEditing(undefined);
                      }}
                    />
                  ) : (
                    <span
                      className="column-title"
                      onClick={() => isAdmin && !isInbox && setEditing(column.id)}
                      style={{ cursor: isAdmin && !isInbox ? 'text' : 'default' }}
                      title={isAdmin && !isInbox ? 'Нажмите, чтобы переименовать' : undefined}
                    >
                      {column.name}
                    </span>
                  )}

                  <span className="column-count">{cards.length}</span>

                  {isAdmin && !isInbox && (
                    <div style={{ display: 'flex', gap: 2 }}>
                      <label className="btn btn-quiet btn-icon" title="Цвет" style={{ position: 'relative', overflow: 'hidden' }}>
                        <span aria-hidden="true">◐</span>
                        <input
                          type="color"
                          value={column.color}
                          onChange={(e) => saveStatus(column.id, { color: e.target.value })}
                          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                        />
                      </label>
                      <button className="btn btn-quiet btn-icon" title="Левее" onClick={() => moveColumn(index - 1, -1)}>‹</button>
                      <button className="btn btn-quiet btn-icon" title="Правее" onClick={() => moveColumn(index - 1, 1)}>›</button>
                      <button className="btn btn-quiet btn-icon btn-danger" title="Удалить" onClick={() => removeStatus(column)}>×</button>
                    </div>
                  )}
                </header>

                <div className="column-body">
                  {cards.length === 0 ? (
                    <div className="column-empty">Перетащите заказ сюда</div>
                  ) : (
                    cards.slice(0, 80).map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        dragging={dragCode === order.order_code}
                        onDragStart={() => setDragCode(order.order_code)}
                        onDragEnd={() => { setDragCode(null); setOverColumn(undefined); }}
                      />
                    ))
                  )}
                  {cards.length > 80 && (
                    <div className="column-empty">и ещё {cards.length - 80} — сузьте фильтр по магазину</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function OrderCard({ order, dragging, onDragStart, onDragEnd }) {
  const stage = stageOf(order.stage);
  const urgency = urgencyOf(order.urgency);
  const ship = shipmentLabel(order.shipment_plan_ms, order.shipment_fact_ms);
  const items = order.items || [];

  return (
    <article
      className="card"
      draggable
      data-dragging={dragging}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="card-top">
        <span className="dot" style={{ background: stage.color }} title={stage.label} />
        <span className="order-code" style={{ fontSize: 12.5 }}>{order.order_code}</span>
        <div className="topbar-spacer" />
        {urgency && ['new', 'accepted', 'packed'].includes(order.stage) && (
          <span style={{ fontSize: 11, color: urgency.color }}>{urgency.label}</span>
        )}
      </div>

      <div className="card-title">
        {items.length > 0 && <Thumb src={items[0].imageUrl} alt={items[0].name} size="sm" />}
        <span className="card-title-text">
          {items.length === 0 ? '—' : items[0].name}
          {items.length > 1 && <span className="t-faint"> +{items.length - 1}</span>}
        </span>
      </div>

      <div className="card-meta">
        {order.customer_name && (
          <span>{order.customer_name}{order.customer_last_name ? ` ${order.customer_last_name}.` : ''}</span>
        )}
        {order.town && <span>{order.town}</span>}
        <span className="mono">{totalQuantity(items)} шт</span>
        <span className="mono">{formatMoney(order.total_price)}</span>
        <span className="mono" style={{ color: TONE_COLOR[ship.tone] }}>{ship.text}</span>
      </div>
    </article>
  );
}
