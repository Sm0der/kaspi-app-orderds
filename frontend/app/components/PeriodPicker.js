'use client';

// Выбор периода - один и тот же в «Аналитике» и в «Заказах», чтобы одинаковый вопрос
// («что было с 1 по 15 марта») задавался в обоих разделах одинаково.
//
// Дни считаем по Алматы, а не по часовому поясу браузера: у владельца он алматинский,
// у сервера на Vercel - UTC, и к вечеру «сегодня» разъезжается на сутки.

export function almatyDay(offset = 0) {
  const shifted = new Date(Date.now() + 5 * 3600000 - offset * 86400000);
  return shifted.toISOString().slice(0, 10);
}

const iso = (d) => d.toISOString().slice(0, 10);
// Текущий момент по Алматы как дата - от неё считаем «этот месяц» и «прошлый месяц»
const almatyNow = () => new Date(Date.now() + 5 * 3600000);

export function presetRange(key) {
  const now = almatyNow();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  switch (key) {
    case 'today': return [almatyDay(0), almatyDay(0)];
    case 'week': return [almatyDay(6), almatyDay(0)];
    case 'month30': return [almatyDay(29), almatyDay(0)];
    case 'thisMonth': return [iso(new Date(Date.UTC(y, m, 1))), almatyDay(0)];
    case 'prevMonth': return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
    case 'quarter': return [almatyDay(89), almatyDay(0)];
    case 'year': return [almatyDay(364), almatyDay(0)];
    default: return [null, null];
  }
}

const PRESETS = [
  ['today', 'Сегодня'],
  ['week', 'Неделя'],
  ['month30', '30 дней'],
  ['thisMonth', 'Этот месяц'],
  ['prevMonth', 'Прошлый месяц'],
  ['quarter', 'Квартал'],
  ['year', 'Год'],
];

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function dayLabel(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function rangeLabel(from, to) {
  if (!from && !to) return 'за всё время';
  if (from === to) return dayLabel(from);
  return `${dayLabel(from)} — ${dayLabel(to)}`;
}

/**
 * from/to - строки ГГГГ-ММ-ДД (или пустые). onChange(from, to) получает обе границы разом,
 * чтобы период не пересчитывался дважды и запрос уходил один.
 * allowEmpty - показывать кнопку «Все», которая снимает период (нужно в «Заказах»,
 * где без периода экран показывает текущую работу).
 */
export default function PeriodPicker({ from, to, onChange, allowEmpty = false, label = 'Период' }) {
  const active = PRESETS.find(([key]) => {
    const [f, t] = presetRange(key);
    return f === from && t === to;
  });

  return (
    <div className="period-picker">
      <div className="chip-row">
        {allowEmpty && (
          <button className="chip" data-active={!from && !to} onClick={() => onChange(null, null)}>
            Все
          </button>
        )}
        {PRESETS.map(([key, text]) => (
          <button
            key={key}
            className="chip"
            data-active={active && active[0] === key}
            onClick={() => { const [f, t] = presetRange(key); onChange(f, t); }}
          >
            {text}
          </button>
        ))}
      </div>

      <div className="period-dates">
        <label className="t-dim">{label}</label>
        <input
          type="date"
          className="input"
          value={from || ''}
          max={to || undefined}
          onChange={(e) => onChange(e.target.value || null, to)}
        />
        <span className="t-faint">—</span>
        <input
          type="date"
          className="input"
          value={to || ''}
          min={from || undefined}
          onChange={(e) => onChange(from, e.target.value || null)}
        />
      </div>
    </div>
  );
}
