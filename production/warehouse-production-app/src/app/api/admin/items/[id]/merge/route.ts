import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { syncProductCostLinks } from '@/lib/costLink';
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

    // Остаток и код технолога читаем ВНУТРИ транзакции, а не заранее: если ровно в этот
    // момент кладовщик печатает новые этикетки на исходное изделие (это тоже прибавляет
    // quantityOnHand), значение, прочитанное до транзакции, устареет, и приращение уйдёт
    // в никуда - штрихкоды переедут в целевое изделие, а посчитанные по ним штуки нет.
    await prisma.$transaction(async (tx) => {
      const [source, target] = await Promise.all([
        tx.warehouseItem.findUnique({ where: { id } }),
        tx.warehouseItem.findUnique({ where: { id: intoId } }),
      ]);
      if (!source) throw new Error('SOURCE_NOT_FOUND');
      if (!target) throw new Error('TARGET_NOT_FOUND');

      await tx.warehouseItemSku.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } });
      await tx.barcode.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } });
      await tx.labelBatch.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } });
      await tx.productionItem.updateMany({ where: { warehouseItemId: id }, data: { warehouseItemId: intoId } });
      await tx.warehouseItem.update({
        where: { id: intoId },
        data: {
          quantityOnHand: { increment: source.quantityOnHand },
          costProductId: target.costProductId ?? source.costProductId,
          updatedAt: new Date(),
        },
      });
      await tx.warehouseItem.delete({ where: { id } });
    });

    // Слияние уже необратимо случилось - если это упадёт, помечаем изделие снаружи как
    // "код не разложен по артикулам" через 200, а не отвечаем "не удалось объединить":
    // повторная попытка объединения нашла бы исходное изделие уже удалённым.
    try {
      await syncProductCostLinks(intoId);
    } catch (error) {
      console.error('Merge succeeded but cost-link sync failed:', error);
    }

    return NextResponse.json({ success: true, data: { id: intoId } } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Error && error.message === 'SOURCE_NOT_FOUND') return bad('Изделие не найдено');
    if (error instanceof Error && error.message === 'TARGET_NOT_FOUND') return bad('Целевое изделие не найдено');
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
