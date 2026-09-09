import { prisma } from '@/lib/prisma';

// Заказы приходят из общей базы - их туда пишет синхронизация с Kaspi, склад их только
// читает. Единственное место, где артикул заказа превращается в изделие склада, - таблица
// warehouse_item_skus: у изделия может быть несколько артикулов Kaspi (один и тот же шкаф
// заведён в двух магазинах или дважды в одном), поэтому идём не по названию и не по коду
// товара, а строго по паре (магазин, артикул).
//
// Связи между order_items и warehouse_item_skus в Prisma нет намеренно: ключ составной
// (store_id живёт на заказе, sku - на позиции), внешним ключом это не выразить. Поэтому
// один дополнительный запрос на заказ - и никакой магии.

export type PickingLine = {
  orderItemId: number;
  sku: string;
  name: string;
  quantityRequired: number;
  quantityPicked: number;
  warehouseItemId: string | null;
  warehouseItemName: string | null;
};

export type OrderForPicking = {
  id: number;
  orderCode: string | null;
  kaspiOrderId: string;
  storeId: number;
  storeName: string;
  status: string;
  shipDate: Date | null;
  lines: PickingLine[];
  /** Позиции заказа, которым не сопоставлено изделие: собрать их по штрихкоду нельзя */
  unmapped: string[];
};

export async function loadOrderForPicking(orderId: number): Promise<OrderForPicking | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { store: true, picking: true, items: { include: { picking: true } } },
  });
  if (!order) return null;

  return shape(order);
}

export async function loadOrdersForPicking(): Promise<OrderForPicking[]> {
  // В сборку попадают заказы, которые продавец ещё должен передать курьеру. Отгруженные
  // и завершённые склад больше не касается.
  const orders = await prisma.order.findMany({
    where: { stage: { in: ['new', 'accepted', 'packed'] } },
    include: { store: true, picking: true, items: { include: { picking: true } } },
    orderBy: [{ shipDate: 'asc' }, { id: 'asc' }],
    take: 200,
  });

  return Promise.all(orders.map(shape));
}

type OrderRow = Awaited<ReturnType<typeof loadRow>>;
async function loadRow() {
  return prisma.order.findFirstOrThrow({
    include: { store: true, picking: true, items: { include: { picking: true } } },
  });
}

async function shape(order: NonNullable<OrderRow>): Promise<OrderForPicking> {
  const links = order.items.length
    ? await prisma.warehouseItemSku.findMany({
        where: { storeId: order.storeId, sku: { in: order.items.map((i) => i.sku) } },
        include: { warehouseItem: true },
      })
    : [];
  const itemBySku = new Map(links.map((link) => [link.sku, link.warehouseItem]));

  const lines: PickingLine[] = order.items.map((item) => {
    const warehouseItem = itemBySku.get(item.sku) ?? null;
    return {
      orderItemId: item.id,
      sku: item.sku,
      name: item.name,
      quantityRequired: item.quantity,
      quantityPicked: item.picking?.quantityPicked ?? 0,
      warehouseItemId: warehouseItem?.id ?? null,
      warehouseItemName: warehouseItem?.name ?? null,
    };
  });

  return {
    id: order.id,
    orderCode: order.orderCode,
    kaspiOrderId: order.kaspiOrderId,
    storeId: order.storeId,
    storeName: order.store.name,
    status: order.picking?.status ?? 'NEW',
    shipDate: order.shipDate,
    lines,
    unmapped: lines.filter((line) => !line.warehouseItemId).map((line) => line.sku),
  };
}

export function isFullyPicked(lines: PickingLine[]): boolean {
  return lines.length > 0 && lines.every((line) => line.quantityPicked >= line.quantityRequired);
}
