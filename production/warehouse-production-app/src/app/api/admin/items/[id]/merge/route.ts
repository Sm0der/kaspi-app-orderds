import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

type Params = { params: Promise<{ id: string }> };

// POST /api/admin/items/:id/merge { intoId } - объединить два изделия склада в одно.
// Нужно ровно для того шкафа, что продаётся под разными названиями и ценами ради
// маркетинга: технолог завёл его один раз, а на складе он мог случайно оказаться
// заведён дважды под разными артикулами. :id исчезает, intoId получает всё его: артикулы
// Kaspi, штрихкоды (а с ними и историю движений - она ссылается на штрихкод, не на
// изделие), партии этикеток и остаток. Код технолога переносим, только если у intoId
// его ещё нет - целевое изделие не должно молча потерять уже стоящий код.
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const body = await request.json();
    const intoId = String(body.intoId || '').trim();
    if (!intoId) return bad('Укажите, в какое изделие объединять');
    if (intoId === id) return bad('Нельзя объединить изделие само с собой');

    const [source, target] = await Promise.all([
      prisma.warehouseItem.findUnique({ where: { id } }),
      prisma.warehouseItem.findUnique({ where: { id: intoId } }),
    ]);
    if (!source) return bad('Изделие не найдено');
    if (!target) return bad('Целевое изделие не найдено');

    await prisma.$transaction([
      prisma.warehouseItemSku.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } }),
      prisma.barcode.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } }),
      prisma.labelBatch.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } }),
      prisma.productionItem.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } }),
      prisma.warehouseItem.update({
        where: { id: intoId },
        data: {
          quantityOnHand: { increment: source.quantityOnHand },
          costProductId: target.costProductId ?? source.costProductId,
          updatedAt: new Date(),
        },
      }),
      prisma.warehouseItem.delete({ where: { id } }),
    ]);

    return NextResponse.json({ success: true, data: { id: intoId } } as ApiResponse<unknown>);
  } catch (error) {
    console.error('Merge warehouse items error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось объединить изделия' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
