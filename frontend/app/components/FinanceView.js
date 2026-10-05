'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';

// Деньги: сколько осталось после Kaspi и материалов.
//
// Считать это по данным заказов нельзя: комиссию площадки API не отдаёт ни одним полем,
// и «прибыль» без неё завышена примерно на 12% оборота. Поэтому раздел работает от
// выгрузки Kaspi Pay из кабинета - там удержания стоят по факту, а не ставкой.

const fmt = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('ru-RU'));
const pct = (n) => (n === null || n === undefined ? '—' : String(n).replace('.', ',') + '%');
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const monthLabel = (m) => {
  const [y, mm] = m.split('-');
  return MONTHS[Number(mm) - 1].replace(/я$/, 'ь').replace(/а$/, '') + ' ' + y;
};

// Колонки отчёта Kaspi Pay - по буквам, как в выгрузке из кабинета.
// K - номер заказа, L - дата, U - сумма, W - комиссия, AK - доставка.
const COL = { order: 'K', date: 'L', time: 'M', amount: 'U', fee: 'W', delivery: 'AK', term: 'AL', item: 'AM', merchant: 'E' };

export default function FinanceView() {
  const [periods, setPeriods] = useState([]);
  const [range, setRange] = useState({ from: '', to: '' });
  const [report, setReport] = useState(null);
  const [uncosted, setUncosted] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadPeriods = useCallback(async () => {
    try {
      const { data } = await api.get('/api/finance/periods');
      setPeriods(data.data || []);
      if (!range.from && data.data && data.data.length) {
        const latest = data.data[0];
        setRange({ from: latest.firstDay, to: latest.lastDay });
      }
    } catch (err) {
      setError(errorText(err, 'Не удалось получить список периодов'));
    }
  }, [range.from]);

  useEffect(() => { loadPeriods(); }, [loadPeriods]);

  const loadReport = useCallback(async () => {
    if (!range.from || !range.to) return;
    setLoading(true);
    setError(null);
    try {
      const [{ data: rep }, { data: unc }] = await Promise.all([
        api.get('/api/finance/report', { params: range }),
        api.get('/api/finance/uncosted', { params: range }),
      ]);
      setReport(rep);
      setUncosted(unc.data || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось посчитать'));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { loadReport(); }, [loadReport]);

  // Файл разбираем здесь: xlsx уже умеет браузер, и серверу не нужна лишняя зависимость.
  const onFile = async (file) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 'A', raw: true, defval: null });

      // Шапка - строка, где в колонке A стоит «#». Всё до неё - реквизиты магазина.
      const headerAt = grid.findIndex((r) => String(r.A || '').trim() === '#');
      if (headerAt < 0) throw new Error('Это не похоже на отчёт Kaspi Pay: не нашёл строку заголовка');

      const toISO = (v) => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const m = String(v || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
      };
      const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

      const rows = [];
      for (const r of grid.slice(headerAt + 1)) {
        const order = String(r[COL.order] || '').trim();
        const date = toISO(r[COL.date]);
        if (!order || !date) continue;
        rows.push({
          orderCode: order,
          merchant: r[COL.merchant] || null,
          date,
          time: r[COL.time] ? String(r[COL.time]) : null,
          amount: num(r[COL.amount]),
          fee: num(r[COL.fee]),
          delivery: num(r[COL.delivery]),
          term: r[COL.term] || null,
          item: r[COL.item] || null,
        });
      }
      if (rows.length === 0) throw new Error('В файле не нашлось ни одной операции');

      const { data } = await api.post('/api/finance/kaspipay', { rows, file: file.name });
      setNotice(
        `Загружено операций: ${data.inserted}` +
        (data.duplicates ? `, уже были: ${data.duplicates}` : '') +
        (data.skipped ? `, пропущено: ${data.skipped}` : '')
      );
      await loadPeriods();
      await loadReport();
    } catch (err) {
      setError(err.message && !err.response ? err.message : errorText(err, 'Не удалось загрузить файл'));
    } finally {
      setBusy(false);
    }
  };

  const m = report?.money;

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h2>Деньги</h2>
          <p className="t-dim">
            Сколько осталось после Kaspi и материалов. Считается по выгрузке Kaspi Pay —
            комиссию площадки API заказов не отдаёт, её берём из отчёта по факту.
          </p>
        </div>
        <label className="btn btn-primary" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          {busy && <span className="spinner" />} Загрузить отчёт Kaspi Pay
          <input
            type="file"
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => { onFile(e.target.files[0]); e.target.value = ''; }}
          />
        </label>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert">{notice}</div>}

      {periods.length === 0 ? (
        <div className="card">
          <p>
            Пока ничего не загружено. Возьмите в кабинете Kaspi <b>Отчёт по продажам</b> за месяц
            (Kaspi Pay → Отчёты) и загрузите файл кнопкой выше. Если магазинов несколько,
            загрузите файлы по очереди — они сложатся.
          </p>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <label className="t-dim">Период</label>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <span className="t-faint">—</span>
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            {periods.map((p) => (
              <button
                key={p.month}
                className="btn btn-ghost"
                onClick={() => setRange({ from: p.firstDay, to: p.lastDay })}
                title={`${p.operations} операций`}
              >
                {monthLabel(p.month)}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="skeleton" style={{ height: 220 }} />
          ) : m ? (
            <>
              <div className="card">
                <table className="money-table" style={{ width: '100%', maxWidth: 620 }}>
                  <tbody>
                    <tr>
                      <td>Продажи</td>
                      <td className="num" style={{ textAlign: 'right' }}>{fmt(m.sales)}</td>
                      <td />
                    </tr>
                    <tr>
                      <td>Комиссия Kaspi</td>
                      <td className="num" style={{ textAlign: 'right' }}>{fmt(m.fees)}</td>
                      <td className="num t-dim" style={{ textAlign: 'right' }}>{pct(report.shares.fees)}</td>
                    </tr>
                    <tr>
                      <td>Доставка за наш счёт</td>
                      <td className="num" style={{ textAlign: 'right' }}>{fmt(m.delivery)}</td>
                      <td className="num t-dim" style={{ textAlign: 'right' }}>{pct(report.shares.delivery)}</td>
                    </tr>
                    <tr style={{ borderTop: '1px solid var(--line)' }}>
                      <td><b>Поступило на счёт</b></td>
                      <td className="num" style={{ textAlign: 'right' }}><b>{fmt(m.received)}</b></td>
                      <td />
                    </tr>
                    <tr>
                      <td>Себестоимость товара</td>
                      <td className="num" style={{ textAlign: 'right' }}>−{fmt(m.cost)}</td>
                      <td className="num t-dim" style={{ textAlign: 'right' }}>{pct(report.shares.cost)}</td>
                    </tr>
                    <tr style={{ borderTop: '2px solid var(--line)' }}>
                      <td><b>Остаётся</b></td>
                      <td className="num" style={{ textAlign: 'right', fontSize: 18 }}>
                        <b>{fmt(m.profit)}</b>
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}><b>{pct(report.shares.profit)}</b></td>
                    </tr>
                    {m.refunds !== 0 && (
                      <tr>
                        <td className="t-dim">Возвраты за период</td>
                        <td className="num t-dim" style={{ textAlign: 'right' }}>{fmt(m.refunds)}</td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
                <p className="t-dim" style={{ marginTop: 12 }}>
                  Из каждых ста тенге продаж Kaspi забирает{' '}
                  <b>{Math.round((report.shares.fees + report.shares.delivery))} ₸</b>, в материалы уходит{' '}
                  <b>{Math.round(report.shares.cost)} ₸</b>, остаётся <b>{Math.round(report.shares.profit)} ₸</b> —
                  до зарплат, аренды, брака и налогов.
                </p>
              </div>

              <div className="card">
                <h3>Что вошло в расчёт</h3>
                <p className="t-dim">
                  Заказов посчитано: <b>{report.orders.counted}</b>.
                  {report.orders.skipped > 0 && (
                    <>
                      {' '}Пропущено <b>{report.orders.skipped}</b> на {fmt(report.orders.skippedAmount)} ₸ —
                      у них неизвестна себестоимость хотя бы одной позиции
                      {report.orders.notInBase > 0 && <>, из них {report.orders.notInBase} вообще нет в базе заказов</>}.
                      Такой заказ выбрасывается целиком: иначе его продажа попала бы в доход, а затраты нет.
                    </>
                  )}
                </p>
                {Object.keys(report.costSource || {}).length > 0 && (
                  <p className="t-dim">
                    Себестоимость взята: {Object.entries(report.costSource)
                      .map(([k, v]) => `${k} — ${v} позиций`).join(', ')}.
                  </p>
                )}
              </div>

              {uncosted.length > 0 && (
                <div className="card">
                  <h3>Нет себестоимости</h3>
                  <p className="t-dim">
                    Эти позиции мешают посчитать свои заказы. Задайте им себестоимость —
                    в «Себестоимости» через код технолога или списком по названию.
                  </p>
                  <div className="scroll-box">
                    <table>
                      <thead>
                        <tr><th>Позиция</th><th className="num">Заказов</th><th className="num">Продажи ₸</th></tr>
                      </thead>
                      <tbody>
                        {uncosted.map((u) => (
                          <tr key={u.name}>
                            <td>{u.name}</td>
                            <td className="num">{u.orders}</td>
                            <td className="num">{fmt(u.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
