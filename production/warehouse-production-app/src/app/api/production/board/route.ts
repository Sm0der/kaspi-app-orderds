import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { boardTasks } from '@/lib/production';
import { ApiResponse } from '@/types';

const MAX_QUANTITY = 999;

// Доска производства: что в каком цехе стоит прямо сейчас. Отсюда же задачи и запускаются -
// отдельной страницы «планирование» нет, планирует тот же человек, который смотрит доску.
export async function GET(request: NextRequest) {
  const auth = await guard(request, 'productionStats');
  if (!auth.ok) return auth.response;

  try {
    const [tasks, workshops, items] = await Promise.all([
      boardTasks(),
      prisma.workshop.findMany({ orderBy: { orderSequence: 'asc' } }),
      prisma.warehouseItem.findMany({
        select: { id: true, code: true, name: true, imageUrl: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return NextResponse.json({ success: true, data: { tasks, workshops, items } } as ApiResponse<unknown>);
  } catch (error) {
    console.error('Production board error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить доску' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await guard(request, 'productionStats');
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const quantity = Number(body.quantity);
    const warehouseItemId = String(body.warehouseItemId || '');

    if (!warehouseItemId) return bad('Выберите изделие');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return bad(`Количество - целое число от 1 до ${MAX_QUANTITY}`);
    }

    const item = await prisma.warehouseItem.findUnique({ where: { id: warehouseItemId } });
    if (!item) return bad('Изделие не найдено');

    // Первый цех очереди. Если цехов нет вообще, запускать некуда - честно говорим об этом,
    // а не создаём задачу-сироту без цеха.
    const first = await prisma.workshop.findFirst({ orderBy: { orderSequence: 'asc' } });
    if (!first) return bad('Не заведён ни один цех');

    const task = await prisma.productionItem.create({
      data: {
        warehouseItemId: item.id,
        // Имя копируем, а не берём ссылкой: изделие потом переименуют, а в истории
        // производства должно остаться то название, под которым задачу запускали
        name: item.name,
        quantity,
        currentWorkshopId: first.id,
        notes: String(body.notes || '').trim() || null,
      },
    });

    return NextResponse.json(
      { success: true, data: { id: task.id, workshop: first.name } } as ApiResponse<unknown>,
      { status: 201 }
    );
  } catch (error) {
    console.error('Create production task error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось запустить задачу' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
