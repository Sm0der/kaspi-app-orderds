'use client';

import { useState } from 'react';
import { api, downloadFile, errorText } from '../lib/api';

// Формирование по наличию. Продавец вводит артикул и сколько штук готово; система
// раскладывает несобранные заказы по приоритету (срочность -> дата отгрузки) под это
// количество, добирая с других дат, если одной даты не хватает. Дату в Kaspi не меняем -
// это только отбор. Формирование - по одному подтверждению; предзаказам при этом уходит
// ARRIVED («товар поступил»), поэтому подтверждение спрашивает наличие явно.
export default function AllocatePanel({ storeId, onDone }) {
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [assembling, setAssembling] = useState(false);
  const [results, setResults] = useState(null);
  const [showOverflow, setShowOverflow] = useState(false);

  const allocate = async () => {
    const qty = Number(quantity);
    if (!sku.trim()) return setError('Впишите артикул');
    if (!Number.isInteger(qty) || qty < 1) return setError('Впишите количество — целое число от 1');

    setBusy(true);
    setError(null);
    setResults(null);
    setPlan(null);
    try {
      const { data } = await api.post('/api/orders/allocate-preview', {
        sku: sku.trim(),
        quantity: qty,
        storeId: storeId || undefined
      });
      setPlan(data);
      if (data.selectedCount === 0) setError('Под это количество не набралось ни одного заказа');
    } catch (err) {
      setError(errorText(err, 'Не удалось разложить'));
    } finally {
      setBusy(false);
    }
  };

  const assemble = async () => {
    if (!plan) return;
    const codes = plan.selected.map((o) => o.order_code);
    if (codes.length === 0) return;

    setAssembling(true);
    setError(null);
    try {
      // allowPreorderArrived: true - это и есть явное подтверждение наличия товара.
      // Без него сервер откажет предзаказам, чтобы не заявить Kaspi поступление зря.
      const { data } = await api.post('/api/orders/assemble-batch', {
        orderCodes: codes,
        allowPreorderArrived: true
      });
      setResults(data);
      setPlan(null);
      if (onDone) setTimeout(onDone, 1500);
    } catch (err) {
      setError(errorText(err, 'Не удалось сформировать'));
    } finally {
      setAssembling(false);
    }
  };

  const newCount = plan ? plan.selected.filter((o) => !o.reused).length : 0;

  return (
    <section className="panel rise" style={{ marginTop: 22 }}>
      <div className="panel-head">
        <div>
          <h2>Формирование по наличию</h2>
          <p className="panel-note">
            Укажите артикул и сколько штук готово — система наберёт заказы под это количество
            по приоритету (срочные и ранние даты первыми) и сформирует накладные
          </p>
        </div>
      </div>

      <div className="panel-body">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 200px' }}>
            <span className="eyebrow">Артикул</span>
            <input className="input" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="107549383" />
          </label>
          <label className="field" style={{ width: 140 }}>
            <span className="eyebrow">Готово, шт</span>
            <input
              className="input"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="10"
            />
          </label>
          <button className="btn" onClick={allocate} disabled={busy}>
            {busy && <span className="spinner" />} Разложить
          </button>
        </div>

        {error && <div className="alert alert-error" style={{ marginTop: 14 }}>{error}</div>}

        {plan && plan.selectedCount > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="alert alert-note">
              Под {plan.quantity} шт набрано заказов: <strong>{plan.selectedCount}</strong>
              {' '}(новых к сборке — {newCount}
              {plan.selectedCount - newCount > 0 && <>, уже собрано — {plan.selectedCount - newCount}</>})
              {plan.overflowCount > 0 && <>. Не хватило наличия на ещё {plan.overflowCount}</>}
              {plan.remainingUnits > 0 && <>. Остаток наличия: {plan.remainingUnits} шт</>}
            </div>

            {plan.preorderCount > 0 && (
              <div className="alert" style={{ borderColor: 'var(--amber)', color: 'var(--text)' }}>
                Среди набранных {plan.preorderCount} предзаказ(ов). При формировании им будет
                отправлено «товар поступил» (ARRIVED). Подтверждайте только если товар
                действительно на складе — иначе Kaspi начислит просрочку.
              </div>
            )}

            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Заказ</th>
                    <th>Магазин</th>
                    <th>Отгрузка</th>
                    <th style={{ textAlign: 'right' }}>Шт</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.selected.map((o) => (
                    <tr key={o.order_code}>
                      <td className="mono">{o.order_code}</td>
                      <td className="t-dim">{o.store_name}</td>
                      <td className="num t-dim">
                        {o.ship_date ? new Date(o.ship_date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—'}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>{o.units}</td>
                      <td>
                        {o.reused ? (
                          <span className="badge" style={{ borderColor: 'var(--steel)', color: 'var(--steel)' }}>уже собран</span>
                        ) : o.pre_order ? (
                          <span className="badge" style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }}>предзаказ → ARRIVED</span>
                        ) : (
                          <span className="t-faint">к сборке</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {plan.overflowCount > 0 && (
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-quiet btn-sm" onClick={() => setShowOverflow((v) => !v)}>
                  {showOverflow ? 'Скрыть' : 'Показать'} не вошедшие ({plan.overflowCount})
                </button>
                {showOverflow && (
                  <div className="t-dim" style={{ marginTop: 8, fontSize: 12.5, display: 'grid', gap: 4 }}>
                    {plan.overflow.map((o) => (
                      <div key={o.order_code}>
                        <span className="mono">{o.order_code}</span> · {o.store_name} · отгр.{' '}
                        {o.ship_date ? new Date(o.ship_date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—'}
                        {' '}· {o.units} шт
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              className="btn btn-primary"
              onClick={assemble}
              disabled={assembling || newCount === 0}
              style={{ marginTop: 14 }}
              title={newCount === 0 ? 'Все набранные заказы уже собраны' : undefined}
            >
              {assembling && <span className="spinner" />}
              {plan.preorderCount > 0
                ? `Отметить поступление и сформировать (${plan.selectedCount})`
                : `Сформировать (${plan.selectedCount})`}
            </button>
          </div>
        )}

        {results && <AllocateResults results={results} />}
      </div>
    </section>
  );
}

function AllocateResults({ results }) {
  const ok = results.results.filter((r) => r.success);
  const arrivedCount = results.results.filter((r) => r.success && r.arrived).length;
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const grab = async (kind) => {
    setBusy(kind);
    setFailure(null);
    try {
      if (kind === 'pdf') {
        const codes = ok.map((r) => r.order_code).join(',');
        await downloadFile(`/api/orders/manifest?orderCodes=${codes}`, `Манифест_${Date.now()}.pdf`);
      } else {
        await downloadFile(`/api/batches/${results.batchId}/waybills.zip`, `Накладные_${results.batchId}.zip`);
      }
    } catch (err) {
      setFailure(errorText(err, 'Не удалось скачать файл'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className={results.failed ? 'alert alert-error' : 'alert alert-ok'}>
        {results.waveNumber ? <>Вывоз №{results.waveNumber} готов: </> : 'Готово: '}
        {results.succeeded} успешно
        {arrivedCount > 0 && <> (из них {arrivedCount} предзаказ(ов) отмечены поступившими)</>}
        , {results.failed} с ошибкой — из {results.total}
      </div>

      {ok.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <button className="btn btn-primary" disabled={busy === 'pdf'} onClick={() => grab('pdf')}>
            {busy === 'pdf' && <span className="spinner" />} Сводный PDF ({ok.length})
          </button>
          {results.batchId && (
            <button className="btn" disabled={busy === 'zip'} onClick={() => grab('zip')}>
              {busy === 'zip' && <span className="spinner" />} Накладные Kaspi (ZIP)
            </button>
          )}
        </div>
      )}
      {failure && <div className="alert alert-error">{failure}</div>}

      <div style={{ display: 'grid', gap: 5, fontSize: 12.5 }}>
        {results.results.map((row, i) => (
          <div key={i} style={{ color: row.success ? (row.reused ? 'var(--steel)' : 'var(--sage)') : 'var(--red)' }}>
            <span className="mono">{row.order_code}</span>
            {row.success
              ? row.reused
                ? ' — уже был собран, накладная переиспользована'
                : row.arrived
                  ? ` — поступление отмечено, собран, ${row.numberOfSpace} мест`
                  : ` — собран, ${row.numberOfSpace} мест`
              : ` — ${row.error}`}
          </div>
        ))}
      </div>
    </div>
  );
}
