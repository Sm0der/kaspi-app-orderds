import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { syncProductCostLinks } from '@/lib/costLink';
import { ApiResponse } from '@/types';

type Params = { params: Promise<{ id: string; skuId: string }> };

// POST /api/admin/items/:id/skus/:skuId/split - отцепить артикул в собственное изделие.
// Обратная операция к объединению: выяснилось, что артикул на самом деле не тот же
// физический шкаф. Артикул с этим изделием больше не связан, штрихкоды и остаток
// у старого изделия не трогаем - у нового своя история с нуля.
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id, skuId } = await params;

  try {
    const link = await prisma.warehouseItemSku.findUnique({ where: { id: Number(skuId) } });
    if (!link || link.warehouseItemId !== id) return bad('Связь не найдена');

    const [productRows, source] = await Promise.all([
      prisma.$queryRawUnsafe<{ name: string; image_url: string | null }[]>(
        `SELECT name, image_url FROM products WHERE store_id = $1 AND sku = $2 LIMIT 1`,
        link.storeId,
        link.sku
      ),
      prisma.warehouseItem.findUnique({ where: { id } }),
    ]);
    if (!source) return bad('Изделие не найдено');

    const name = productRows[0]?.name || `${source.name} (${link.sku})`;

    const created = await prisma.$transaction(async (tx) => {
      const newItem = await tx.warehouseItem.create({
        // Коробки наследуем у исходного изделия: отцепляют обычно похожую позицию,
        // и 1 коробка по умолчанию чаще неверна, чем унаследованное значение.
        // Фото берём своё - из каталога по этому артикулу, и только если там пусто,
        // наследуем исходное: у отцепляемой карточки обычно свой цвет, а фото
        // печатается на этикетке.
        data: {
          code: link.sku,
          name,
          warehouseId: source.warehouseId,
          boxesPerUnit: source.boxesPerUnit,
          imageUrl: productRows[0]?.image_url ?? source.imageUrl,
        },
      });
      await tx.warehouseItemSku.update({ where: { id: link.id }, data: { warehouseItemId: newItem.id } });
      return newItem;
    });

    // У нового изделия кода технолога ещё нет - снимаем его и с артикула,
    // иначе маржа считалась бы по себестоимости изделия, от которого он отцеплен.
    // Новое изделие уже создано и артикул уже переехал - сбой здесь не отменяет это.
    try {
      await syncProductCostLinks(created.id);
    } catch (error) {
      console.error('Split succeeded but cost-link sync failed:', error);
    }

    return NextResponse.json({ success: true, data: created } as ApiResponse<unknown>, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return bad('Изделие с кодом, равным этому артикулу, уже есть - переименуйте вручную через "Новое изделие"');
    }
    console.error('Split SKU error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось отцепить артикул' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
