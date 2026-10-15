'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../lib/api';
import SkuLink from './SkuLink';

// Калькулятор цены: из чего складывается цена на Kaspi и что от неё остаётся.
//
// Формула одна и в обе стороны:
//   цена × (1 − комиссия − бонус) − доставка − себестоимость = прибыль
// отсюда
//   цена = (себестоимость + доставка + прибыль) / (1 − комиссия − бонус)
//
// Комиссия Kaspi - ровно 11,75% в любом диапазоне цены (замерено по 1324 операциям
// Kaspi Pay). Доставка - НЕ процент, а ступень: 4 175 / 4 813 / 6 553 / 7 481 / 9 917
// и потолок 13 919 ₸ на заказ, выше не берут даже с заказа на 264 000. Зависит от
// габаритов и веса, а не от числа мест.
//
// Бонус - это акция Kaspi на товар: покупателю начисляют процент от цены, платим его
// мы. В расчёте он ведёт себя как вторая комиссия, поэтому стоит рядом с ней, а не
// вычитается из прибыли в конце: из-за того что он берётся с ЦЕНЫ, а цена от него же
// и растёт, вычитание «в конце» занижает нужную цену.

// Ступени доставки Kaspi: замерено по выгрузке Kaspi Pay за сентябрь.
const SHIPPING_TIERS = [
  { value: 4175, label: '4 175 — мелочь: тумба 50×50×38, полка' },
  { value: 4813, label: '4 813' },
  { value: 6553, label: '6 553 — модуль 70×35×190, шкаф для документов' },
  { value: 7481, label: '7 481' },
  { value: 9917, label: '9 917 — стеллаж 80×28×202' },
  { value: 13919, label: '13 919 — потолок: больше Kaspi не берёт' },
];

const COMMISSION = 11.75;

const money = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));
const num = (v) => { const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
// Цены на Kaspi круглые: считать до тенге и ставить 91 673 никто не будет.
const roundTo = (v, step) => (step > 1 ? Math.ceil(v / step) * step : Math.round(v));

export default function PriceCalculator() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [pickedId, setPickedId] = useState(null);

  // Параметры расчёта. Себестоимость отдельно от изделия: её можно вбить руками,
  // не выбирая код вовсе, - под новую позицию, которой ещё нет в сервисе.
  const [cost, setCost] = useState('');
  const [shipping, setShipping] = useState(6553);
  const [profit, setProfit] = useState('20000');
  const [bonus, setBonus] = useState('0');
  const [commission, setCommission] = useState(String(COMMISSION));
  const [step, setStep] = useState(100);
  const [checkPrice, setCheckPrice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/api/costing/calculator');
      setProducts(data.products || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить изделия'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const picked = useMemo(() => products.find((p) => p.id === pickedId) || null, [products, pickedId]);

  const found = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? products.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q))
      : products;
    return list.slice(0, 40);
  }, [products, search]);

  const pick = (p) => {
    setPickedId(p.id);
    if (p.cost !== null) setCost(String(p.cost));
  };

  // ── расчёт ──────────────────────────────────────────────────────────────────
  const keep = 1 - num(commission) / 100 - num(bonus) / 100;
  const base = num(cost) + num(shipping) + num(profit);
  const priceRaw = keep > 0 ? base / keep : null;
  const price = priceRaw === null ? null : roundTo(priceRaw, step);

  // Обратный ход: что остаётся при уже стоящей цене
  const backOf = (p) => {
    const value = num(p);
    if (!value) return null;
    const commissionSum = value * (num(commission) / 100);
    const bonusSum = value * (num(bonus) / 100);
    const net = value - commissionSum - bonusSum - num(shipping) - num(cost);
    return { price: value, commissionSum, bonusSum, net, rate: (net / value) * 100 };
  };
  const atPrice = backOf(checkPrice);
  // Прибыль по округлённой цене чуть больше заданной - округляем вверх, и это видно
  const atOur = price === null ? null : backOf(price);

  return (
    <>
      <section className="panel rise" style={{ marginBottom: 18 }}>
        <div className="panel-head">
          <h2>Калькулятор цены</h2>
          <span className="eyebrow">цена = (себестоимость + доставка + прибыль) / (1 − комиссия − бонус)</span>
        </div>
        <div className="panel-body" style={{ display: 'grid', gap: 18 }}>

          <div className="calc-grid">
            <Field label="Себестоимость, ₸" hint={picked ? (picked.code || picked.name) : 'можно вбить руками'}>
              <input className="input" inputMode="numeric" value={cost}
                     onChange={(e) => setCost(e.target.value)} placeholder="43 000" />
            </Field>

            <Field label="Доставка Kaspi, ₸" hint="ступень, а не процент">
              <select className="input" value={shipping} onChange={(e) => setShipping(Number(e.target.value))}>
                {SHIPPING_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>

            <Field label="Прибыль с штуки, ₸" hint="сколько хотим оставить себе">
              <input className="input" inputMode="numeric" value={profit}
                     onChange={(e) => setProfit(e.target.value)} placeholder="20 000" />
            </Field>

            <Field label="Бонус на товар, %" hint="акция Kaspi: платим мы">
              <input className="input" inputMode="decimal" value={bonus}
                     onChange={(e) => setBonus(e.target.value)} placeholder="5" />
            </Field>

            <Field label="Комиссия Kaspi, %" hint="замерено 11,75% в любой цене">
              <input className="input" inputMode="decimal" value={commission}
                     onChange={(e) => setCommission(e.target.value)} />
            </Field>

            <Field label="Округлять до" hint="цены на Kaspi круглые">
              <select className="input" value={step} onChange={(e) => setStep(Number(e.target.value))}>
                <option value={1}>до тенге</option>
                <option value={10}>до 10 ₸</option>
                <option value={100}>до 100 ₸</option>
                <option value={500}>до 500 ₸</option>
                <option value={1000}>до 1 000 ₸</option>
              </select>
            </Field>
          </div>

          {keep <= 0 ? (
            <div className="alert alert-error">
              Комиссия и бонус вместе съедают всю цену — при таких процентах цены не существует.
            </div>
          ) : (
            <div className="calc-result">
              <div className="calc-price">
                <div className="kpi-label">Ставить на Kaspi</div>
                <div className="calc-price-value">{money(price)} <span>₸</span></div>
                <div className="t-dim">
                  без округления {money(priceRaw)} ₸
                  {num(bonus) > 0 && <> · бонус покупателю {money(price * num(bonus) / 100)} ₸</>}
                </div>
              </div>
              <table className="data calc-break">
                <tbody>
                  <tr><td>Цена</td><td className="num">{money(price)} ₸</td></tr>
                  <tr><td>− комиссия Kaspi {num(commission)}%</td><td className="num">−{money(atOur?.commissionSum)} ₸</td></tr>
                  {num(bonus) > 0 && (
                    <tr><td>− бонус покупателю {num(bonus)}%</td><td className="num">−{money(atOur?.bonusSum)} ₸</td></tr>
                  )}
                  <tr><td>− доставка</td><td className="num">−{money(shipping)} ₸</td></tr>
                  <tr><td>− себестоимость</td><td className="num">−{money(num(cost))} ₸</td></tr>
                  <tr className="calc-total">
                    <td>Остаётся</td>
                    <td className="num">{money(atOur?.net)} ₸ · {atOur ? atOur.rate.toFixed(1) : '—'}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="calc-check">
            <Field label="А если цена уже стоит, ₸" hint="посчитать в обратную сторону">
              <input className="input" inputMode="numeric" value={checkPrice}
                     onChange={(e) => setCheckPrice(e.target.value)} placeholder="89 000" />
            </Field>
            {atPrice && (
              <div className={`calc-verdict ${atPrice.net > 0 ? 'ok' : 'bad'}`}>
                При {money(atPrice.price)} ₸ остаётся <strong>{money(atPrice.net)} ₸</strong> с штуки
                ({atPrice.rate.toFixed(1)}%)
                {atPrice.net <= 0 && ' — продаём в минус'}
                {price !== null && atPrice.price < price && (
                  <> · это на {money(price - atPrice.price)} ₸ дешевле нужной</>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel rise">
        <div className="panel-head">
          <h2>Коды технолога</h2>
          <span className="eyebrow">{products.length}</span>
          <div style={{ flex: 1 }} />
          <input className="input" style={{ maxWidth: 260 }} value={search}
                 onChange={(e) => setSearch(e.target.value)} placeholder="Шкаф КМ или SH-4001" />
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {loading ? (
          <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Код</th>
                  <th>Изделие</th>
                  <th style={{ textAlign: 'right' }}>Себестоимость</th>
                  <th>Артикулы Kaspi и цена сейчас</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {found.map((p) => (
                  <CodeRow
                    key={p.id}
                    product={p}
                    active={p.id === pickedId}
                    shipping={shipping}
                    commission={num(commission)}
                    bonus={num(bonus)}
                    onPick={() => pick(p)}
                    onChanged={load}
                  />
                ))}
                {found.length === 0 && (
                  <tr><td colSpan={5} className="t-dim">Ничего не нашлось</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <style jsx global>{`
        .calc-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
        .calc-field { display: grid; gap: 5px; }
        .calc-field .kpi-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .7; }
        .calc-field .hint { font-size: 12px; opacity: .55; }
        .calc-result { display: grid; gap: 16px; grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.2fr); align-items: start; }
        .calc-price-value { font-size: 40px; line-height: 1.05; font-variant-numeric: tabular-nums; margin: 6px 0 4px; }
        .calc-price-value span { font-size: 20px; opacity: .6; }
        .calc-break td { padding: 5px 8px; }
        .calc-break .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .calc-total td { font-weight: 600; border-top: 2px solid var(--line-strong); }
        .calc-check { display: grid; gap: 10px; grid-template-columns: minmax(200px, 260px) 1fr; align-items: end; }
        .calc-verdict { padding: 9px 12px; border-radius: 6px; font-size: 14px; }
        .calc-verdict.ok { background: var(--alert-ok-bg); border: 1px solid var(--alert-ok-line); color: var(--alert-ok-text); }
        .calc-verdict.bad { background: var(--alert-error-bg); border: 1px solid var(--alert-error-line); color: var(--alert-error-text); }
        .calc-sku { font-size: 13px; opacity: .85; }
        @media (max-width: 720px) {
          .calc-result, .calc-check { grid-template-columns: 1fr; }
        }
      `}</style>
    </>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="calc-field">
      <span className="kpi-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

// Строка кода: себестоимость правится прямо здесь, если спецификации технолога нет.
// Рядом - артикулы Kaspi с живой ценой и тем, что от неё остаётся при текущих
// настройках калькулятора. Это и есть ответ на «а эта позиция вообще зарабатывает».
function CodeRow({ product, active, shipping, commission, bonus, onPick, onChanged }) {
  const [draft, setDraft] = useState(product.cost === null ? '' : String(product.cost));
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { setDraft(product.cost === null ? '' : String(product.cost)); }, [product.cost]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/api/costing/products/${product.id}/cost`, { cost: num(draft) });
      setEditing(false);
      await onChanged();
    } catch (e) {
      setErr(errorText(e, 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  };

  const left = (price) => {
    if (!price || product.cost === null) return null;
    return Number(price) * (1 - commission / 100 - bonus / 100) - shipping - product.cost;
  };

  return (
    <>
    <tr data-active={active || undefined}>
      <td><strong>{product.code || '—'}</strong></td>
      <td>
        {product.name}
        {err && <div className="t-dim" style={{ color: 'var(--red)' }}>{err}</div>}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {editing ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <input className="input" style={{ width: 96, textAlign: 'right' }} value={draft}
                   inputMode="numeric" autoFocus
                   onChange={(e) => setDraft(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
            <button className="btn" onClick={save} disabled={busy}>
              {busy && <span className="spinner" />}Сохранить
            </button>
          </span>
        ) : (
          <button
            className="btn btn-quiet"
            title={product.costEditable
              ? 'Нажмите, чтобы задать готовую сумму «себестоимость + работа»'
              : 'Складывается из спецификации технолога — правьте во вкладке «Изделия»'}
            disabled={!product.costEditable}
            onClick={() => setEditing(true)}
          >
            {money(product.cost)} ₸
          </button>
        )}
      </td>
      <td>
        {product.skus.length === 0 ? (
          <span className="t-dim">не привязан ни к одному артикулу</span>
        ) : (
          <div style={{ display: 'grid', gap: 2 }}>
            {product.skus.map((s) => {
              const net = left(s.price);
              return (
                <div key={`${s.store_name}-${s.sku}`} className="calc-sku">
                  {s.price ? `${money(s.price)} ₸` : 'цены нет'}
                  {net !== null && (
                    <span style={{ color: net > 0 ? 'inherit' : 'var(--red)' }}>
                      {' '}→ остаётся {money(net)} ₸
                    </span>
                  )}
                  <span className="t-dim"> · {s.store_name} · {s.name}</span>
                </div>
              );
            })}
          </div>
        )}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button className="btn btn-quiet btn-sm" onClick={() => setLinking(!linking)}>
          {linking ? 'Скрыть' : 'Связать'}
        </button>{' '}
        <button className="btn btn-sm" onClick={onPick}>В калькулятор</button>
      </td>
    </tr>
    {linking && (
      <tr>
        <td colSpan={5} style={{ background: 'var(--ink-800)' }}>
          <SkuLink product={product} skus={product.skus} onSaved={onChanged} />
        </td>
      </tr>
    )}
    </>
  );
}
