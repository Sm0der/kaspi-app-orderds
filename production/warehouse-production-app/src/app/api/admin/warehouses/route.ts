import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Склады (физические места хранения) - до сих пор заводились только SQL-вставкой, своей
// формы не было вовсе (см. заготовку /api/admin/warehouses в старом коде - была пустой).
export async function GET(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const warehouses = await prisma.warehouse.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { warehouseItems: true, users: true } } },
  });

  return NextResponse.json({
    success: true,
    data: warehouses.map((w) => ({
      id: w.id,
      name: w.name,
      location: w.location,
      itemsCount: w._count.warehouseItems,
      usersCount: w._count.users,
    })),
  } as ApiResponse<unknown>);
}

export async function POST(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const name = String(body.name || '').trim();
    const location = body.location ? String(body.location).trim() : null;
    if (name.length < 2) return bad('Укажите название склада');

    const warehouse = await prisma.warehouse.create({ data: { name, location } });
    return NextResponse.json({ success: true, data: warehouse } as ApiResponse<unknown>, { status: 201 });
  } catch (error) {
    console.error('Create warehouse error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось создать склад' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
