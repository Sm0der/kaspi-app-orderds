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

    const item = await prisma.warehouseItem.findUnique({ where: { id: warehouseItemId } });

    if (!item) {
      return NextResponse.json(
        { success: false, error: 'Изделие не найдено' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    // Код технолога, а не item.code: у большинства изделий item.code исторически
    // равен артикулу Kaspi, и печатать его под штрихкодом - тот же слив маркетингового
    // трюка покупателю, от которого владелец и просил избавиться на этикетке.
    let costCode: string | null = null;
    if (item.costProductId) {
      const rows = await prisma.$queryRaw<{ code: string | null }[]>`
        SELECT code FROM cost_products WHERE id = ${item.costProductId}`;
      costCode = rows[0]?.code ?? null;
    }
    const barcodeBase = costCode || item.id.slice(0, 8).toUpperCase();

    // Партия, штрихкоды и приход остатка - одной транзакцией. Раньше это были отдельные
    // запросы: если один штрихкод из двухсот исчерпывал 5 попыток (коллизия хвоста или
    // просто сбойнул запрос), функция отвечала 500, а первые полторы сотни barcode-строк
    // и сама партия уже были закоммичены в базу - живые "в наличии" записи без единой
    // напечатанной этикетки и без учтённого в quantityOnHand остатка. Транзакция откатывает
    // всё разом, если хоть один штрихкод так и не удалось выдать.
    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.labelBatch.create({
        data: { warehouseItemId: item.id, units: count, printedBy: payload.userId },
      });

      // Значения генерируем со случайным хвостом, а не по счётчику: две печати могут
      // идти одновременно, и счётчик тогда выдал бы одинаковые коды. Уникальность всё
      // равно стережёт индекс в базе, поэтому на конфликт просто пробуем ещё раз.
      const created: string[] = [];
      for (let i = 0; i < count; i++) {
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          const value = makeBarcodeValue(barcodeBase);
          try {
            await tx.barcode.create({
              data: {
                barcodeValue: value,
                warehouseItemId: item.id,
                status: 'IN_STOCK',
                batchId: String(batch.id),
              },
            });
            created.push(value);
            ok = true;
          } catch (error: any) {
            if (error?.code !== 'P2002') throw error; // не про уникальность - пробрасываем
          }
        }
        if (!ok) throw new Error('BARCODE_EXHAUSTED');
      }

      // Печать - это и есть приход на склад: коробки существуют физически с этого момента
      await tx.warehouseItem.update({
        where: { id: item.id },
        data: { quantityOnHand: { increment: count }, updatedAt: new Date() },
      });

      return { batchId: batch.id, values: created };
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          batchId: result.batchId,
          item: {
            id: item.id,
            costCode,
            name: item.name,
            imageUrl: item.imageUrl,
            boxesPerUnit: item.boxesPerUnit,
          },
          // По этикетке на каждую коробку каждой штуки
          labels: result.values.flatMap((value) =>
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
    if (error instanceof Error && error.message === 'BARCODE_EXHAUSTED') {
      return NextResponse.json(
        { success: false, error: 'Не удалось выдать уникальные штрихкоды, попробуйте ещё раз' } as ApiResponse<null>,
        { status: 500 }
      );
    }
    console.error('Generate labels error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
