'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, errorText } from '../lib/api';
import { urgencyOf, totalQuantity } from '../lib/labels';
import RunsPanel from './RunsPanel';

// Архив сформированных пакетов накладных: когда собирали, что вошло и повторное
// скачивание документов. Сортировку считает сервер - список может быть длинным,
// а сортировать половину выборки на клиенте бессмысленно.

const COLUMNS = [
  { key: 'date', label: 'Сформирован' },
  { key: 'orders', label: 'Заказов', numeric: true },
  { key: 'spaces', label: 'Мест', numeric: true }
];

export default function ArchiveView() {
  const [batches, setBatches] = useState([]);
  const [sort, setSort] = useState('date');
  const [dir, setDir] = useState('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [openId, setOpenId] = useState(null);
  const [details, setDetails] = useState({});
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/api/batches', { params: { sort, dir } });
      setBatches(data.data || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить архив'));
    } finally {
      setLoading(false);
    }
  }, [sort, dir]);

  useEffect(() => { load(); }, [load]);

  const changeSort = (key) => {
    if (key === sort) {
      setDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSort(key);
      setDir('desc');
    }
  };

  const toggle = async (batch) => {
    if (openId === batch.id) return setOpenId(null);
    setOpenId(batch.id);

    if (details[batch.id]) return;
    try {
      const { data } = await api.get(`/api/batches/${batch.id}`);
      setDetails((prev) => ({ ...prev, [batch.id]: data.data }));
    } catch (err) {
      setError(errorText(err, 'Не удалось открыть пакет'));
    }
  };

  const download = async (batch, kind) => {
    setBusyId(`${batch.id}:${kind}`);
    setError(null);
    try {
      if (kind === 'pdf') {
        await downloadFile(`/api/batches/${batch.id}/manifest.pdf`, `Манифест_${batch.id}.pdf`);
      } else {
        await downloadFile(`/api/batches/${batch.id}/waybills.zip`, `Накладные_${batch.id}.zip`);
      }
    } catch (err) {
      setError(errorText(err, 'Не удалось скачать файл'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <h1>Архив накладных</h1>
          <p className="panel-note" style={{ marginTop: 4 }}>
            Каждое формирование сохраняется пакетом. Нажмите на строку, чтобы увидеть состав,
            или скачайте документы заново — накладные Kaspi подтягиваются свежими в момент скачивания.
          </p>
        </div>
        <div className="topbar-spacer" />
        <button className="btn" onClick={load} disabled={loading}>
          {loading && <span className="spinner" />} Обновить
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Вывозы идут первыми: их видно всегда, а пакеты ниже появляются только у тех
          накладных, что формировали через сервис */}
      <RunsPanel />

      <section className="panel rise">
        {loading ? (
          <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}
          </div>
        ) : batches.length === 0 ? (
          <div className="empty">
            Пока ничего не формировали. Пакеты появятся здесь после первой сборки накладных.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      onClick={() => changeSort(column.key)}
                      style={{ cursor: 'pointer', userSelect: 'none', textAlign: column.numeric ? 'right' : 'left' }}
                      title="Нажмите, чтобы отсортировать"
                    >
                      {column.label}
                      <span style={{ marginLeft: 5, color: sort === column.key ? 'var(--brass)' : 'var(--line-strong)' }}>
                        {sort === column.key ? (dir === 'desc' ? '↓' : '↑') : '↕'}
                      </span>
                    </th>
                  ))}
                  <th>Результат</th>
                  <th>Кто</th>
                  <th style={{ textAlign: 'right' }}>Документы</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <BatchRow
                    key={batch.id}
                    batch={batch}
                    open={openId === batch.id}
                    detail={details[batch.id]}
                    busyId={busyId}
                    onToggle={() => toggle(batch)}
                    onDownload={(kind) => download(batch, kind)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function BatchRow({ batch, open, detail, busyId, onToggle, onDownload }) {
  const created = new Date(batch.created_at);

  return (
    <>
      <tr className="order-row" onClick={onToggle}>
        <td>
          <div className="num" style={{ fontWeight: 500 }}>
            {created.toLocaleDateString('ru-RU')} <span className="t-dim">{created.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div className="eyebrow" style={{ marginTop: 3 }}>
            {batch.wave_number ? `Вывоз №${batch.wave_number} · ` : ''}пакет №{batch.id}
          </div>
        </td>
        <td className="num" style={{ textAlign: 'right' }}>{batch.orders_count}</td>
        <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{batch.spaces_total}</td>
        <td>
          <span style={{ color: 'var(--sage)' }} className="num">{batch.succeeded}</span>
          {batch.failed > 0 && (
            <span style={{ color: 'var(--red)' }} className="num"> / {batch.failed} с ошибкой</span>
          )}
        </td>
        <td className="t-dim" style={{ fontSize: 12 }}>{batch.created_by || '—'}</td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-sm"
            onClick={() => onDownload('pdf')}
            disabled={busyId === `${batch.id}:pdf`}
            title="Сводный список заказов и товаров пакета"
          >
            {busyId === `${batch.id}:pdf` && <span className="spinner" />} PDF
          </button>
          {' '}
          <button
            className="btn btn-sm"
            onClick={() => onDownload('zip')}
            disabled={busyId === `${batch.id}:zip`}
            title="Накладные Kaspi для наклейки на коробки, по файлу на заказ"
          >
            {busyId === `${batch.id}:zip` && <span className="spinner" />} ZIP
          </button>
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={6} style={{ paddingTop: 0 }}>
            {!detail ? (
              <div className="skeleton" style={{ height: 60 }} />
            ) : (
              <div className="order-items" style={{ display: 'grid', gap: 10, paddingTop: 6 }}>
                {detail.orders.length === 0 ? (
                  <span className="t-faint">Заказы пакета больше не найдены в базе</span>
                ) : detail.orders.map((order) => {
                  const urgency = urgencyOf(order.urgency);
                  const failed = order.outcome && !order.outcome.success;
                  const reused = order.outcome && order.outcome.success && order.outcome.reused;

                  return (
                    <div key={order.order_code} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                      <span className="order-code" style={{ minWidth: 92 }}>{order.order_code}</span>
                      <span className="num t-dim" style={{ minWidth: 58 }}>{order.numberOfSpace} мест</span>
                      <span className="t-dim" style={{ minWidth: 96 }}>{order.town || '—'}</span>
                      {order.waybill_number && (
                        <span className="mono t-faint" style={{ minWidth: 104 }}>№ {order.waybill_number}</span>
                      )}
                      <span style={{ flex: '1 1 220px' }}>
                        {(order.items || []).map((i) => `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`).join(', ') || '—'}
                        <span className="t-faint num"> · {totalQuantity(order.items)} шт</span>
                      </span>
                      {failed ? (
                        <span style={{ color: 'var(--red)' }}>{order.outcome.error}</span>
                      ) : reused ? (
                        <span style={{ color: 'var(--steel)' }} title="Заказ был собран в более раннем вывозе, накладная переиспользована">
                          переиспользован
                        </span>
                      ) : urgency ? (
                        <span style={{ color: urgency.color }}>{urgency.label}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
