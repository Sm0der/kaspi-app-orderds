import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { recordOperation, taskById } from '@/lib/production';
import { ApiResponse } from '@/types';

// «Сделал N штук» или «N в брак». Единственное действие рабочего за смену, поэтому оно
// должно быть коротким и не спрашивать лишнего.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await guard(request, 'production');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const body = await request.json();
    const quantity = Number(body.quantity);
    const status = body.status === 'DEFECTIVE' ? 'DEFECTIVE' : 'COMPLETED';

    if (!Number.isInteger(quantity) || quantity < 1) {
      return bad('Укажите количество - целое число от 1');
    }
    if (status === 'DEFECTIVE' && !String(body.notes || '').trim()) {
      // Брак без объяснения бесполезен: через неделю никто не вспомнит, что случилось
      return bad('При браке напишите, что произошло');
    }

    const task = await taskById(id);
    if (!task) {
      return NextResponse.json(
        { success: false, error: 'Задача не найдена' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    // Отчитаться можно только за свой цех. Администратор - исключение: он единственный,
    // кто может закрыть застрявшую задачу, не переводя себя в рабочие.
    if (auth.user.role !== 'ADMIN') {
      const me = await prisma.productionUser.findUnique({
        where: { id: auth.user.userId },
        select: { workshopId: true },
      });
      if (me?.workshopId !== task.workshopId) {
        return NextResponse.json(
          { success: false, error: 'Эта задача сейчас в другом цехе' } as ApiResponse<null>,
          { status: 403 }
        );
      }
    }

    const result = await recordOperation({
      taskId: id,
      workerId: auth.user.userId,
      quantity,
      status,
      notes: body.notes,
    });

    if (!result.ok) return bad(result.error);

    return NextResponse.json({
      success: true,
      data: {
        movedTo: result.movedTo,
        finished: result.finished,
        message: result.finished
          ? 'Готово, изделие прошло все цеха'
          : result.movedTo
            ? `Готово, задача ушла в цех «${result.movedTo}»`
            : 'Записано',
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    console.error('Record operation error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось записать выработку' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
