import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Список изделий для печати этикеток. Названия на Kaspi нужны только для поиска на
// этой странице (упаковщик приходит с тем именем, что написано в заказе) - на саму
// этикетку они больше не попадают, см. LabelCard в warehouse/labels/page.tsx.
export async function GET(request: NextRequest) {
  try {
    const auth = await guard(request, 'labels');
    if (!auth.ok) return auth.response;
    const payload = auth.user;

    const items = await prisma.warehouseItem.findMany({
      include: { skus: { include: { store: true } } },
      orderBy: { name: 'asc' },
    });

    // Код технолога (SH-4001: шкаф, 4 двери, 0 ящиков, номер 01) привязан к изделию
    // напрямую (warehouse_items.cost_product_id), а не через артикул Kaspi - один и тот
    // же шкаф продаётся под разными артикулами и ценами, код у него один. Таблицу
    // технолога ведёт сервис заказов, у Prisma склада её в схеме нет - отсюда сырой запрос.
    const costProducts = await prisma.$queryRaw<{ id: number; code: string | null }[]>`
      SELECT id, code FROM cost_products`;
    const codeById = new Map(costProducts.map((row) => [row.id, row.code]));

    // Названия товаров с Kaspi - ради поиска на странице печати. Упаковщик приходит с
    // именем из заказа («Cassini», «Кухни Гранд»), а у изделия имя одно, своё: после
    // того как несколько карточек свели в одно изделие, найти его по имени из заказа
    // стало нельзя. На саму этикетку эти названия не попадают.
    const catalog = await prisma.$queryRaw<{ store_id: number; sku: string; name: string }[]>`
      SELECT store_id, sku, name FROM products`;
    const nameBySku = new Map(catalog.map((row) => [`${row.store_id}|${row.sku}`, row.name]));

    return NextResponse.json(
      {
        success: true,
        data: items.map((item) => ({
          id: item.id,
          code: item.code,
          costCode: item.costProductId ? codeById.get(item.costProductId) ?? null : null,
          name: item.name,
          imageUrl: item.imageUrl,
          boxesPerUnit: item.boxesPerUnit,
          quantityOnHand: item.quantityOnHand,
          aliases: item.skus.map((link) => ({
            storeName: link.store.name,
            sku: link.sku,
            name: nameBySku.get(`${link.storeId}|${link.sku}`) ?? null,
          })),
        })),
      } as ApiResponse<any>,
      { status: 200 }
    );
  } catch (error) {
    console.error('List label items error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
