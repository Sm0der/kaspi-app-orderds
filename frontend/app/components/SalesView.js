'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../lib/api';

// Продажи в разрезе товара: что берут, в какой категории, сколько на этом остаётся и
// на каком месте мы стоим на общей карточке Kaspi.
//
// Почему отдельно от «Обзора»: там деньги и логистика по заказу целиком, здесь - по
// позиции заказа. Это разные проходы по базе и разные вопросы, и складывать их в один
// экран значило бы заставлять ждать оба набора цифр ради одного.
//
// Место на карточке приходит не из API заказов: его там нет вовсе. Публичный каталог
// Kaspi блокирует адреса дата-центров, поэтому места собирает скрипт с обычного
// компьютера (server/scripts/fetch-card-ranks.js), а экран показывает последний снимок
// и честно пишет, когда он сделан.

const money = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));
const pct = (v) => (v === null || v === undefined ? '—' : String(v).replace('.', ',') + '%');

const plural = (n, one, few, many) => {
  const h = n % 100;
  const t = n % 10;
  if (h >= 11 && h <= 14) return many;
  if (t === 1) return one;
  if (t >= 2 && t <= 4) return few;
  return many;
};

const dateLabel = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
};

// Рост и падение подписываем знаком и цветом. null - показателя в прошлом периоде
// не было вовсе: это «появилось», а не «рост на бесконечность».
function Change({ value, isNew, byCard }) {
  if (value === null || value === undefined) {
    return <span className="t-faint">{isNew ? 'новое' : '—'}</span>;
  }
  const up = value > 0;
  return (
    <span
      className="trend"
      data-dir={up ? 'up' : value < 0 ? 'down' : 'flat'}
      title={byCard ? 'позиция переехала между нашими магазинами — сравниваем по карточке Kaspi целиком' : undefined}
    >
      {up ? '+' : ''}{String(value).replace('.', ',')}%
      {byCard && <span className="t-faint" style={{ fontWeight: 400 }}> ↔</span>}
    </span>
  );
}

// Место на карточке - главная цифра этого экрана, поэтому не просто число, а значок
// с понятной раскраской: первые три места видно покупателю сразу, дальше надо
// разворачивать список продавцов, а «нас нет» означает, что товар не показывают вообще.
function Place({ card }) {
  if (!card) return <span className="t-faint" title="товар ещё не проверяли">—</span>;
  if (card.place === null) {
    return (
      <span className="place place-out" title={`${card.offersTotal} чужих предложений на карточке`}>
        нас нет
      </span>
    );
  }
  const tone = card.place <= 3 ? 'top' : card.place <= 10 ? 'mid' : 'low';
  return (
    <span
      className="place"
      data-tone={tone}
      title={
        card.gap === null
          ? 'других продавцов на карточке нет'
          : card.gap > 0
            ? `дешевле всех ${money(card.bestPrice)} ₸ — мы дороже на ${money(card.gap)} ₸`
            : 'мы самые дешёвые на карточке'
      }
    >
      {card.place} <span className="place-of">из {card.offersTotal}</span>
    </span>
  );
}

// Доля карточки. Kaspi считает её на магазин, а мы на одной карточке стоим дважды -
// поэтому показываем общую, а долю этого магазина уводим в подпись: иначе бестселлер,
// поделённый между нашими же магазинами, выглядит как провал в обоих.
function Share({ traffic }) {
  if (!traffic || traffic.cardShare === null) return <span className="t-faint">—</span>;
  const our = traffic.ourShare === null ? traffic.cardShare : traffic.ourShare;
  const split = Math.abs(our - traffic.cardShare) > 0.01;
  return (
    <>
      <span data-loss={our < 20 && traffic.clicks >= 20000 || undefined}>{pct(our)}</span>
      {split && (
        <div className="t-faint" style={{ fontSize: 12 }} title="доля этого магазина; остальное — второй наш магазин">
          этот {pct(traffic.cardShare)}
        </div>
      )}
    </>
  );
}

// Загрузка обзорного отчёта из кабинета Kaspi. Клики и доля карточки есть только там:
// API заказов их не отдаёт, а публичный каталог блокирует наш сервер, так что иначе
// не узнать, товар не берут потому что он не нужен - или потому что покупают не у нас.
function Uploads({ stores, uploads, busy, onFile, period }) {
  const [store, setStore] = useState('');

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-body">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div>
            <b>Отчёт по аналитике Kaspi</b>
            <div className="t-dim" style={{ fontSize: 13, marginTop: 2 }}>
              {period
                ? <>Просмотры и доля карточки — за {dateLabel(period.from)} — {dateLabel(period.to)}.</>
                : <>Кабинет Kaspi → Аналитика → Обзорный отчёт. Пока не загружен: колонки «Смотрели» и «Доля карточки» пустые.</>}
            </div>
          </div>
          <div className="topbar-spacer" style={{ flex: 1 }} />
          <select className="select" value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">Выберите магазин…</option>
            {stores.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
          </select>
          <label
            className="btn btn-primary"
            style={{ cursor: !store || busy ? 'not-allowed' : 'pointer', opacity: !store || busy ? 0.55 : 1 }}
            title={store ? 'Файл .xlsx или .xlsm из кабинета' : 'Сначала выберите, чей это отчёт'}
          >
            {busy && <span className="spinner" />} Загрузить отчёт
            <input
              type="file"
              accept=".xlsx,.xlsm,.xls"
              style={{ display: 'none' }}
              disabled={!store || busy}
              onChange={(e) => { onFile(e.target.files[0], Number(store)); e.target.value = ''; }}
            />
          </label>
        </div>

        {uploads.length > 0 && (
          <p className="t-dim" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
            Загружено:{' '}
            {uploads.map((u, i) => (
              <span key={`${u.store_id}:${u.period_to}`}>
                {i > 0 && ' · '}
                <b>{u.store_name}</b> {dateLabel(u.period_from)} — {dateLabel(u.period_to)},{' '}
                {u.cards} карточек, {Number(u.clicks).toLocaleString('ru-RU')} просмотров
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

const SORTS = [
  ['revenue', 'По выручке'],
  ['qty', 'По штукам'],
  ['profit', 'По прибыли'],
  ['margin', 'По наценке'],
  ['cancel', 'По отказам'],
  ['place', 'По месту на карточке'],
  ['clicks', 'По просмотрам'],
  ['conversion', 'По конверсии'],
  ['share', 'По доле карточки'],
  ['quiet', 'По тишине'],
];

export default function SalesView({ range, storeId, stores = [] }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('revenue');
  const [category, setCategory] = useState(null);
  const [search, setSearch] = useState('');
  const [uploads, setUploads] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { from: range.from, to: range.to };
      if (storeId) params.store = storeId;
      const { data: body } = await api.get('/api/analytics/sales', { params });
      setData(body);
    } catch (err) {
      setError(errorText(err, 'Не удалось собрать продажи'));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, storeId]);

  useEffect(() => { load(); }, [load]);

  const loadUploads = useCallback(async () => {
    try {
      const { data } = await api.get('/api/analytics/card-stats');
      setUploads(data.data || []);
    } catch {
      setUploads([]);
    }
  }, []);

  useEffect(() => { loadUploads(); }, [loadUploads]);

  // Товары, разложенные по категориям: раскрытая категория показывает свои позиции
  // прямо под собой. Раньше клик только фильтровал таблицу в самом низу страницы -
  // ответ был, но до него надо было доскроллить и догадаться, что он там появился.
  const byCategory = useMemo(() => {
    const map = new Map();
    if (!data) return map;
    for (const p of data.products) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category).push(p);
    }
    for (const list of map.values()) list.sort((a, b) => b.revenue - a.revenue);
    return map;
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    const list = data.products.filter(
      (p) =>
        (!category || p.category === category) &&
        (!needle || p.name.toLowerCase().includes(needle) || p.sku.includes(needle))
    );

    // Прочерк - это «неизвестно», и в сортировке он должен лежать в конце, а не
    // выдавать себя за ноль: иначе товары без себестоимости возглавят список худших.
    const last = Number.NEGATIVE_INFINITY;
    const by = {
      revenue: (p) => p.revenue,
      qty: (p) => p.qty,
      profit: (p) => (p.profit === null ? last : p.profit),
      margin: (p) => (p.margin === null ? last : p.margin),
      cancel: (p) => p.cancelShare,
      place: (p) => (!p.card ? last : p.card.place === null ? 1e6 : -p.card.place),
      clicks: (p) => (p.traffic ? p.traffic.clicks : last),
      // Худшая конверсия вперёд, и только там, где трафик вообще был: три клика
      // и ноль продаж - это не провал, это отсутствие данных.
      conversion: (p) => (p.traffic && p.traffic.clicks >= 1000 ? -p.traffic.conversion : last),
      share: (p) => (p.traffic && p.traffic.ourShare !== null ? -p.traffic.ourShare : last),
      quiet: (p) => (p.daysSinceSale === null ? last : p.daysSinceSale),
    }[sort];

    return [...list].sort((a, b) => by(b) - by(a));
  }, [data, sort, category, search]);

  // Отчёт разбираем в браузере: xlsx тут уже есть ради «Денег», серверу лишняя
  // зависимость ни к чему. Магазин спрашиваем отдельно - внутри файла его нет,
  // он только в имени, а имя при пересылке теряется.
  const onFile = async (file, store) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets['Товары'] || wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 'A', raw: true, defval: null });

      // Шапка отчёта - пары «Параметр / Значение» до таблицы, период лежит там
      const meta = {};
      for (const r of grid) if (r.A && r.B && !r.C) meta[String(r.A).trim()] = String(r.B).trim();
      const span = String(meta['Период'] || '').match(/^(\d{2})\.(\d{2})\.(\d{4})\D+(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!span) throw new Error('Это не похоже на обзорный отчёт Kaspi: не нашёл строку «Период»');
      const from = `${span[3]}-${span[2]}-${span[1]}`;
      const to = `${span[6]}-${span[5]}-${span[4]}`;

      const head = grid.findIndex((r) => String(r.A || '').trim() === 'Товар');
      if (head < 0) throw new Error('В отчёте нет таблицы товаров');

      const rows = [];
      for (const r of grid.slice(head + 1)) {
        const cardId = String(r.A || '').trim();
        if (!cardId) continue;
        rows.push({
          cardId,
          name: r.B,
          category: r.C,
          // «Нет в наличии» вместо цены означает, что предложения на карточке нет
          price: r.D === 'Нет в наличии' ? null : Number(r.D),
          inStock: r.D !== 'Нет в наличии',
          sold: Number(r.E) || 0,
          revenue: Number(r.F) || 0,
          clicks: Number(r.G) || 0,
          share: r.H === null || r.H === undefined ? null : Number(r.H),
        });
      }
      if (rows.length === 0) throw new Error('В отчёте не нашлось ни одного товара');

      const { data } = await api.post('/api/analytics/card-stats', { storeId: store, from, to, rows });
      setNotice(`Загружено карточек: ${data.saved} за ${dateLabel(data.from)} — ${dateLabel(data.to)}`);
      await loadUploads();
      await load();
    } catch (err) {
      setError(err.message && !err.response ? err.message : errorText(err, 'Не удалось загрузить отчёт'));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <div className="panel"><div className="panel-body">
        <div className="alert alert-error">{error}</div>
        <button className="btn" onClick={load} style={{ marginTop: 12 }}>Повторить</button>
      </div></div>
    );
  }

  if (!data) return <div className="panel"><div className="panel-body t-dim">Считаем продажи…</div></div>;

  const { categories, drop } = data;
  const shown = rows.reduce((sum, p) => sum + p.revenue, 0);
  const noCard = data.products.filter((p) => !p.card).length;

  return (
    <div className={loading ? 'is-reloading' : undefined}>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert">{notice}</div>}

      <Uploads
        stores={stores}
        uploads={uploads}
        busy={busy}
        onFile={onFile}
        period={data.trafficPeriod}
      />

      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi">
          <div className="kpi-value kpi-money num">{money(data.revenue)} ₸</div>
          <div className="kpi-label">Продано за период</div>
        </div>
        <div className="kpi">
          <div className="kpi-value num">{data.products.length}</div>
          <div className="kpi-label">Позиций продавалось</div>
        </div>
        <div className="kpi">
          <div className="kpi-value num">{categories.length}</div>
          <div className="kpi-label">
            Категорий
            {categories[0] && <span className="t-dim"> · {categories[0].share}% в одной</span>}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-value num">{drop.length}</div>
          <div className="kpi-label">Стоит пересмотреть</div>
        </div>
      </div>

      <Panel
        title="Категории"
        note={`Нажмите категорию — раскроются её товары, а таблица «Все позиции» внизу
               отфильтруется по ней же. Категорию называет сам Kaspi в составе заказа: это та же
               категория, по которой товар ищет покупатель. Сравнение с предыдущими
               ${data.range.days} ${plural(data.range.days, 'днём', 'днями', 'днями')}
               (${dateLabel(data.previous.from)} — ${dateLabel(data.previous.to)}).`}
      >
        <table className="data">
          <thead>
            <tr>
              <th>Категория</th>
              <th className="ta-r">Выручка</th>
              <th className="ta-r">Доля</th>
              <th className="ta-r">Штук</th>
              <th className="ta-r">Позиций</th>
              <th className="ta-r">Средняя цена</th>
              <th className="ta-r">Отказов</th>
              <th className="ta-r">К прошлому</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <CategoryRow
                key={c.category}
                category={c}
                products={byCategory.get(c.category) || []}
                open={category === c.category}
                onToggle={() => setCategory(category === c.category ? null : c.category)}
              />
            ))}
          </tbody>
        </table>
      </Panel>

      {drop.length > 0 && (
        <Panel
          title="Стоит пересмотреть"
          note={`Не приговор, а повод посмотреть: у каждой строки написано, чем она сюда попала.
                 Решение за вами — сервис ничего не снимает и не меняет цены.${
                   data.trafficPeriod
                     ? ` Продажи здесь за выбранный период, а просмотры и доля карточки — за ${dateLabel(data.trafficPeriod.from)} — ${dateLabel(data.trafficPeriod.to)}: отчёт кабинета берётся за свой отрезок.`
                     : ''
                 }`}
        >
          <div className="drop-list">
            {drop.map((p) => (
              <div key={`${p.storeId}:${p.sku}`} className="drop-card">
                <div className="drop-head">
                  <div>
                    <div className="drop-name">{p.name}</div>
                    <div className="t-faint" style={{ fontSize: 12 }}>
                      {p.storeName} · {p.category} · продано {p.qty} {plural(p.qty, 'шт', 'шт', 'шт')}
                      {' на '}{money(p.revenue)} ₸
                    </div>
                  </div>
                  <Place card={p.card} />
                </div>
                <ul className="drop-why">
                  {p.reasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel
        title="Все позиции"
        note={[
          data.ranksCheckedAt
            ? `Место на карточке — наша строчка в списке продавцов, он отсортирован по цене. Снимок от ${dateLabel(data.ranksCheckedAt)}.`
            : 'Места на карточках ещё не собирали — колонка «Место» будет пустой.',
          data.trafficPeriod
            ? `«Смотрели», «Купили» и «Доля карточки» — из отчёта кабинета за ${dateLabel(data.trafficPeriod.from)} — ${dateLabel(data.trafficPeriod.to)}, а не за выбранный период. Доля общая по двум магазинам, под ней — доля этого.`
            : null,
        ].filter(Boolean).join(' ')}
      >
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <input
            className="input"
            placeholder="Найти товар или артикул"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <div className="chip-row">
            {SORTS.map(([key, label]) => (
              <button key={key} className="chip" data-active={sort === key} onClick={() => setSort(key)}>
                {label}
              </button>
            ))}
          </div>
          {category && (
            <button className="btn btn-sm" onClick={() => setCategory(null)}>
              Снять фильтр «{category}»
            </button>
          )}
        </div>

        <p className="t-dim" style={{ marginTop: 0 }}>
          Показано {rows.length} из {data.products.length} на {money(shown)} ₸
          {noCard > 0 && <> · у {noCard} место на карточке не проверено</>}
        </p>

        <table className="data">
          <thead>
            <tr>
              <th>Товар</th>
              <th className="ta-r">Штук</th>
              <th className="ta-r">Выручка</th>
              <th className="ta-r">Наценка</th>
              <th className="ta-r">Отказов</th>
              <th className="ta-r">Смотрели</th>
              <th className="ta-r">Купили</th>
              <th className="ta-r">Доля карточки</th>
              <th className="ta-r">Место</th>
              <th className="ta-r">Дороже рынка</th>
              <th className="ta-r">К прошлому</th>
              <th className="ta-r">Последняя продажа</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.storeId}:${p.sku}`}>
                <td>
                  <div>{p.name}</div>
                  <div className="t-faint" style={{ fontSize: 12 }}>
                    {p.storeName} · {p.category}
                    {p.costCode && <> · {p.costCode}</>}
                  </div>
                </td>
                <td className="num ta-r">{p.qty}</td>
                <td className="num ta-r">
                  {money(p.revenue)}
                  <div className="t-faint" style={{ fontSize: 12 }}>по {money(p.avgPrice)}</div>
                </td>
                <td className="num ta-r">
                  {p.margin === null ? (
                    <span className="t-faint" title="товар не связан с изделием в «Себестоимости»">—</span>
                  ) : (
                    <>
                      <span data-loss={p.profit < 0 || undefined}>{pct(p.margin)}</span>
                      <div className="t-faint" style={{ fontSize: 12 }}>{money(p.profit)} ₸</div>
                    </>
                  )}
                </td>
                <td className="num ta-r t-dim">
                  {p.cancelledQty > 0 ? <>{pct(p.cancelShare)}<div className="t-faint" style={{ fontSize: 12 }}>{p.cancelledQty} шт</div></> : '—'}
                </td>
                <td className="num ta-r t-dim">{p.traffic ? money(p.traffic.clicks) : '—'}</td>
                <td className="num ta-r">
                  {p.traffic && p.traffic.conversion !== null
                    ? <span data-loss={p.traffic.clicks >= 20000 && p.traffic.conversion < 0.1 || undefined}>
                        {pct(p.traffic.conversion)}
                      </span>
                    : <span className="t-faint">—</span>}
                </td>
                <td className="num ta-r"><Share traffic={p.traffic} /></td>
                <td className="ta-r"><Place card={p.card} /></td>
                <td className="num ta-r">
                  {p.card && p.card.gap !== null && p.card.gap > 0
                    ? <span data-loss>{money(p.card.gap)}</span>
                    : p.card && p.card.gap !== null
                      ? <span className="t-faint">самые дешёвые</span>
                      : <span className="t-faint">—</span>}
                </td>
                <td className="num ta-r">
                  <Change value={p.qtyChange} isNew={p.prevQty === 0} byCard={p.movedBetweenStores} />
                  {p.movedBetweenStores && (
                    <div className="t-faint" style={{ fontSize: 12 }}>переехал, по карточке</div>
                  )}
                </td>
                <td className="num ta-r t-dim">
                  {dateLabel(p.lastSold)}
                  {p.daysSinceSale !== null && p.daysSinceSale > 14 && (
                    <div className="t-faint" style={{ fontSize: 12 }}>
                      {p.daysSinceSale} {plural(p.daysSinceSale, 'день', 'дня', 'дней')} назад
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="t-dim">Под фильтр ничего не попало.</p>}
      </Panel>
    </div>
  );
}

// Строка категории. Раскрывается в список своих товаров - и заодно оставляет фильтр
// на таблице «Все позиции» внизу, как было раньше: кому нужны сортировки и поиск,
// тот идёт туда, а быстрый ответ «что внутри категории» теперь на месте вопроса.
function CategoryRow({ category: c, products, open, onToggle }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }} data-selected={open || undefined}>
        <td>
          <span className="disclosure" data-open={open || undefined}>▸</span>
          {c.category}
        </td>
        <td className="num ta-r">{money(c.revenue)}</td>
        <td className="num ta-r">
          <span className="share-bar" style={{ '--fill': `${c.share}%` }}>{pct(c.share)}</span>
        </td>
        <td className="num ta-r">{c.qty}</td>
        <td className="num ta-r t-dim">{c.positions}</td>
        <td className="num ta-r">{money(c.avgPrice)}</td>
        <td className="num ta-r t-dim">{pct(c.cancelShare)}</td>
        <td className="num ta-r"><Change value={c.change} isNew={c.prevRevenue === null} /></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ paddingTop: 0 }}>
            <div className="product-orders">
              {products.length === 0 ? (
                <p className="t-dim" style={{ margin: '6px 0' }}>Позиций в категории не нашлось.</p>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Товар</th>
                      <th className="ta-r">Штук</th>
                      <th className="ta-r">Выручка</th>
                      <th className="ta-r">Доля в категории</th>
                      <th className="ta-r">Наценка</th>
                      <th className="ta-r">Отказов</th>
                      <th className="ta-r">Смотрели</th>
                      <th className="ta-r">Доля карточки</th>
                      <th className="ta-r">Место</th>
                      <th className="ta-r">К прошлому</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={`${p.storeId}:${p.sku}`}>
                        <td>
                          <div>{p.name}</div>
                          <div className="t-faint" style={{ fontSize: 12 }}>
                            {p.storeName}
                            {p.costCode && <> · {p.costCode}</>}
                          </div>
                        </td>
                        <td className="num ta-r">{p.qty}</td>
                        <td className="num ta-r">{money(p.revenue)}</td>
                        <td className="num ta-r t-dim">
                          {c.revenue > 0 ? pct(Math.round((p.revenue / c.revenue) * 1000) / 10) : '—'}
                        </td>
                        <td className="num ta-r">
                          {p.margin === null
                            ? <span className="t-faint" title="товар не связан с изделием в «Себестоимости»">—</span>
                            : <span data-loss={p.profit < 0 || undefined}>{pct(p.margin)}</span>}
                        </td>
                        <td className="num ta-r t-dim">{p.cancelledQty > 0 ? pct(p.cancelShare) : '—'}</td>
                        <td className="num ta-r t-dim">{p.traffic ? money(p.traffic.clicks) : '—'}</td>
                        <td className="num ta-r"><Share traffic={p.traffic} /></td>
                        <td className="ta-r"><Place card={p.card} /></td>
                        <td className="num ta-r">
                          <Change value={p.qtyChange} isNew={p.prevQty === 0} byCard={p.movedBetweenStores} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Panel({ title, note, children }) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head"><h2>{title}</h2></div>
      <div className="panel-body">
        {note && <p className="panel-note" style={{ marginTop: 0, marginBottom: 14 }}>{note}</p>}
        {children}
      </div>
    </div>
  );
}
