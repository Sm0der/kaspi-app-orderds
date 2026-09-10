// Список ролей живёт в src/lib/roles.ts вместе с их правами и названиями - здесь только тип,
// чтобы справочник и типы не разошлись
import type { Role } from '@/lib/roles';

export type UserRole = Role;

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  workshopId?: string;
  warehouseId?: string;
  /** Магазин из общей базы заказов, поэтому число, а не строка */
  storeId?: number;
  isActive: boolean;
  /** Пароль выдан администратором: интерфейс уведёт на смену, пока не сменит */
  mustChangePassword?: boolean;
  createdAt: Date;
}

export interface Workshop {
  id: string;
  name: string;
  orderSequence: number;
  description?: string;
}

export interface ProductionItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  currentWorkshopId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'ON_HOLD';
  warehouseItemId?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Изделие склада. Артикулов Kaspi у него может быть несколько - они лежат
// не здесь, а в warehouse_item_skus (см. WarehouseItemSku ниже).
export interface WarehouseItem {
  id: string;
  code: string;
  name: string;
  warehouseId?: string;
  quantityOnHand: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Привязка артикула Kaspi к изделию: у артикула одно изделие, у изделия много артикулов */
export interface WarehouseItemSku {
  id: number;
  warehouseItemId: string;
  storeId: number;
  sku: string;
}

export interface Barcode {
  id: string;
  barcodeValue: string;
  warehouseItemId: string;
  status: 'IN_STOCK' | 'IN_ORDER' | 'SHIPPED' | 'DAMAGED';
  batchId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderPickingStatus = 'NEW' | 'PICKING' | 'BLOCKED' | 'READY' | 'SHIPPED';

// Заказ приходит из общей базы (его пишет синхронизация с Kaspi), а статус сборки -
// наш собственный, из order_picking. Форму собирает lib/orders.ts.
export interface OrderForPicking {
  id: number;
  orderCode: string | null;
  kaspiOrderId: string;
  storeId: number;
  storeName: string;
  status: OrderPickingStatus | string;
  shipDate: string | Date | null;
  lines: PickingLine[];
  unmapped: string[];
}

export interface PickingLine {
  orderItemId: number;
  sku: string;
  name: string;
  quantityRequired: number;
  quantityPicked: number;
  warehouseItemId: string | null;
  warehouseItemName: string | null;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface AuthPayload {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: User;
  token: string;
  refreshToken?: string;
}
