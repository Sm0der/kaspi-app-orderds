// Единый словарь подписей и цветов для этапов и срочности - чтобы список заказов,
// канбан-доска и плитки показателей не разъезжались между собой.

export const STAGES = {
  new: { label: 'Новый', short: 'Новый', color: 'var(--violet)' },
  accepted: { label: 'Принят, не собран', short: 'Принят', color: 'var(--amber)' },
  packed: { label: 'Собран, ждёт курьера', short: 'Собран', color: 'var(--sage)' },
  shipping: { label: 'Передан курьеру', short: 'В пути', color: 'var(--steel)' },
  completed: { label: 'Доставлено', short: 'Доставлено', color: 'var(--slate)' },
  cancelled: { label: 'Отменён или возврат', short: 'Отменён', color: 'var(--red)' }
};

export const STAGE_ORDER = ['new', 'accepted', 'packed', 'shipping', 'completed', 'cancelled'];

export const URGENCY = {
  overdue: { label: 'Просрочено', color: 'var(--red)' },
  today: { label: 'Сегодня', color: 'var(--amber)' },
  soon: { label: 'Скоро', color: 'var(--steel)' },
  upcoming: { label: 'Предстоит', color: 'var(--slate)' }
};

export function stageOf(stage) {
  return STAGES[stage] || { label: stage || 'Неизвестно', short: '—', color: 'var(--slate)' };
}

export function urgencyOf(urgency) {
  return URGENCY[urgency] || null;
}

const DAY = 24 * 60 * 60 * 1000;

// Дата передачи курьеру приходит из Kaspi в миллисекундах. Именно она решает, можно ли
// сегодня формировать накладную, поэтому показываем её человеческим языком.
export function shipmentLabel(ms) {
  if (!ms) return { text: '—', tone: 'faint' };

  const date = new Date(Number(ms));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  const diff = Math.round((day - today) / DAY);
  const short = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

  if (diff < 0) return { text: `${short} · просрочена`, tone: 'red' };
  if (diff === 0) return { text: `${short} · сегодня`, tone: 'amber' };
  if (diff === 1) return { text: `${short} · завтра`, tone: 'steel' };
  return { text: short, tone: 'faint' };
}

export function isShippingToday(ms) {
  if (!ms) return false;
  const day = new Date(Number(ms));
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return day.getTime() === today.getTime();
}

export function formatMoney(value) {
  if (value === null || value === undefined) return '—';
  return `${Math.round(Number(value)).toLocaleString('ru-RU')} ₸`;
}

export function totalQuantity(items = []) {
  return items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
}
