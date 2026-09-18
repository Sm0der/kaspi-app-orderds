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
    const data: Prisma.WorkshopUpdateInput = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 2) return bad('Укажите название цеха');
      data.name = name;
    }
    if (body.description !== undefined) {
      data.description = String(body.description).trim() || null;
    }
    if (body.orderSequence !== undefined) {
      const orderSequence = Number(body.orderSequence);
      if (!Number.isInteger(orderSequence) || orderSequence < 1) return bad('Номер очереди - целое число от 1');
      data.orderSequence = orderSequence;
    }
    if (Object.keys(data).length === 0) return bad('Нечего менять');

    const workshop = await prisma.workshop.update({ where: { id }, data });
    return NextResponse.json({ success: true, data: workshop } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') return bad('Цех не найден');
      if (error.code === 'P2002') return bad('Такой номер очереди уже занят другим цехом');
    }
    console.error('Update workshop error:', error);
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
    await prisma.workshop.delete({ where: { id } });
    return NextResponse.json({ success: true, data: { id } } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') return bad('Цех не найден');
      if (error.code === 'P2003') {
        return bad('В цехе ещё есть сотрудники или изделия в работе - сначала перенесите их в другой цех');
      }
    }
    console.error('Delete workshop error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось удалить цех' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
