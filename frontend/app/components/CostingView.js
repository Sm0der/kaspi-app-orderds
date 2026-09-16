'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../lib/api';

// Себестоимость изделий: перенос таблицы главного технолога. Слева список изделий с
// посчитанной себестоимостью, справа - карточка со спецификацией, тарифами, присадкой и
// привязкой к артикулам Kaspi. Отдельная вкладка - справочник позиций: в ней видно, где
// цена разошлась между изделиями, и её можно поднять сразу везде.

const CATEGORIES = {
  SH: 'Шкафы', KM: 'Комоды', ST: 'Столы', TB: 'Тумбы', SL: 'Стеллажи', HW: 'Прихожие'
};

const money = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));
const qty = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',').replace(/,?0+$/, '');
};

export default function CostingView({ isAdmin }) {
  const [tab, setTab] = useState('products');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/api/costing/products');
      setProducts(data.products || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить изделия'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runImport = async () => {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const { data } = await api.post('/api/costing/import');
      setNotice({
        text: `Перенесено изделий: ${data.products} (с кодом — ${data.withCode}), строк спецификаций: ${data.lines}, позиций справочника: ${data.items}`,
        needCode: data.needCode || []
      });
      await load();
    } catch (err) {
      setError(errorText(err, 'Импорт не удался'));
    } finally {
      setImporting(false);
    }
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p =>
      (p.name || '').toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q));
  }, [products, search]);

  const byCategory = useMemo(() => {
    const map = new Map();
    for (const p of visible) {
      const key = p.category || '—';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return [...map.entries()];
  }, [visible]);

  return (
    <>
      <div className="filters rise">
        <div className="field" style={{ minWidth: 240 }}>
          <label>Поиск изделия</label>
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Шкаф КМ или SH-4001"
          />
        </div>
        <div className="divider" />
        <div className="segmented">
          <button data-active={tab === 'products'} onClick={() => setTab('products')}>Изделия</button>
          <button data-active={tab === 'items'} onClick={() => setTab('items')}>Справочник позиций</button>
        </div>
        <div style={{ flex: 1 }} />
        {isAdmin && (
          <button className="btn" onClick={runImport} disabled={importing}
                  title="Перечитать Google Таблицу технолога и обновить данные">
            {importing && <span className="spinner" />} Обновить из Google Таблицы
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && (
        <div className="alert alert-ok">
          {notice.text}
          {notice.needCode?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Без кода — {notice.needCode.length}, проставьте вручную:</strong>
              <div style={{ display: 'grid', gap: 2, marginTop: 4, fontSize: 13 }}>
                {notice.needCode.map((p, i) => (
                  <div key={i}>{p.name} — <span className="t-dim">{p.reason}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'products' && products.length > 0 && <BulkRates onDone={load} />}

      {tab === 'items' ? (
        <ItemsCatalog onChanged={load} />
      ) : loading ? (
        <section className="panel rise">
          <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}
          </div>
        </section>
      ) : products.length === 0 ? (
        <section className="panel rise">
          <div className="empty">
            Изделий пока нет. Нажмите «Обновить из Google Таблицы» — данные технолога перенесутся сюда.
          </div>
        </section>
      ) : (
        byCategory.map(([category, list]) => (
          <section className="panel rise" key={category} style={{ marginBottom: 18 }}>
            <div className="panel-head">
              <h2>{CATEGORIES[category] || 'Без категории'}</h2>
              <span className="eyebrow">{list.length}</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Код</th>
                    <th>Изделие</th>
                    <th style={{ textAlign: 'right' }}>Материалы</th>
                    <th style={{ textAlign: 'right' }}>Работы</th>
                    <th style={{ textAlign: 'right' }}>Себестоимость</th>
                    <th style={{ textAlign: 'right' }}>Опт</th>
                    <th style={{ textAlign: 'right' }}>Kaspi</th>
                    <th>Артикулы</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <ProductRow
                      key={p.id}
                      product={p}
                      open={openId === p.id}
                      onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                      onChanged={load}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </>
  );
}

// Тарифы работ живут у каждого изделия, но меняются обычно сразу для всех - в таблице
// они и разошлись из-за того, что править их приходилось в каждом листе.
const RATES = [
  { field: 'rate_saw', label: 'Распил, за кв.м' },
  { field: 'rate_edge', label: 'Кромка, за п.м' },
  { field: 'rate_pack', label: 'Упаковка, за коробку' },
  { field: 'rate_ship', label: 'Отправка Kaspi, за коробку' },
  { field: 'rate_overhead', label: 'Накладные, за коробку' }
];

function BulkRates({ onDone }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState('rate_edge');
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    const price = Number(String(value).replace(',', '.'));
    if (!(price >= 0)) return;
    setBusy(true);
    try {
      const { data } = await api.put('/api/costing/rates', { field, value: price });
      setResult(`Готово: тариф изменён у ${data.updated} изделий`);
      setValue('');
      onDone();
    } catch (err) {
      setResult(errorText(err, 'Не удалось изменить тариф'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-quiet btn-sm" style={{ marginBottom: 14 }} onClick={() => setOpen(true)}>
        Изменить тариф работ во всех изделиях
      </button>
    );
  }

  return (
    <section className="panel rise" style={{ marginBottom: 18 }}>
      <div className="panel-body" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ minWidth: 220 }}>
          <label>Тариф</label>
          <select className="select" value={field} onChange={(e) => setField(e.target.value)}>
            {RATES.map(r => <option key={r.field} value={r.field}>{r.label}</option>)}
          </select>
        </div>
        <div className="field" style={{ width: 130 }}>
          <label>Новое значение</label>
          <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="20" />
        </div>
        <button className="btn btn-primary" onClick={apply} disabled={busy || !value}>
          {busy && <span className="spinner" />} Применить ко всем
        </button>
        <button className="btn btn-quiet" onClick={() => setOpen(false)}>Скрыть</button>
        {result && <span className="t-dim" style={{ fontSize: 13 }}>{result}</span>}
      </div>
    </section>
  );
}

function ProductRow({ product, open, onToggle, onChanged }) {
  const t = product.totals || {};
  return (
    <>
      <tr className="order-row" onClick={onToggle}>
        <td className="order-code">{product.code || <span className="t-faint">нет кода</span>}</td>
        <td>
          {product.name}
          {product.doors !== null && product.doors !== undefined && (
            <div className="eyebrow" style={{ marginTop: 3, textTransform: 'none', letterSpacing: 0 }}>
              {product.doors} дв · {product.drawers} ящ · {t.boxes} кор
            </div>
          )}
        </td>
        <td className="num t-dim" style={{ textAlign: 'right' }}>{money(t.materials)}</td>
        <td className="num t-dim" style={{ textAlign: 'right' }}>{money(t.works)}</td>
        <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{money(t.cost)}</td>
        <td className="num t-dim" style={{ textAlign: 'right' }}>{money(t.wholesale)}</td>
        <td className="num" style={{ textAlign: 'right', color: 'var(--brass-strong)' }}>{money(t.kaspiPrice)}</td>
        <td>
          {product.linked_skus > 0
            ? <span className="badge" style={{ borderColor: 'var(--sage)', color: 'var(--sage)' }}>{product.linked_skus}</span>
            : <span className="t-faint">не связан</span>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ paddingTop: 0 }}>
            <ProductCard productId={product.id} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function ProductCard({ productId, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/costing/products/${productId}`);
      setData(data);
    } catch (err) {
      setError(errorText(err, 'Не удалось открыть изделие'));
    }
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <div className="skeleton" style={{ height: 120, margin: '10px 0' }} />;

  const { product, lines, drilling, skus, totals } = data;

  const saveLine = async (line, patch) => {
    setBusy(true);
    try {
      await api.put(`/api/costing/lines/${line.id}`, patch);
      await load();
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить строку'));
    } finally {
      setBusy(false);
    }
  };

  const saveProduct = async (patch) => {
    setBusy(true);
    try {
      await api.put(`/api/costing/products/${product.id}`, patch);
      await load();
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить изделие'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 16, padding: '6px 0 14px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 16 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Спецификация</div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Позиция</th>
                  <th style={{ textAlign: 'right' }}>Кол-во</th>
                  <th style={{ textAlign: 'right' }}>Цена</th>
                  <th style={{ textAlign: 'right' }}>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      {line.name}
                      {line.counts_as === 'saw_area' && <span className="t-faint"> · распил</span>}
                      {line.counts_as === 'edge_length' && <span className="t-faint"> · кромка</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <CellInput value={line.quantity} disabled={busy}
                                 onSave={(v) => saveLine(line, { quantity: v })} suffix={line.unit} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <CellInput value={line.price} disabled={busy}
                                 onSave={(v) => saveLine(line, { price: v })} />
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {money(Number(line.quantity) * Number(line.price))}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} style={{ fontWeight: 600 }}>Материалы и фурнитура</td>
                  <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{money(totals.materials)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Работы</div>
            <table className="data">
              <tbody>
                <Row label={`Распил · ${qty(totals.sawArea)} кв.м`} value={totals.saw}
                     rate={product.rate_saw} onRate={(v) => saveProduct({ rate_saw: v })} />
                <Row label={`Кромка · ${qty(totals.edgeLength)} м`} value={totals.edge}
                     rate={product.rate_edge} onRate={(v) => saveProduct({ rate_edge: v })} />
                <Row label="Присадка" value={totals.drilling}
                     rate={product.drilling_cost} onRate={(v) => saveProduct({ drilling_cost: v })} />
                <Row label={`Упаковка · ${totals.boxes} кор`} value={totals.packing}
                     rate={product.rate_pack} onRate={(v) => saveProduct({ rate_pack: v })} />
                <Row label={`Отправка Kaspi · ${totals.boxes} кор`} value={totals.shipping}
                     rate={product.rate_ship} onRate={(v) => saveProduct({ rate_ship: v })} />
                <Row label={`Накладные · ${totals.boxes} кор`} value={totals.overhead}
                     rate={product.rate_overhead} onRate={(v) => saveProduct({ rate_overhead: v })} />
                <tr>
                  <td style={{ fontWeight: 600 }}>Работы всего</td>
                  <td />
                  <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{money(totals.works)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="alert alert-note" style={{ margin: 0 }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <div>Себестоимость: <strong className="num">{money(totals.cost)} ₸</strong></div>
              <div className="t-dim">Маржа {Math.round(Number(product.margin_rate) * 100)}% от базы (себестоимость ÷ {Number(product.margin_divisor)}): {money(totals.margin)} ₸</div>
              <div>Опт: <strong className="num">{money(totals.wholesale)} ₸</strong> · Kaspi: <strong className="num" style={{ color: 'var(--brass-strong)' }}>{money(totals.kaspiPrice)} ₸</strong></div>
            </div>
          </div>

          {drilling && (
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Нормы присадки</div>
              <div className="t-dim" style={{ fontSize: 13, display: 'grid', gap: 3 }}>
                <div>Конфирматы {drilling.confirmats || 0} · эксцентрики {drilling.eccentrics || 0} · шурупы {drilling.screws || 0}</div>
                <div>Ручки {drilling.handles || 0} · навесы {drilling.hinges || 0} · полкодержатели {drilling.shelf_holders || 0}</div>
                <div>Деталей {drilling.parts || 0} · {qty(drilling.area)} кв.м · {Math.round((drilling.seconds || 0) / 60)} мин</div>
              </div>
            </div>
          )}

          <SkuLink product={product} skus={skus} onSaved={() => { load(); onChanged(); }} />
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, rate, onRate }) {
  return (
    <tr>
      <td>{label}</td>
      <td style={{ textAlign: 'right', width: 110 }}>
        <CellInput value={rate} onSave={onRate} />
      </td>
      <td className="num" style={{ textAlign: 'right', width: 90 }}>{money(value)}</td>
    </tr>
  );
}

// Правка прямо в ячейке: технолог меняет число и уходит из поля - сохраняется.
// Отдельная кнопка «сохранить» на полусотне строк превращала бы правку цены в мучение.
function CellInput({ value, onSave, disabled, suffix }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);

  const commit = () => {
    const parsed = Number(String(draft).replace(',', '.'));
    if (Number.isNaN(parsed) || parsed === Number(value)) { setDraft(String(value ?? '')); return; }
    onSave(parsed);
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        className="input mono"
        style={{ width: 82, padding: '5px 8px', textAlign: 'right', fontSize: 13 }}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {suffix && <span className="t-faint" style={{ fontSize: 11 }}>{suffix}</span>}
    </span>
  );
}

function SkuLink({ product, skus, onSaved }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState([]);
  const [chosen, setChosen] = useState(skus.map(s => s.sku));
  const [busy, setBusy] = useState(false);

  useEffect(() => { setChosen(skus.map(s => s.sku)); }, [skus]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.get('/api/costing/unlinked', { params: { q: query || undefined } });
        setFound(data.products || []);
      } catch { setFound([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open]);

  const save = async (list) => {
    setBusy(true);
    try {
      await api.put(`/api/costing/products/${product.id}/skus`, { skus: list });
      setChosen(list);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Товары Kaspi</div>
      {skus.length === 0 && !open && (
        <p className="panel-note" style={{ marginBottom: 8 }}>
          Пока не связано. Свяжите — и код {product.code || 'изделия'} попадёт на этикетку коробки,
          а себестоимость будет видна по заказам.
        </p>
      )}
      <div style={{ display: 'grid', gap: 5, fontSize: 13 }}>
        {skus.map((s) => (
          <div key={s.sku} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="mono t-dim">{s.sku}</span>
            <span style={{ flex: 1 }}>{s.name}</span>
            <button className="btn btn-quiet btn-sm" disabled={busy}
                    onClick={() => save(chosen.filter(x => x !== s.sku))}>убрать</button>
          </div>
        ))}
      </div>
      <button className="btn btn-quiet btn-sm" style={{ marginTop: 8 }} onClick={() => setOpen(!open)}>
        {open ? 'Скрыть поиск' : 'Связать товар Kaspi'}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)}
                 placeholder="шкаф комфорт" />
          <div style={{ display: 'grid', gap: 4, marginTop: 8, maxHeight: 200, overflowY: 'auto', fontSize: 13 }}>
            {found.map((p) => (
              <button key={p.store_id + p.sku} className="btn btn-quiet btn-sm"
                      style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                      disabled={busy}
                      onClick={() => save([...chosen, p.sku])}>
                <span className="mono t-dim">{p.sku}</span> {p.name}
              </button>
            ))}
            {found.length === 0 && <span className="t-faint">Ничего не нашлось</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemsCatalog({ onChanged }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/api/costing/items');
      setItems(data.items || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить справочник'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setEverywhere = async (item, price) => {
    setNotice(null);
    setError(null);
    try {
      const { data } = await api.put(`/api/costing/items/${item.id}/price`, { price });
      setNotice(`«${item.name}» — цена ${Math.round(price).toLocaleString('ru-RU')} ₸ проставлена в ${data.updated} изделиях`);
      await load();
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Не удалось обновить цену'));
    }
  };

  if (loading) return <div className="skeleton" style={{ height: 200 }} />;

  return (
    <section className="panel rise">
      <div className="panel-head">
        <h2>Справочник позиций</h2>
        <span className="eyebrow">{items.length}</span>
      </div>
      <div className="panel-body" style={{ paddingBottom: 0 }}>
        <p className="panel-note">
          Цена хранится в каждом изделии отдельно — как в таблице. Здесь видно, где она разошлась,
          и можно поставить одну цену сразу во всех изделиях.
        </p>
        {notice && <div className="alert alert-ok" style={{ marginTop: 12 }}>{notice}</div>}
        {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Позиция</th>
              <th>Ед.</th>
              <th style={{ textAlign: 'right' }}>В изделиях</th>
              <th style={{ textAlign: 'right' }}>Цена</th>
              <th>Поставить везде</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td className="t-dim">{item.unit}</td>
                <td className="num t-dim" style={{ textAlign: 'right' }}>{item.used_in}</td>
                <td className="num" style={{ textAlign: 'right' }}>
                  {item.price_variants > 1 ? (
                    <span style={{ color: 'var(--amber)' }} title="Цена различается между изделиями">
                      {money(item.min_price)} — {money(item.max_price)}
                    </span>
                  ) : money(item.max_price ?? item.default_price)}
                </td>
                <td>
                  <PriceSetter item={item} onSet={(price) => setEverywhere(item, price)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PriceSetter({ item, onSet }) {
  const [value, setValue] = useState('');
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <input
        className="input mono"
        style={{ width: 90, padding: '5px 8px', fontSize: 13 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={item.max_price ? String(Math.round(item.max_price)) : '0'}
      />
      <button
        className="btn btn-sm"
        disabled={!value}
        onClick={() => {
          const price = Number(String(value).replace(',', '.'));
          if (price >= 0) { onSet(price); setValue(''); }
        }}
      >
        Применить
      </button>
    </span>
  );
}
