'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';

// Аналитика владельца: деньги, логистика и выработка людей за выбранный период.
// Раздел только читает - ничего не формирует и не меняет, поэтому его можно открывать
// в разгар отгрузки, ничего не сломав.

const money = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('ru-RU'));
const PERIODS = [
  { days: 7, label: 'Неделя' },
  { days: 30, label: 'Месяц' },
  { days: 90, label: 'Квартал' },
  { days: 365, label: 'Год' },
];

// День по Алматы: считать период по часовому поясу браузера нельзя - у владельца он
// алматинский, а у сервера на Vercel UTC, и «сегодня» разъезжается на день по вечерам.
function almatyDay(offset = 0) {
  const shifted = new Date(Date.now() + 5 * 3600000 - offset * 86400000);
  return shifted.toISOString().slice(0, 10);
}

// Минимум пикселей на подпись даты: «18.08» занимает около 26, остальное - воздух
const TICK_SPACE = 52;

const edgeSafe = (at) => {
  if (at < 8) return { left: 0 };
  if (at > 92) return { right: 0 };
  return { left: `${at}%`, transform: 'translateX(-50%)' };
};

const dayLabel = (iso) => {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
};

// Дни без событий приходят из базы пропущенными - в выходные никто ничего не отгружает.
// Без этой добивки график сжимает календарь: суббота исчезает, и пятница оказывается
// вплотную к понедельнику, как будто работали без перерыва.
function byCalendar(rows, from, to, field) {
  const known = new Map(rows.map((row) => [row.day.slice(0, 10), row]));
  const out = [];
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    const key = day.toISOString().slice(0, 10);
    const row = known.get(key);
    out.push({ key, value: row ? Number(row[field]) : 0, row });
  }
  return out;
}

export default function AnalyticsView({ storeId }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { from: almatyDay(days - 1), to: almatyDay(0) };
      if (storeId) params.store = storeId;
      const { data: body } = await api.get('/api/analytics/overview', { params });
      setData(body);
    } catch (err) {
      setError(errorText(err, 'Не удалось собрать аналитику'));
    } finally {
      setLoading(false);
    }
  }, [days, storeId]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="panel">
        <div className="panel-body">
          <div className="alert alert-error">{error}</div>
          <button className="btn" onClick={load} style={{ marginTop: 12 }}>Повторить</button>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return <div className="panel"><div className="panel-body t-dim">Считаем…</div></div>;
  }

  const { money: m, logistics: l, products, people } = data;

  return (
    <div className="analytics">
      <div className="chip-row" style={{ marginBottom: 16 }}>
        {PERIODS.map((p) => (
          <button key={p.days} className="chip" data-active={days === p.days} onClick={() => setDays(p.days)}>
            {p.label}
          </button>
        ))}
        <span className="eyebrow" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
          {dayLabel(data.range.from)} — {dayLabel(data.range.to)}
          {loading && ' · обновляем'}
        </span>
      </div>

      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi">
          <div className="kpi-value kpi-money num">{money(m.revenue)} ₸</div>
          <div className="kpi-label">Выручка за период</div>
        </div>
        <div className="kpi">
          <div className="kpi-value num">{m.sold}</div>
          <div className="kpi-label">Заказов продано</div>
        </div>
        <div className="kpi">
          <div className="kpi-value kpi-money num">{money(m.avgCheck)} ₸</div>
          <div className="kpi-label">Средний чек</div>
        </div>
        <div className="kpi">
          <div className="kpi-value num">{m.cancelledOrders}</div>
          <div className="kpi-label">
            Отказов {m.orders > 0 && <span className="t-dim">· {Math.round((m.cancelledOrders / m.orders) * 100)}%</span>}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-value num">{l.handed}</div>
          <div className="kpi-label">Передано курьеру</div>
        </div>
        <div className="kpi">
          <div className="kpi-value num">{l.medianHours != null ? `${Math.round(l.medianHours / 24 * 10) / 10} дн` : '—'}</div>
          <div className="kpi-label">Медиана от заказа до курьера</div>
        </div>
      </div>

      <Panel title="Выручка по дням" note={`Заказ считается за день оформления. Отмены из выручки исключены.`}>
        <Bars
          rows={byCalendar(m.byDay, data.range.from, data.range.to, 'revenue')
            .map((d) => ({ ...d, extra: d.row ? `${d.row.orders} зак.` : 'заказов не было' }))}
          format={(v) => `${money(v)} ₸`}
        />
      </Panel>

      <div className="analytics-row">
        <Panel title="Магазины">
          <table className="data">
            <thead>
              <tr><th>Магазин</th><th className="ta-r">Заказов</th><th className="ta-r">Выручка</th><th className="ta-r">Отказов</th></tr>
            </thead>
            <tbody>
              {m.byStore.map((row) => (
                <tr key={row.store_id}>
                  <td>{row.name}</td>
                  <td className="num ta-r">{row.orders}</td>
                  <td className="num ta-r">{money(row.revenue)}</td>
                  <td className="num ta-r t-dim">{row.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Города" note="По адресу доставки в заказе">
          <table className="data">
            <thead><tr><th>Город</th><th className="ta-r">Заказов</th><th className="ta-r">Выручка</th></tr></thead>
            <tbody>
              {l.towns.map((row) => (
                <tr key={row.town}>
                  <td>{row.town}</td>
                  <td className="num ta-r">{row.orders}</td>
                  <td className="num ta-r t-dim">{money(row.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel
        title="Товары"
        note="Прибыль считается только у артикулов, привязанных к изделию в «Себестоимости» — у остальных прочерк."
      >
        <table className="data">
          <thead>
            <tr>
              <th>Товар</th><th>Код</th>
              <th className="ta-r">Штук</th><th className="ta-r">Выручка</th>
              <th className="ta-r">Себестоимость</th><th className="ta-r">Прибыль</th>
            </tr>
          </thead>
          <tbody>
            {products.map((row) => (
              <tr key={row.sku}>
                <td>{row.name}</td>
                <td className="num t-dim">{row.costCode || '—'}</td>
                <td className="num ta-r">{row.qty}</td>
                <td className="num ta-r">{money(row.revenue)}</td>
                <td className="num ta-r t-dim">{row.cost == null ? '—' : money(row.cost)}</td>
                <td
                  className="num ta-r"
                  style={{ fontWeight: row.profit == null ? 400 : 600, color: row.profit < 0 ? 'var(--red)' : undefined }}
                >
                  {row.profit == null ? '—' : money(row.profit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Отгрузки"
        note="По дню передачи курьеру, а не оформления: заказ августа, уехавший в сентябре, — сентябрьский день работы."
      >
        <Bars
          rows={byCalendar(l.byDay, data.range.from, data.range.to, 'handed')}
          format={(v) => `${v} зак.`}
        />
        <div className="analytics-facts">
          <Fact label="Сейчас в работе" value={(l.pending.new || 0) + (l.pending.accepted || 0) + (l.pending.packed || 0)}
            hint={`новых ${l.pending.new || 0} · принято ${l.pending.accepted || 0} · собрано ${l.pending.packed || 0}`} />
          <Fact label="Среднее до курьера" value={l.avgHours != null ? `${Math.round(l.avgHours / 24 * 10) / 10} дн` : '—'}
            hint={l.avgHours != null ? `${Math.round(l.avgHours)} часов` : 'нет отгруженных заказов'} />
          <Fact label="Переносов срока" value={l.postponed}
            hint={l.postponed > 0
              ? `в среднем на ${l.postponedAvgDays} дн, максимум ${l.postponedMaxDays}`
              : 'считается с 16 сентября: Kaspi подтягивает план к факту, поэтому первую дату мы запоминаем сами'} />
        </div>
      </Panel>

      <Panel title="Люди" note="Заполняется по мере работы на складе и в цехах — пустая строка значит, что действий за период не было.">
        <div className="analytics-row">
          <PeopleTable
            title="Сборка заказов"
            rows={people.picking}
            columns={[['orders', 'Заказов']]}
          />
          <PeopleTable
            title="Приёмка и отгрузка"
            rows={people.movements}
            columns={[['inbound', 'Принял'], ['outbound', 'Отгрузил']]}
          />
        </div>
        <div className="analytics-row">
          <PeopleTable
            title="Печать этикеток"
            rows={people.labels}
            columns={[['units', 'Штук'], ['batches', 'Партий']]}
          />
          <PeopleTable
            title="Цеха"
            rows={people.workshops}
            columns={[['done', 'Сделано'], ['defects', 'Брак']]}
            subtitleKey="workshop"
          />
        </div>
      </Panel>
    </div>
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

function Fact({ label, value, hint }) {
  return (
    <div className="analytics-fact">
      <div className="analytics-fact-value num">{value}</div>
      <div className="analytics-fact-label">{label}</div>
      {hint && <div className="analytics-fact-hint">{hint}</div>}
    </div>
  );
}

// Столбики рисуем сами: библиотека ради двух графиков утяжелила бы страницу сильнее,
// чем весь этот раздел. Высота - доля от максимума, подпись дня - через один, иначе
// за квартал даты слипаются в кашу.
function Bars({ rows, format }) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.value)), [rows]);
  if (!rows.length) return <p className="t-dim">За период данных нет.</p>;

  // Подпись дня шире своего столбика (за месяц на столбик приходится 6-8 пикселей),
  // поэтому даты лежат отдельной осью и позиционируются процентом от ширины. Если
  // положить их внутрь столбиков, строка дат растягивает страницу вбок на телефоне.
  //
  // Сколько подписей влезет, зависит от ширины экрана, а не от числа дней: на телефоне
  // десять дат за месяц слипались в «8.0821.0824.08». Меряем ширину и оставляем столько,
  // чтобы между подписями оставалось не меньше TICK_SPACE пикселей.
  const step = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(width / TICK_SPACE))));
  const ticks = rows
    .map((row, i) => ({ key: row.key, at: ((i + 0.5) / rows.length) * 100 }))
    .filter((_, i) => i % step === 0);

  return (
    <div ref={box}>
      <div className="bars">
        {rows.map((row) => (
          <div
            className="bars-col"
            key={row.key}
            title={`${dayLabel(row.key)}: ${format(row.value)}${row.extra ? ` · ${row.extra}` : ''}`}
          >
            <div className="bars-slot">
              <div className="bars-bar" style={{ height: `${Math.max(2, (row.value / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="bars-axis">
        {ticks.map((tick) => (
          // Крайние подписи прижимаем к краю: по центру своего столбика они наполовину
          // уходили бы за границу графика и обрезались до «8.08».
          <span key={tick.key} style={edgeSafe(tick.at)}>{dayLabel(tick.key)}</span>
        ))}
      </div>
    </div>
  );
}

function PeopleTable({ title, rows, columns, subtitleKey }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{title}</div>
      {rows.length === 0 ? (
        <p className="t-dim" style={{ margin: 0 }}>За период пусто.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Сотрудник</th>
              {columns.map(([key, label]) => <th key={key} className="ta-r">{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.name}-${i}`}>
                <td>
                  {row.name}
                  {subtitleKey && row[subtitleKey] && <span className="t-dim"> · {row[subtitleKey]}</span>}
                </td>
                {columns.map(([key]) => <td key={key} className="num ta-r">{row[key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
