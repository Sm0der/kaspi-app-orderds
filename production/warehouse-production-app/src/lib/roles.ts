// Роли и права - в одном месте. Раньше список ролей был рассыпан по страницам (свой
// ROLE_LABELS в дашборде, свои массивы roles у каждой плитки, свои проверки в каждом
// route.ts), и добавление роли требовало правок в десятке файлов, а забытая правка
// означала, что человек видит кнопку, на которую API отвечает 403.

export const ROLES = [
  'ADMIN',
  'MANAGER',
  'WAREHOUSE_RECEIVER',
  'WAREHOUSE_SHIPPER',
  'PACKER',
  'WORKSHOP_MASTER',
  'WORKSHOP_WORKER',
] as const;

export type Role = (typeof ROLES)[number];

/** Названия, которые владелец назвал сам - их и показываем везде, включая форму создания учётки */
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Владелец / администратор',
  MANAGER: 'Менеджер заказов',
  WAREHOUSE_RECEIVER: 'Кладовщик на приёмке',
  WAREHOUSE_SHIPPER: 'Кладовщик на отгрузке',
  PACKER: 'Упаковщик',
  WORKSHOP_MASTER: 'Мастер цеха',
  WORKSHOP_WORKER: 'Рабочий цеха',
};

export const ROLE_HINTS: Record<Role, string> = {
  ADMIN: 'Все разделы, включая учётные записи и настройки',
  MANAGER: 'Заказы, накладные, CRM. Склад только смотрит',
  WAREHOUSE_RECEIVER: 'Приём товара на склад по сканеру',
  WAREHOUSE_SHIPPER: 'Сборка и отгрузка заказов по сканеру',
  PACKER: 'Печать этикеток на коробки',
  WORKSHOP_MASTER: 'Задачи своего цеха и его показатели',
  WORKSHOP_WORKER: 'Задачи своего цеха',
};

/** Ролям цеха обязателен цех: без него человек войдёт, но не увидит ни одной задачи */
export const ROLES_NEEDING_WORKSHOP: Role[] = ['WORKSHOP_MASTER', 'WORKSHOP_WORKER'];

// Разделы системы. Ключи используются и интерфейсом (какие плитки рисовать), и API
// (можно ли выполнить запрос) - именно поэтому файл общий, а не два похожих списка.
export const AREAS = {
  orders: ['ADMIN', 'MANAGER'],
  receive: ['ADMIN', 'WAREHOUSE_RECEIVER'],
  ship: ['ADMIN', 'WAREHOUSE_SHIPPER'],
  labels: ['ADMIN', 'PACKER', 'WAREHOUSE_RECEIVER'],
  inventory: ['ADMIN', 'MANAGER', 'WAREHOUSE_RECEIVER', 'WAREHOUSE_SHIPPER'],
  production: ['ADMIN', 'WORKSHOP_MASTER', 'WORKSHOP_WORKER'],
  productionStats: ['ADMIN', 'MANAGER', 'WORKSHOP_MASTER'],
  admin: ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Area = keyof typeof AREAS;

export function can(role: string | undefined | null, area: Area): boolean {
  if (!role) return false;
  return (AREAS[area] as readonly string[]).includes(role);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleLabel(role: string): string {
  return isRole(role) ? ROLE_LABELS[role] : role;
}
