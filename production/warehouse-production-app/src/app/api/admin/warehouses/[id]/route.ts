import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const body = await request.json();
    const data: Prisma.WarehouseUpdateInput = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 2) return bad('Укажите название склада');
      data.name = name;
    }
    if (body.location !== undefined) {
      data.location = String(body.location).trim() || null;
    }
    if (Object.keys(data).length === 0) return bad('Нечего менять');

    const warehouse = await prisma.warehouse.update({ where: { id }, data });
    return NextResponse.json({ success: true, data: warehouse } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return bad('Склад не найден');
    }
    console.error('Update warehouse error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить изменения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    await prisma.warehouse.delete({ where: { id } });
    return NextResponse.json({ success: true, data: { id } } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') return bad('Склад не найден');
      if (error.code === 'P2003') return bad('На складе ещё есть изделия или сотрудники - сначала перенесите их');
    }
    console.error('Delete warehouse error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось удалить склад' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
