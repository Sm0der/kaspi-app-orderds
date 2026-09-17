import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Поиск артикулов Kaspi для привязки к изделию склада. Каталог товаров (products) -
// таблица базы заказов, у Prisma склада её в схеме нет (см. ту же оговорку в
// labels/items/route.ts), поэтому сырой запрос вместо prisma.product.findMany.
//
// Уже привязанные исключаем - двойная привязка одного SKU к двум изделиям испортила бы
// печать этикеток и приёмку: сканер не смог бы решить, какое из двух изделий это.
export async function GET(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const q = (request.nextUrl.searchParams.get('q') || '').trim();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);

  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const word of words) {
    params.push(`%${word}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const rows = await prisma.$queryRawUnsafe<
    { sku: string; name: string; store_id: number; store_name: string }[]
  >(
    `SELECT p.sku, p.name, p.store_id, s.name AS store_name
     FROM products p
     JOIN stores s ON s.id = p.store_id
     WHERE NOT EXISTS (
       SELECT 1 FROM warehouse_item_skus wis WHERE wis.store_id = p.store_id AND wis.sku = p.sku
     ) ${where}
     ORDER BY p.name LIMIT 40`,
    ...params
  );

  return NextResponse.json({
    success: true,
    data: rows.map((row) => ({ sku: row.sku, name: row.name, storeId: row.store_id, storeName: row.store_name })),
  } as ApiResponse<unknown>);
}
