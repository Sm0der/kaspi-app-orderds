'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, errorText } from '../lib/api';

// Вывозы, восстановленные по времени формирования накладных.
//
// Пакеты ниже в этом же разделе появляются только когда накладные формируют кнопкой в
// сервисе. Если их печатают в кабинете Kaspi, пакетов нет вовсе - а вывозы всё равно были.
// Их и показывает эта панель: сервер читает момент генерации из самого PDF накладной
// (единственное место, где Kaspi его хранит) и режет день на рейсы по перерывам.

const DAY_LABEL = (day) => {
  const [year, month, date] = day.split('-');
  return new Date(Number(year), Number(month) - 1, Number(date)).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    weekday: 'short'
  });
};

export default function RunsPanel() {
  const [runs, setRuns] = useState([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(7);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/api/runs', { params: { days } });
      setRuns(data.data || []);
      setPending(data.pending || 0);
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить вывозы'));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  // Штампы читаются пачками: на каждую накладную это два обращения к Kaspi, и всё сразу
  // в один запрос не уложится. Повторяем, пока сервер не скажет, что непрочитанных нет.
  const readStamps = async () => {
    setReading(true);
    setError(null);
    try {
      let left = Infinity;
      let guard = 0;
      while (left > 0 && guard < 20) {
        const { data } = await api.post('/api/runs/refresh', { limit: 60 });
        left = data.remaining;
        setPending(left);
        guard += 1;
      }
      await load();
    } catch (err) {
      setError(errorText(err, 'Не удалось прочитать накладные'));
    } finally {
      setReading(false);
    }
  };

  const download = async (run) => {
    setBusyKey(run.key);
    setError(null);
    try {
      await downloadFile(`/api/runs/${run.key}/waybills.zip`, `Рейс_${run.number}_${run.day}.zip`);
    } catch (err) {
      setError(errorText(err, 'Не удалось скачать архив'));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="panel rise" style={{ marginBottom: 22 }}>
      <div className="panel-head">
        <div>
          <h2>Вывозы</h2>
          <p className="panel-note">
            Собраны по времени формирования накладных — работает и когда их печатают в кабинете Kaspi
          </p>
        </div>
        <div className="topbar-spacer" />
        <select
          className="select select-sm"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          title="За какой период показывать"
        >
          <option value={1}>за сегодня</option>
          <option value={7}>за неделю</option>
          <option value={30}>за месяц</option>
        </select>
        <button className="btn btn-sm" onClick={load} disabled={loading || reading}>
          {loading && <span className="spinner" />} Обновить
        </button>
      </div>

      {error && <div className="panel-body"><div className="alert alert-error">{error}</div></div>}

      {pending > 0 && (
        <div className="panel-body" style={{ paddingBottom: 0 }}>
          <div className="alert alert-note" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span>
              У {pending} накладных время формирования ещё не прочитано — эти заказы в списке не учтены.
            </span>
            <button className="btn btn-sm btn-primary" onClick={readStamps} disabled={reading}>
              {reading && <span className="spinner" />} {reading ? 'Читаем' : 'Прочитать'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="panel-body" style={{ display: 'grid', gap: 10 }}>
          {Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton" style={{ height: 34 }} />)}
        </div>
      ) : runs.length === 0 ? (
        <div className="empty">
          {pending > 0
            ? 'Нажмите «Прочитать» — сервис заглянет в накладные и разложит их по рейсам.'
            : 'За выбранный период накладных не формировали.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>День</th>
                <th>Рейс</th>
                <th>Время</th>
                <th style={{ textAlign: 'right' }}>Накладных</th>
                <th>Магазины</th>
                <th style={{ textAlign: 'right' }}>Архив</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.key}>
                  <td>{DAY_LABEL(run.day)}</td>
                  <td><strong>№{run.number}</strong></td>
                  <td className="mono">{run.from === run.to ? run.from : `${run.from}–${run.to}`}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{run.count}</td>
                  <td className="t-dim">
                    {Object.entries(run.stores)
                      .map(([store, count]) => `${store} — ${count}`)
                      .join(' · ')}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm" onClick={() => download(run)} disabled={busyKey === run.key}>
                      {busyKey === run.key ? <span className="spinner" /> : '↓'} Накладные
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
