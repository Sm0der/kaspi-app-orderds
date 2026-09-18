import { prisma } from '@/lib/prisma';

// Код технолога висит на ИЗДЕЛИИ склада (warehouse_items.cost_product_id) - это якорь,
// потому что один физический шкаф продаётся под несколькими артикулами Kaspi сразу.
// Но себестоимость в аналитике заказов считается по позиции заказа, а та знает только
// артикул: `analytics.js` джойнит order_items → products и берёт products.cost_product_id.
// Поэтому после каждой правки связи копию кода раскладываем по артикулам изделия -
// иначе владелец привязал бы код, а маржа в «Аналитике» так и осталась бы прочерком.
//
// Направление одностороннее: изделие → артикулы. Обратно (из «Себестоимости» технолога,
// PUT /api/costing/products/:id/skus) артикулы по-прежнему можно проставить напрямую,
// но следующая правка изделия перепишет их по себе.
export async function syncProductCostLinks(warehouseItemId: string): Promise<void> {
  const item = await prisma.warehouseItem.findUnique({
    where: { id: warehouseItemId },
    select: { costProductId: true },
  });
  if (!item) return;

  // products - таблица базы заказов, в Prisma-схеме склада у неё нет cost_product_id
  // (см. ту же оговорку в api/admin/skus), поэтому сырой запрос.
  await prisma.$executeRaw`
    UPDATE products p
    SET cost_product_id = ${item.costProductId}
    FROM warehouse_item_skus wis
    WHERE wis.warehouse_item_id = ${warehouseItemId}
      AND p.store_id = wis.store_id
      AND p.sku = wis.sku
      AND p.cost_product_id IS DISTINCT FROM ${item.costProductId}`;
}

/** Артикул больше не принадлежит изделию - снимаем с него и код изделия */
export async function clearProductCostLink(storeId: number, sku: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE products SET cost_product_id = NULL
    WHERE store_id = ${storeId} AND sku = ${sku} AND cost_product_id IS NOT NULL`;
}
