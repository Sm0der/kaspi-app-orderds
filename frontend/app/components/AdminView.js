'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../lib/api';

// Настройки: каталог товаров (категория, картинка, правило упаковки) и магазины с их
// токенами Kaspi. Раньше и то и другое правилось только руками в базе - здесь то же
// самое, но с обзором, поиском и без риска опечататься в SQL.

const money = (v) => (v === null || v === undefined ? '' : Math.round(Number(v)).toLocaleString('ru-RU'));

export default function AdminView() {
  const [tab, setTab] = useState('products');

  return (
    <div>
      <div className="chip-row" style={{ marginBottom: 16 }}>
        <button className="chip" data-active={tab === 'products'} onClick={() => setTab('products')}>Товары</button>
        <button className="chip" data-active={tab === 'stores'} onClick={() => setTab('stores')}>Магазины и токены</button>
      </div>
      {tab === 'products' ? <ProductsTab /> : <StoresTab />}
    </div>
  );
}

// ── Товары ──────────────────────────────────────────────────────────────────

function ProductsTab() {
  const [q, setQ] = useState('');
  const [missingImage, setMissingImage] = useState(false);
  const [page, setPage] = useState(1);
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const perPage = 50;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, perPage };
      if (q.trim()) params.q = q.trim();
      if (missingImage) params.missingImage = '1';
      const { data } = await api.get('/api/admin/products', { params });
      setProducts(data.products || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить каталог'));
    } finally {
      setLoading(false);
    }
  }, [q, missingImage, page]);

  useEffect(() => { load(); }, [load]);

  // Поиск и фильтр меняют выборку - страницу сбрасываем на первую, иначе пятая
  // страница вчерашнего поиска может оказаться за пределами нового результата
  useEffect(() => { setPage(1); }, [q, missingImage]);

  const save = async (id, patch) => {
    const { data } = await api.put(`/api/admin/products/${id}`, patch);
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, ...data.product } : p)));
  };

  const pages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="panel">
      <div className="panel-head"><h2>Каталог товаров</h2></div>
      <div className="panel-body">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Поиск по названию или артикулу"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5 }}>
            <input type="checkbox" checked={missingImage} onChange={(e) => setMissingImage(e.target.checked)} />
            Без картинки
          </label>
          <span className="t-dim" style={{ marginLeft: 'auto', fontSize: 13 }}>{total} товаров</span>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 56 }}></th>
                <th>Товар</th>
                <th>Магазин</th>
                <th>Категория</th>
                <th className="ta-r">Цена</th>
                <th className="ta-r">Мест на 1 шт</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <ProductRow key={p.id} product={p} onSave={(patch) => save(p.id, patch)} />
              ))}
              {!loading && products.length === 0 && (
                <tr><td colSpan={6} className="t-dim" style={{ padding: 16 }}>Ничего не найдено</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
            <button className="btn btn-quiet" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Назад</button>
            <span className="t-dim" style={{ alignSelf: 'center', fontSize: 13 }}>{page} из {pages}</span>
            <button className="btn btn-quiet" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Вперёд →</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProductRow({ product, onSave }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const commit = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>
        {product.image_url
          ? <img src={product.image_url} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }} />
          : <div className="t-faint" style={{ width: 40, height: 40, borderRadius: 6, border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>нет</div>}
      </td>
      <td>
        <div>{product.name}</div>
        <div className="t-faint num" style={{ fontSize: 11.5 }}>
          {product.sku}{product.cost_code && <> · <span className="t-dim">{product.cost_code}</span></>}
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 11.5, marginTop: 3 }}>{error}</div>}
      </td>
      <td className="t-dim">{product.store_name}</td>
      <td>
        <EditableText value={product.category || ''} disabled={busy} placeholder="—" onSave={(v) => commit({ category: v })} />
      </td>
      <td className="ta-r">
        <EditableText
          value={product.price != null ? String(product.price) : ''}
          disabled={busy}
          placeholder="—"
          numeric
          onSave={(v) => commit({ price: v === '' ? null : Number(v) })}
        />
      </td>
      <td className="ta-r">
        <EditableText
          value={String(product.spaces_per_unit ?? 1)}
          disabled={busy}
          numeric
          onSave={(v) => { if (Number(v) > 0) commit({ spaces_per_unit: Number(v) }); }}
        />
      </td>
    </tr>
  );
}

// Клик по значению превращает его в поле ввода - обзор каталога остаётся плотным, а
// правка не открывает отдельную форму на 80 товарах разом.
function EditableText({ value, onSave, disabled, numeric, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => { setDraft(value); }, [value]);

  if (!editing) {
    return (
      <button
        className="btn-link"
        disabled={disabled}
        onClick={() => setEditing(true)}
        style={{ font: 'inherit', color: value ? 'inherit' : 'var(--text-faint)' }}
      >
        {value ? (numeric ? money(value) : value) : (placeholder || 'указать')}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft.trim());
  };

  return (
    <input
      autoFocus
      className={`input ${numeric ? 'num' : ''}`}
      style={{ width: numeric ? 90 : 140, padding: '5px 8px', fontSize: 13, textAlign: numeric ? 'right' : 'left' }}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
    />
  );
}

// ── Магазины ────────────────────────────────────────────────────────────────

function StoresTab() {
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/api/admin/stores');
      setStores(data.stores || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить магазины'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Магазины</h2>
        <button className="btn btn-quiet" style={{ marginLeft: 'auto' }} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Отмена' : '+ Магазин'}
        </button>
      </div>
      <div className="panel-body">
        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
        {adding && (
          <AddStore
            onDone={() => { setAdding(false); load(); }}
            onCancel={() => setAdding(false)}
          />
        )}
        {loading ? (
          <p className="t-dim">Загрузка…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stores.map((store) => (
              <StoreCard key={store.id} store={store} onChanged={load} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StoreCard({ store, onChanged }) {
  const [editingToken, setEditingToken] = useState(false);
  const [name, setName] = useState(store.name);
  const [merchantUid, setMerchantUid] = useState(store.kaspi_merchant_uid || '');
  const [newToken, setNewToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const save = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/admin/stores/${store.id}`, patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ cursor: 'default' }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field" style={{ minWidth: 200 }}>
          <label>Название</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== store.name && save({ name: name.trim() })} disabled={busy} />
        </div>
        <div className="field" style={{ minWidth: 160 }}>
          <label>Merchant UID</label>
          <input
            className="input"
            value={merchantUid}
            onChange={(e) => setMerchantUid(e.target.value)}
            onBlur={() => merchantUid !== (store.kaspi_merchant_uid || '') && save({ merchantUid })}
            disabled={busy}
          />
        </div>
        <div className="field" style={{ minWidth: 220, flex: 1 }}>
          <label>API-токен Kaspi</label>
          {editingToken ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="Вставьте новый токен из кабинета Kaspi"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                disabled={busy}
              />
              <button
                className="btn"
                disabled={busy || !newToken.trim()}
                onClick={async () => { await save({ apiToken: newToken.trim() }); setNewToken(''); setEditingToken(false); }}
              >
                Сохранить
              </button>
              <button className="btn btn-quiet" onClick={() => { setEditingToken(false); setNewToken(''); }}>Отмена</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="num t-dim">••••{store.token_tail}</span>
              <button className="btn-link" onClick={() => setEditingToken(true)}>сменить</button>
            </div>
          )}
        </div>
        <div className="t-faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {store.products_count} товаров · {store.orders_count} заказов
        </div>
        {saved && <span className="t-dim" style={{ fontSize: 12 }}>сохранено ✓</span>}
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function AddStore({ onDone, onCancel }) {
  const [name, setName] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [merchantUid, setMerchantUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/stores', { name: name.trim(), apiToken: apiToken.trim(), merchantUid: merchantUid.trim() || undefined });
      onDone();
    } catch (err) {
      setError(errorText(err, 'Не удалось создать магазин'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14, cursor: 'default' }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field" style={{ minWidth: 200 }}>
          <label>Название</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>
        <div className="field" style={{ minWidth: 160 }}>
          <label>Merchant UID</label>
          <input className="input" value={merchantUid} onChange={(e) => setMerchantUid(e.target.value)} disabled={busy} />
        </div>
        <div className="field" style={{ minWidth: 240, flex: 1 }}>
          <label>API-токен Kaspi</label>
          <input className="input" value={apiToken} onChange={(e) => setApiToken(e.target.value)} disabled={busy} />
        </div>
        <button className="btn" disabled={busy || !name.trim() || !apiToken.trim()} onClick={submit}>
          {busy && <span className="spinner" />} Создать
        </button>
        <button className="btn btn-quiet" onClick={onCancel} disabled={busy}>Отмена</button>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
