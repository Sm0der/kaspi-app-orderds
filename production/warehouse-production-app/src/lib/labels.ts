// Russian labels for enum values shown in API error messages.

export const BARCODE_STATUS_LABELS: Record<string, string> = {
  IN_STOCK: 'на складе',
  IN_ORDER: 'зарезервирован в заказе',
  SHIPPED: 'отгружен',
  DAMAGED: 'повреждён',
};

// Статус сборки на складе - наш собственный, он не совпадает со статусом заказа в Kaspi
// и живёт в отдельной таблице order_picking (см. prisma/schema.prisma).
export const PRODUCTION_ITEM_STATUS_LABELS: Record<string, string> = {
  PENDING: 'ждёт',
  IN_PROGRESS: 'в работе',
  ON_HOLD: 'отложена',
  COMPLETED: 'закрыта',
};

export const ORDER_PICKING_STATUS_LABELS: Record<string, string> = {
  NEW: 'не начат',
  PICKING: 'в сборке',
  BLOCKED: 'собирается',
  READY: 'готов к отгрузке',
  SHIPPED: 'отгружен',
};
