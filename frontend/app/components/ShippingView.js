'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile, errorText } from '../lib/api';
import {
  STAGES, STAGE_ORDER, stageOf, urgencyOf,
  shipmentLabel, isShippingToday, formatMoney, totalQuantity
} from '../lib/labels';
import Thumb from './Thumb';

const TONE_COLOR = {
  red: 'var(--red)',
  amber: 'var(--amber)',
  steel: 'var(--steel)',
  faint: 'var(--text-faint)'
};

export default function ShippingView({ orders, summary, loading, filters, setFilters, storeId, onRefetch, isAdmin }) {
  const [stage, setStage] = useState(null);
  const [urgency, setUrgency] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState(null);

  const listRef = useRef(null);

  // — поиск по товару с подсказками —
  const [productInput, setProductInput] = useState(filters.product);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestOpen, setSuggestOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      setFilters((prev) => ({ ...prev, product: productInput }));
      try {
        const params = {};
        if (productInput) params.q = productInput;
        if (storeId) params.storeId = storeId;
        const { data } = await api.get('/api/orders/products/suggest', { params });
        setSuggestions(data.data || []);
      } catch {
        setSuggestions([]);
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productInput, storeId]);

  // — поиск заказов по артикулу —
  const [sku, setSku] = useState('');
  const [packingMode, setPackingMode] = useState('unitsPerSpace');
  const [packingValue, setPackingValue] = useState(1);
  const [skuBusy, setSkuBusy] = useState(false);
  const [skuFound, setSkuFound] = useState(null);

  // — пакетное формирование накладных —
  const [codesInput, setCodesInput] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [results, setResults] = useState(null);

  const orderCodes = () => codesInput.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

  const findBySku = async () => {
    const value = sku.trim();
    if (!value) return setError('Введите артикул товара');

    setSkuBusy(true);
    setError(null);
    setSkuFound(null);
    setPreview(null);
    setResults(null);

    try {
      // Правило упаковки приводим к единому виду «мест на 1 штуку»: для мелкого товара
      // это 1/значение (10 шт в месте → 0.1), для крупного — само значение (4 места на шт).
      const amount = Number(packingValue);
      if (isAdmin && amount > 0) {
        const spacesPerUnit = packingMode === 'unitsPerSpace' ? 1 / amount : amount;
        try {
          await api.put('/api/orders/products/packing', {
            sku: value,
            spacesPerUnit,
            storeId: storeId || undefined
          });
        } catch {
          // товара может не быть в каталоге — на поиск заказов это не влияет
        }
      }

      const { data } = await api.get('/api/orders/by-sku', {
        params: { sku: value, storeId: storeId || undefined }
      });
      const codes = data.orders.map((o) => o.order_code);
      const alreadyAssembled = data.orders.filter((o) => o.assembled).length;
      setSkuFound({ sku: value, count: codes.length, alreadyAssembled });

      if (codes.length === 0) {
        setError(`Неотправленных заказов с артикулом «${value}» не найдено`);
      } else {
        setCodesInput(codes.join('\n'));
      }
    } catch (err) {
      setError(errorText(err, 'Не удалось найти заказы по артикулу'));
    } finally {
      setSkuBusy(false);
    }
  };

  const runPreview = async () => {
    const codes = orderCodes();
    if (codes.length === 0) return setError('Впишите хотя бы один номер заказа');

    setPreviewBusy(true);
    setError(null);
    setResults(null);
    try {
      const { data } = await api.get('/api/orders/assemble-preview', {
        params: { orderCodes: codes.join(',') }
      });
      setPreview(data);
    } catch (err) {
      setError(errorText(err, 'Не удалось построить предпросмотр'));
    } finally {
      setPreviewBusy(false);
    }
  };

  const runAssemble = async () => {
    const codes = orderCodes();
    if (codes.length === 0) return;

    setAssembling(true);
    setError(null);
    try {
      const { data } = await api.post('/api/orders/assemble-batch', { orderCodes: codes });
      setResults(data);
      setPreview(null);
      setTimeout(onRefetch, 1500);
    } catch (err) {
      setError(errorText(err, 'Не удалось сформировать накладные'));
    } finally {
      setAssembling(false);
    }
  };

  // — производные списки —
  const visible = useMemo(() => orders.filter((o) => {
    if (stage && o.stage !== stage) return false;
    if (urgency === 'urgent') return o.urgency === 'today' || o.urgency === 'overdue';
    if (urgency && o.urgency !== urgency) return false;
    return true;
  }), [orders, stage, urgency]);

  const productSummary = useMemo(() => {
    const map = new Map();
    for (const order of visible) {
      for (const item of order.items || []) {
        const key = item.sku || item.name;
        if (!map.has(key)) map.set(key, { name: item.name, sku: item.sku, quantity: 0, orders: 0 });
        const row = map.get(key);
        row.quantity += Number(item.quantity) || 1;
        row.orders += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.quantity - a.quantity);
  }, [visible]);

  const shipTodayCount = useMemo(
    () => orders.filter((o) => isShippingToday(o.shipment_plan_ms) && !o.assembled).length,
    [orders]
  );

  const stageCounts = useMemo(() => {
    const counts = {};
    for (const order of orders) counts[order.stage] = (counts[order.stage] || 0) + 1;
    return counts;
  }, [orders]);

  const scrollToList = () => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const toggleUrgency = (value) => {
    setUrgency((prev) => (prev === value ? null : value));
    scrollToList();
  };

  const total = summary?.total ?? {};
  const setDate = (key) => (event) => setFilters((prev) => ({ ...prev, [key]: event.target.value }));
  const setCreated = (preset) => setFilters((prev) => ({ ...prev, createdPreset: preset }));

  const filtersDirty = filters.product || filters.dateFrom || filters.dateTo || filters.createdPreset !== 'all';

  return (
    <>
      {/* ── Показатели ─────────────────────────────────────────────── */}
      <div className="kpi-grid rise">
        <Kpi
          value={total.total ?? 0}
          label="Всего заказов в работе"
          active={!urgency && !stage}
          onClick={() => { setUrgency(null); setStage(null); scrollToList(); }}
        />
        <Kpi
          value={shipTodayCount}
          label="Отгрузка сегодня, не собраны"
          accent="var(--brass)"
          active={false}
          onClick={() => { setStage('accepted'); scrollToList(); }}
          hint="Kaspi разрешает формировать накладную, когда подошла дата передачи курьеру"
        />
        <Kpi
          value={total.today ?? 0}
          label="Доставить сегодня"
          accent="var(--amber)"
          active={urgency === 'today'}
          onClick={() => toggleUrgency('today')}
        />
        <Kpi
          value={total.urgent ?? 0}
          label="Срочные"
          accent="var(--red)"
          active={urgency === 'urgent'}
          onClick={() => toggleUrgency('urgent')}
        />
        <Kpi
          value={total.overdue ?? 0}
          label="Просрочено"
          accent={total.overdue ? 'var(--red)' : undefined}
          active={urgency === 'overdue'}
          onClick={() => toggleUrgency('overdue')}
        />
      </div>

      {/* ── Этапы ──────────────────────────────────────────────────── */}
      <div className="chip-row" style={{ marginBottom: 18 }}>
        <button className="chip" data-active={!stage} onClick={() => { setStage(null); scrollToList(); }}>
          Все этапы <span className="count">{orders.length}</span>
        </button>
        {STAGE_ORDER.map((key) => (
          <button
            key={key}
            className="chip"
            data-active={stage === key}
            onClick={() => { setStage(stage === key ? null : key); scrollToList(); }}
          >
            <span className="dot" style={{ background: STAGES[key].color, display: 'inline-block', marginRight: 6 }} />
            {STAGES[key].short} <span className="count">{stageCounts[key] || 0}</span>
          </button>
        ))}
      </div>

      {/* ── Фильтры ────────────────────────────────────────────────── */}
      <div className="filters rise">
        <div className="field suggest-wrap" style={{ minWidth: 240 }}>
          <label>Поиск по товару</label>
          <input
            className="input"
            value={productInput}
            onChange={(e) => setProductInput(e.target.value)}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
            placeholder="Например: шкаф"
            autoComplete="off"
          />
          {suggestOpen && suggestions.length > 0 && (
            <ul className="suggest">
              {suggestions.slice(0, 40).map((name, i) => (
                <li key={i} onMouseDown={() => { setProductInput(name); setSuggestOpen(false); }}>
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="field">
          <label title="Плановая дата передачи курьеру - как в кабинете Kaspi">Передать курьеру с</label>
          <input type="date" className="input" value={filters.dateFrom} onChange={setDate('dateFrom')} />
        </div>
        <div className="field">
          <label>по</label>
          <input type="date" className="input" value={filters.dateTo} onChange={setDate('dateTo')} />
        </div>

        <div className="divider" />

        <div className="field">
          <label>Новые заказы</label>
          <div className="chip-row">
            {[['all', 'Все'], ['today', 'Сегодня'], ['yesterday', 'Вчера'], ['month', 'Месяц']].map(([key, label]) => (
              <button key={key} className="chip" data-active={filters.createdPreset === key} onClick={() => setCreated(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {filtersDirty && (
          <button
            className="btn btn-quiet btn-sm"
            onClick={() => {
              setProductInput('');
              setFilters({ product: '', dateFrom: '', dateTo: '', createdPreset: 'all' });
            }}
          >
            Сбросить
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* ── Рабочие панели ─────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginBottom: 22 }}>
        <section className="panel rise">
          <div className="panel-head">
            <h2>Найти заказы по артикулу</h2>
          </div>
          <div className="panel-body">
            <p className="panel-note" style={{ marginBottom: 16 }}>
              {isAdmin
                ? 'Укажите артикул и правило упаковки. Система найдёт все неотправленные заказы с этим товаром, отсортирует по срочности и подставит номера в соседнюю панель.'
                : 'Укажите артикул. Система найдёт все неотправленные заказы с этим товаром по сохранённому правилу упаковки и подставит номера в соседнюю панель.'}
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: '1 1 150px' }}>
                <label>Артикул</label>
                <input className="input mono" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="108268540" />
              </div>
              {isAdmin && (
                <>
                  <div className="field" style={{ flex: '1 1 190px' }}>
                    <label>Правило упаковки</label>
                    <select className="select" value={packingMode} onChange={(e) => setPackingMode(e.target.value)}>
                      <option value="unitsPerSpace">Штук в одном месте</option>
                      <option value="spacesPerUnit">Мест на одну штуку</option>
                    </select>
                  </div>
                  <div className="field" style={{ width: 88 }}>
                    <label>Сколько</label>
                    <input
                      type="number"
                      min="1"
                      className="input mono"
                      value={packingValue}
                      onChange={(e) => setPackingValue(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    />
                  </div>
                </>
              )}
              <button className="btn btn-primary" onClick={findBySku} disabled={skuBusy || !sku.trim()}>
                {skuBusy && <span className="spinner" />} Найти
              </button>
            </div>
            {skuFound && skuFound.count > 0 && (
              <div className="alert alert-ok" style={{ margin: '16px 0 0' }}>
                Найдено {skuFound.count} заказ(ов) с артикулом «{skuFound.sku}» — номера подставлены.
                {skuFound.alreadyAssembled > 0 && (
                  <> Из них {skuFound.alreadyAssembled} уже собраны в прошлом вывозе и ждут отправки —
                  повторно к Kaspi обращаться не будем, просто переиспользуем накладную.</>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="panel rise">
          <div className="panel-head">
            <h2>Сформировать накладные</h2>
          </div>
          <div className="panel-body">
            <p className="panel-note" style={{ marginBottom: 16 }}>
              Заказы обрабатываются по приоритету: просроченные, затем сегодняшние. Количество мест
              считается по составу заказа и правилам упаковки.
            </p>
            <textarea
              className="textarea mono"
              value={codesInput}
              onChange={(e) => { setCodesInput(e.target.value); setPreview(null); setResults(null); }}
              placeholder={'1035993906\n1040537571, 1032519407'}
              rows={3}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn" onClick={runPreview} disabled={previewBusy || assembling || !codesInput.trim()}>
                {previewBusy && <span className="spinner" />} Предпросмотр
              </button>
              {preview && (
                <button className="btn btn-primary" onClick={runAssemble} disabled={assembling || preview.orders.length === 0}>
                  {assembling && <span className="spinner" />} Сформировать ({preview.orders.length})
                </button>
              )}
            </div>

            {preview && <AssemblePreview preview={preview} />}
            {results && <AssembleResults results={results} />}
          </div>
        </section>
      </div>

      {isAdmin && <ProductImagesPanel />}

      {/* ── Сводка товаров ─────────────────────────────────────────── */}
      {(stage || urgency) && productSummary.length > 0 && (
        <section className="panel rise" style={{ marginBottom: 22 }}>
          <div className="panel-head">
            <h2>Товары в отобранных заказах</h2>
            <span className="eyebrow">{visible.length} заказов</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Артикул</th>
                  <th style={{ textAlign: 'right' }}>Штук</th>
                  <th style={{ textAlign: 'right' }}>Заказов</th>
                </tr>
              </thead>
              <tbody>
                {productSummary.map((row) => (
                  <tr key={row.sku || row.name}>
                    <td>{row.name || '—'}</td>
                    <td className="num t-dim">{row.sku || '—'}</td>
                    <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{row.quantity}</td>
                    <td className="num t-dim" style={{ textAlign: 'right' }}>{row.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Список заказов ─────────────────────────────────────────── */}
      <section className="panel rise" ref={listRef}>
        <div className="panel-head">
          <h2>Заказы</h2>
          <span className="eyebrow">{visible.length}</span>
        </div>

        {loading ? (
          <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">Под текущие фильтры ничего не подошло</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Этап</th>
                  <th>Город</th>
                  <th>Отгрузка</th>
                  <th>Доставка</th>
                  <th>Фото</th>
                  <th>Товары</th>
                  <th style={{ textAlign: 'right' }}>Шт</th>
                  <th style={{ textAlign: 'right' }}>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((order) => (
                  <OrderRow
                    key={order.id}
                    order={order}
                    expanded={expanded === order.id}
                    onToggle={() => setExpanded(expanded === order.id ? null : order.id)}
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

// Картинки товаров Kaspi не отдаёт через API продавца (только при загрузке товара самим
// продавцом) - подтягиваются из публичного поиска kaspi.kz по артикулу. Кнопки "подтянуть"
// здесь нет намеренно: Kaspi блокирует этот поиск по IP датацентра Vercel (30 из 30
// запросов подряд получили 429 со страницей защиты от ботов, с первой же попытки) - сама
// кнопка была бы обречена всегда возвращать "найдено 0". Пополнение каталога делается
// разово вручную, с обычного адреса, поэтому здесь только статус.
function ProductImagesPanel() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api.get('/api/orders/products/images/status')
      .then(({ data }) => setStatus(data))
      .catch(() => setStatus(null));
  }, []);

  if (!status || status.total === 0) return null;

  return (
    <section className="panel rise" style={{ marginBottom: 22 }}>
      <div className="panel-head">
        <h2>Картинки товаров</h2>
        <span className="eyebrow">{status.total - status.missing} из {status.total} с картинкой</span>
      </div>
      <div className="panel-body">
        {status.missing === 0 ? (
          <div className="alert alert-ok">Картинки подтянуты для всех товаров каталога.</div>
        ) : (
          <p className="panel-note">
            У {status.missing} товаров пока нет фото — Kaspi не отдаёт их по обычному
            запросу с сервера. Попросите обновить каталог, когда появятся новые товары
            без картинки.
          </p>
        )}
      </div>
    </section>
  );
}

function Kpi({ value, label, accent, active, onClick, hint }) {
  return (
    <button className="kpi" data-active={active} onClick={onClick} style={{ '--accent': accent }} title={hint}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </button>
  );
}

function OrderRow({ order, expanded, onToggle }) {
  const stage = stageOf(order.stage);
  const urgency = urgencyOf(order.urgency);
  const ship = shipmentLabel(order.shipment_plan_ms);
  const items = order.items || [];

  return (
    <>
      <tr className="order-row" onClick={onToggle}>
        <td>
          <div className="order-code">{order.order_code || order.kaspi_order_id}</div>
          <div className="eyebrow" style={{ marginTop: 3 }}>{order.store_name}</div>
        </td>
        <td>
          <span className="badge" style={{ background: 'var(--ink-700)', borderColor: 'var(--line)' }}>
            <span className="dot" style={{ background: stage.color }} />
            {stage.short}
          </span>
          {urgency && ['new', 'accepted', 'packed'].includes(order.stage) && (
            <div style={{ marginTop: 5, fontSize: 11.5, color: urgency.color }}>{urgency.label}</div>
          )}
        </td>
        <td className="t-dim">
          {order.town || '—'}
          {order.customer_name && (
            <div className="eyebrow" style={{ marginTop: 3, textTransform: 'none', letterSpacing: 0 }}>
              {order.customer_name}{order.customer_last_name ? ` ${order.customer_last_name}.` : ''}
            </div>
          )}
        </td>
        <td className="num" style={{ color: TONE_COLOR[ship.tone] }}>{ship.text}</td>
        <td className="num t-dim">
          {order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('ru-RU') : '—'}
        </td>
        <td>
          {items.length > 0 && <Thumb src={items[0].imageUrl} alt={items[0].name} />}
        </td>
        <td className="t-dim" style={{ maxWidth: 320 }}>
          {items.length === 0 ? (
            '—'
          ) : (
            <span>
              {items[0].name}
              {items.length > 1 && <span className="t-faint"> +{items.length - 1}</span>}
            </span>
          )}
        </td>
        <td className="num" style={{ textAlign: 'right' }}>{totalQuantity(items)}</td>
        <td className="num t-dim" style={{ textAlign: 'right' }}>{formatMoney(order.total_price)}</td>
      </tr>
      {expanded && items.length > 0 && (
        <tr>
          <td colSpan={9} style={{ paddingTop: 0 }}>
            <div className="order-items">
              {items.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Thumb src={item.imageUrl} alt={item.name} size="sm" />
                  <span>
                    {item.name}
                    {item.quantity > 1 && <strong className="num"> × {item.quantity}</strong>}
                    {item.sku && <span className="t-faint mono"> · {item.sku}</span>}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AssemblePreview({ preview }) {
  const reusedCount = preview.orders.filter((o) => o.assembled).length;

  return (
    <div style={{ marginTop: 18 }}>
      {preview.notFound.length > 0 && (
        <div className="alert alert-error">Не найдены в базе: {preview.notFound.join(', ')}</div>
      )}
      {reusedCount > 0 && (
        <div className="alert alert-ok">
          {reusedCount} заказ(ов) уже собраны раньше — их накладные просто переиспользуются,
          Kaspi для них повторно не дёргаем.
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Заказ</th>
              <th>Срочность</th>
              <th style={{ textAlign: 'right' }}>Позиций</th>
              <th style={{ textAlign: 'right' }}>Мест</th>
              <th>Товары</th>
            </tr>
          </thead>
          <tbody>
            {preview.orders.map((order) => {
              const urgency = urgencyOf(order.urgency);
              return (
                <tr key={order.order_code}>
                  <td className="order-code">
                    {order.order_code}
                    {order.assembled && (
                      <span
                        className="badge"
                        style={{ marginLeft: 8, background: 'var(--ink-700)', borderColor: 'var(--steel)', color: 'var(--steel)' }}
                        title="Уже собран в прошлом вывозе - накладная будет переиспользована"
                      >
                        уже собран
                      </span>
                    )}
                  </td>
                  <td style={{ color: urgency?.color }}>{urgency?.label || '—'}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{order.positionsCount}</td>
                  <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{order.numberOfSpace}</td>
                  <td className="t-dim" style={{ maxWidth: 280 }}>
                    {order.items.map((i) => i.name).join(', ') || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssembleResults({ results }) {
  const ok = results.results.filter((r) => r.success);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  // Документы отдаёт закрытый логином эндпоинт, поэтому забираем их запросом с токеном,
  // а не ссылкой: по обычной ссылке браузер пришёл бы без заголовка и получил 401.
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

  const reusedCount = results.results.filter((r) => r.success && r.reused).length;

  return (
    <div style={{ marginTop: 18 }}>
      <div className={results.failed ? 'alert alert-error' : 'alert alert-ok'}>
        {results.waveNumber ? <>Вывоз №{results.waveNumber} готов: </> : 'Готово: '}
        {results.succeeded} успешно
        {reusedCount > 0 && <> (из них {reusedCount} переиспользовано)</>}
        , {results.failed} с ошибкой — из {results.total}
      </div>

      {ok.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <button
            className="btn btn-primary"
            disabled={busy === 'pdf'}
            onClick={() => grab('pdf')}
          >
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
                ? ` — уже был собран, накладная переиспользована (${row.numberOfSpace} мест)`
                : ` — собран сейчас, ${row.numberOfSpace} мест`
              : ` — ${row.error}`}
          </div>
        ))}
      </div>
    </div>
  );
}
