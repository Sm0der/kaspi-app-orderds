import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

// Отложить застрявшую задачу и вернуть её в работу. Право мастера и владельца: рабочий
// иначе откладывал бы всё, что не хочется делать сегодня.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await guard(request, 'productionStats');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const body = await request.json();
    const data: Prisma.ProductionItemUpdateInput = { updatedAt: new Date() };

    if (body.status !== undefined) {
      if (!['PENDING', 'IN_PROGRESS', 'ON_HOLD'].includes(body.status)) {
        return bad('Такого состояния нет');
      }
      data.status = body.status;
    }
    if (body.notes !== undefined) {
      data.notes = String(body.notes).trim() || null;
    }

    const task = await prisma.productionItem.update({
      where: { id },
      data,
      select: { id: true, status: true, notes: true },
    });

    return NextResponse.json({ success: true, data: task } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json(
        { success: false, error: 'Задача не найдена' } as ApiResponse<null>,
        { status: 404 }
      );
    }
    console.error('Update production task error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось изменить задачу' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

// Снять задачу целиком - когда её завели по ошибке. Уже отчитанную выработку не стираем:
// это история труда, по ней считают сделанное. Такую задачу можно только отложить.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await guard(request, 'productionStats');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const operations = await prisma.workshopOperation.count({ where: { productionItemId: id } });
  if (operations > 0) {
    return bad('По задаче уже есть выработка - её можно отложить, но не удалить');
  }

  try {
    await prisma.productionItem.delete({ where: { id } });
    return NextResponse.json({ success: true, data: { id } } as ApiResponse<unknown>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Задача не найдена' } as ApiResponse<null>,
      { status: 404 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
