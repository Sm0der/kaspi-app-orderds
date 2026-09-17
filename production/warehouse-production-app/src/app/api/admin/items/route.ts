import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Изделия склада: до сих пор заводились только вручную в базе (80 изделий и 83 связки
// с артикулами Kaspi на момент написания) - без этого экрана связать новый артикул можно
// было только SQL-запросом. Здесь тот же WarehouseItem, что видят этикетки и отгрузка.

export async function GET(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const items = await prisma.warehouseItem.findMany({
    include: { skus: { include: { store: true } }, warehouse: true },
    orderBy: { name: 'asc' },
  });

  // Код себестоимости - как и в списке для этикеток (labels/items/route.ts): своя таблица
  // технолога живёт в базе заказов, у Prisma склада её в схеме нет, поэтому сырой запрос.
  const costCodes = await prisma.$queryRaw<{ sku: string; code: string }[]>`
    SELECT p.sku, cp.code
    FROM products p
    JOIN cost_products cp ON cp.id = p.cost_product_id
    WHERE cp.code IS NOT NULL`;
  const codeBySku = new Map(costCodes.map((row) => [row.sku, row.code]));

  const warehouses = await prisma.warehouse.findMany({ orderBy: { name: 'asc' } });

  return NextResponse.json({
    success: true,
    data: {
      items: items.map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        imageUrl: item.imageUrl,
        boxesPerUnit: item.boxesPerUnit,
        quantityOnHand: item.quantityOnHand,
        warehouseId: item.warehouseId,
        warehouseName: item.warehouse?.name ?? null,
        skus: item.skus.map((link) => ({
          id: link.id,
          sku: link.sku,
          storeId: link.storeId,
          storeName: link.store.name,
          costCode: codeBySku.get(link.sku) ?? null,
        })),
      })),
      warehouses,
    },
  } as ApiResponse<unknown>);
}

export async function POST(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const code = String(body.code || '').trim();
    const name = String(body.name || '').trim();
    const boxesPerUnit = Number(body.boxesPerUnit) || 1;
    const warehouseId = body.warehouseId ? String(body.warehouseId) : null;
    const imageUrl = body.imageUrl ? String(body.imageUrl).trim() : null;

    if (code.length < 2) return bad('Укажите код изделия');
    if (name.length < 2) return bad('Укажите название изделия');
    if (boxesPerUnit < 1) return bad('Коробок в 1 штуке должно быть не меньше 1');

    const item = await prisma.warehouseItem.create({
      data: { code, name, boxesPerUnit, warehouseId, imageUrl },
    });

    return NextResponse.json({ success: true, data: item } as ApiResponse<unknown>, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return bad('Изделие с таким кодом уже есть');
    }
    console.error('Create warehouse item error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось создать изделие' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
