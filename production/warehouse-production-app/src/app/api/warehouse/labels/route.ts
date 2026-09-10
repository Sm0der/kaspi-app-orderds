import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

const MAX_UNITS = 200;

// Штрихкод = одна ШТУКА изделия, а не одна коробка. Если изделие едет в трёх местах,
// один и тот же код печатается на всех трёх этикетках с пометкой «1 из 3»: сканируя
// любую коробку комплекта, кладовщик отмечает собранной именно штуку. Попытка
// отсканировать вторую коробку того же комплекта честно ответит «уже отсканирован».
function makeBarcodeValue(code: string): string {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${code}-${suffix}`;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guard(request, 'labels');
    if (!auth.ok) return auth.response;
    const payload = auth.user;

    const { warehouseItemId, units } = await request.json();
    const count = Number(units);

    if (!warehouseItemId || !Number.isInteger(count) || count < 1 || count > MAX_UNITS) {
      return NextResponse.json(
        { success: false, error: `Укажите изделие и количество штук от 1 до ${MAX_UNITS}` } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const item = await prisma.warehouseItem.findUnique({
      where: { id: warehouseItemId },
      include: { skus: { include: { store: true } } },
    });

    if (!item) {
      return NextResponse.json(
        { success: false, error: 'Изделие не найдено' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const batch = await prisma.labelBatch.create({
      data: { warehouseItemId: item.id, units: count, printedBy: payload.userId },
    });

    // Значения генерируем со случайным хвостом, а не по счётчику: две печати могут
    // идти одновременно, и счётчик тогда выдал бы одинаковые коды. Уникальность всё
    // равно стережёт индекс в базе, поэтому на конфликт просто пробуем ещё раз.
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      let created = false;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        const value = makeBarcodeValue(item.code);
        try {
          await prisma.barcode.create({
            data: {
              barcodeValue: value,
              warehouseItemId: item.id,
              status: 'IN_STOCK',
              batchId: String(batch.id),
            },
          });
          values.push(value);
          created = true;
        } catch (error: any) {
          if (error?.code !== 'P2002') throw error; // не про уникальность - пробрасываем
        }
      }
      if (!created) {
        return NextResponse.json(
          { success: false, error: 'Не удалось выдать уникальные штрихкоды, попробуйте ещё раз' } as ApiResponse<null>,
          { status: 500 }
        );
      }
    }

    // Печать - это и есть приход на склад: коробки существуют физически с этого момента
    await prisma.warehouseItem.update({
      where: { id: item.id },
      data: { quantityOnHand: { increment: count }, updatedAt: new Date() },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          batchId: batch.id,
          item: {
            id: item.id,
            code: item.code,
            name: item.name,
            imageUrl: item.imageUrl,
            boxesPerUnit: item.boxesPerUnit,
            aliases: item.skus.map((link) => ({ storeName: link.store.name, sku: link.sku })),
          },
          // По этикетке на каждую коробку каждой штуки
          labels: values.flatMap((value) =>
            Array.from({ length: item.boxesPerUnit }, (_, box) => ({
              barcodeValue: value,
              boxNumber: box + 1,
              boxesTotal: item.boxesPerUnit,
            }))
          ),
        },
      } as ApiResponse<any>,
      { status: 200 }
    );
  } catch (error) {
    console.error('Generate labels error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
