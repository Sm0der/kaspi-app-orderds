import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Поиск кодов технолога (cost_products, SH-4001) для ручной привязки к изделию склада.
// Таблица технолога живёт в базе заказов, у Prisma склада её в схеме нет - сырой запрос,
// как и в admin/skus. Уже занятые коды не исключаем, а показываем, чем заняты: владелец
// связывает вручную и вправе перевесить код на другое изделие сам.
export async function GET(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const q = (request.nextUrl.searchParams.get('q') || '').trim();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);

  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const word of words) {
    params.push(`%${word}%`);
    conditions.push(`(cp.name ILIKE $${params.length} OR cp.code ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await prisma.$queryRawUnsafe<{ id: number; code: string | null; name: string }[]>(
    `SELECT cp.id, cp.code, cp.name FROM cost_products cp ${where} ORDER BY cp.code NULLS LAST, cp.name LIMIT 40`,
    ...params
  );

  const ids = rows.map((r) => r.id);
  const usedBy = ids.length
    ? await prisma.warehouseItem.findMany({
        where: { costProductId: { in: ids } },
        select: { id: true, name: true, costProductId: true },
      })
    : [];
  const usedById = new Map(usedBy.map((item) => [item.costProductId, item]));

  return NextResponse.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      usedByItemId: usedById.get(row.id)?.id ?? null,
      usedByItemName: usedById.get(row.id)?.name ?? null,
    })),
  } as ApiResponse<unknown>);
}
