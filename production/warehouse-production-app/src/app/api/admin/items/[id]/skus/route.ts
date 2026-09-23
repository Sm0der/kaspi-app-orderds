import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { syncProductCostLinks } from '@/lib/costLink';
import { ApiResponse } from '@/types';

type Params = { params: Promise<{ id: string }> };

// POST /api/admin/items/:id/skus - привязать артикул Kaspi к изделию
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const body = await request.json();
    const storeId = Number(body.storeId);
    const sku = String(body.sku || '').trim();

    if (!storeId || !sku) return bad('Нужны магазин и артикул');

    const item = await prisma.warehouseItem.findUnique({ where: { id } });
    if (!item) return bad('Изделие не найдено');

    const link = await prisma.warehouseItemSku.create({
      data: { warehouseItemId: id, storeId, sku },
      include: { store: true },
    });

    // Новый артикул наследует код технолога изделия - иначе маржа по нему в «Аналитике»
    // не посчиталась бы (она читает products.cost_product_id). Привязка уже сохранена -
    // сбой здесь не должен выглядеть как "артикул не привязался".
    try {
      await syncProductCostLinks(id);
    } catch (error) {
      console.error('SKU linked but cost-link sync failed:', error);
    }

    return NextResponse.json(
      { success: true, data: { id: link.id, sku: link.sku, storeId: link.storeId, storeName: link.store.name } } as ApiResponse<unknown>,
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return bad('Этот артикул уже привязан к другому изделию');
    }
    console.error('Link SKU error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось привязать артикул' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
