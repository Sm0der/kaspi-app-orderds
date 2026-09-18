import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Цехи - до сих пор заводились только руками в базе (SETUP_GUIDE.md), формы не было.
// orderSequence решает, в каком порядке цехи стоят в очереди производства (см.
// production/board): его владелец должен видеть и уметь переставить.
export async function GET(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const workshops = await prisma.workshop.findMany({
    orderBy: { orderSequence: 'asc' },
    include: { _count: { select: { users: true, productionItems: true } } },
  });

  return NextResponse.json({
    success: true,
    data: workshops.map((w) => ({
      id: w.id,
      name: w.name,
      orderSequence: w.orderSequence,
      description: w.description,
      usersCount: w._count.users,
      itemsCount: w._count.productionItems,
    })),
  } as ApiResponse<unknown>);
}

export async function POST(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const name = String(body.name || '').trim();
    const description = body.description ? String(body.description).trim() : null;
    if (name.length < 2) return bad('Укажите название цеха');

    // Следующий свободный номер очереди, если владелец его не задал - цех обычно
    // добавляют в конец, а не куда-то в середину уже расставленной последовательности
    let orderSequence = Number(body.orderSequence);
    if (!Number.isInteger(orderSequence) || orderSequence < 1) {
      const last = await prisma.workshop.aggregate({ _max: { orderSequence: true } });
      orderSequence = (last._max.orderSequence ?? 0) + 1;
    }

    const workshop = await prisma.workshop.create({ data: { name, description, orderSequence } });
    return NextResponse.json({ success: true, data: workshop } as ApiResponse<unknown>, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return bad('Такой номер очереди уже занят другим цехом');
    }
    console.error('Create workshop error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось создать цех' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
