'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Привязка артикулов Kaspi к коду. Экспортируется: тем же окном пользуется
// калькулятор цены — там связывать удобнее, видно цену и что от неё остаётся.
export default function SkuLink({ product, skus, onSaved }) {
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
