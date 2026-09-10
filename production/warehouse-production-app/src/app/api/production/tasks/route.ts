import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { tasksForWorkshop } from '@/lib/production';
import { ApiResponse } from '@/types';

// Задачи «моего цеха». Цех берём из учётной записи, а не из запроса: рабочий не должен
// уметь заглянуть в чужой цех, подставив другой id. Исключение - администратор, у которого
// своего цеха нет: ему цех выбирается вручную, иначе страницу нечем показать.
export async function GET(request: NextRequest) {
  const auth = await guard(request, 'production');
  if (!auth.ok) return auth.response;

  try {
    const me = await prisma.productionUser.findUnique({
      where: { id: auth.user.userId },
      select: { workshopId: true },
    });

    const asked = request.nextUrl.searchParams.get('workshopId');
    const workshopId = auth.user.role === 'ADMIN' ? asked || me?.workshopId || null : me?.workshopId || null;

    const workshops =
      auth.user.role === 'ADMIN'
        ? await prisma.workshop.findMany({ orderBy: { orderSequence: 'asc' } })
        : [];

    if (!workshopId) {
      return NextResponse.json({
        success: true,
        data: { workshop: null, tasks: [], workshops },
      } as ApiResponse<unknown>);
    }

    const [workshop, tasks] = await Promise.all([
      prisma.workshop.findUnique({ where: { id: workshopId } }),
      tasksForWorkshop(workshopId),
    ]);

    return NextResponse.json({ success: true, data: { workshop, tasks, workshops } } as ApiResponse<unknown>);
  } catch (error) {
    console.error('Workshop tasks error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить задачи цеха' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
