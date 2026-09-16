import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Список изделий для печати этикеток. Вместе с каждым - все его названия на Kaspi:
// именно они и путают упаковщика («шкаф Monaco» и «шкаф Alico» - одно и то же изделие),
// поэтому и в поиске по этой странице, и на самой этикетке они должны быть видны.
export async function GET(request: NextRequest) {
  try {
    const auth = await guard(request, 'labels');
    if (!auth.ok) return auth.response;
    const payload = auth.user;

    const items = await prisma.warehouseItem.findMany({
      include: { skus: { include: { store: true } } },
      orderBy: { name: 'asc' },
    });

    // Внутренний код изделия из себестоимости (SH-4001: шкаф, 4 двери, 0 ящиков, номер 01).
    // Технолог ведёт его в своём разделе, а на складе по нему узнают изделие быстрее,
    // чем по названию с Kaspi - те у одного и того же шкафа разные в каждом магазине.
    // Таблицы себестоимости ведёт сервис заказов, у Prisma их в схеме нет - отсюда сырой запрос.
    const costCodes = await prisma.$queryRaw<{ sku: string; code: string }[]>`
      SELECT p.sku, cp.code
      FROM products p
      JOIN cost_products cp ON cp.id = p.cost_product_id
      WHERE cp.code IS NOT NULL`;
    const codeBySku = new Map(costCodes.map((row) => [row.sku, row.code]));

    return NextResponse.json(
      {
        success: true,
        data: items.map((item) => ({
          id: item.id,
          code: item.code,
          costCode: item.skus.map((link) => codeBySku.get(link.sku)).find(Boolean) || null,
          name: item.name,
          imageUrl: item.imageUrl,
          boxesPerUnit: item.boxesPerUnit,
          quantityOnHand: item.quantityOnHand,
          aliases: item.skus.map((link) => ({
            storeName: link.store.name,
            sku: link.sku,
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
