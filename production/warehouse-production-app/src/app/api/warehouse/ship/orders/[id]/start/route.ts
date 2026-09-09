import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { extractToken, verifyToken } from '@/lib/jwt';
import { loadOrderForPicking } from '@/lib/orders';
import { ApiResponse } from '@/types';
import { ORDER_PICKING_STATUS_LABELS } from '@/lib/labels';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = extractToken(request.headers.get('Authorization') || '');
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Требуется авторизация' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const payload = await verifyToken(token);
    if (!payload || !['WAREHOUSE_SHIPPER', 'ADMIN'].includes(payload.role)) {
      return NextResponse.json(
        { success: false, error: 'Недостаточно прав' } as ApiResponse<null>,
        { status: 403 }
      );
    }

    const orderId = Number((await params).id);
    if (!Number.isInteger(orderId)) {
      return NextResponse.json(
        { success: false, error: 'Некорректный номер заказа' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const order = await loadOrderForPicking(orderId);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Заказ не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    // Строку состояния сборки заводим лениво: заказ создаёт синхронизация с Kaspi, и
    // знать про склад она не обязана. Первое взятие в работу - и есть момент создания.
    let claimed = 0;
    await prisma.$transaction(async (tx) => {
      await tx.orderPicking.upsert({
        where: { orderId },
        create: { orderId, status: 'NEW' },
        update: {},
      });

      // Замок: перевести в BLOCKED может только тот, кто застал заказ свободным.
      // Второй кладовщик, нажавший «собрать» одновременно, получит count = 0.
      const claim = await tx.orderPicking.updateMany({
        where: { orderId, status: { in: ['NEW', 'PICKING'] } },
        data: {
          status: 'BLOCKED',
          lockedBy: payload.userId,
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      claimed = claim.count;
    });

    if (claimed === 0) {
      const current = await prisma.orderPicking.findUnique({
        where: { orderId },
        include: { locker: true },
      });
      const busy = current?.status === 'BLOCKED';
      return NextResponse.json(
        {
          success: false,
          error: busy
            ? `Заказ уже собирает ${current?.locker?.fullName || 'другой сотрудник'}`
            : `Заказ в статусе «${ORDER_PICKING_STATUS_LABELS[current?.status || ''] || current?.status}»`,
        } as ApiResponse<null>,
        { status: 409 }
      );
    }

    const fresh = await loadOrderForPicking(orderId);

    return NextResponse.json(
      {
        success: true,
        data: {
          ...fresh,
          message: fresh?.unmapped.length
            ? `Заказ взят в сборку, но ${fresh.unmapped.length} позиц. без изделия: ${fresh.unmapped.join(', ')}`
            : 'Заказ заблокирован для сборки',
        },
      } as ApiResponse<any>,
      { status: 200 }
    );
  } catch (error) {
    console.error('Start picking error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
