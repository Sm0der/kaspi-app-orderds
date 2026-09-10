import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { loadOrderForPicking } from '@/lib/orders';
import { ApiResponse } from '@/types';
import { ORDER_PICKING_STATUS_LABELS } from '@/lib/labels';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guard(request, 'ship');
    if (!auth.ok) return auth.response;
    const payload = auth.user;

    const orderId = Number((await params).id);
    if (!Number.isInteger(orderId)) {
      return NextResponse.json(
        { success: false, error: 'Некорректный номер заказа' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Переход READY -> SHIPPED занимаем атомарно, чтобы он не отработал дважды и
    // не списал остатки повторно.
    const claim = await prisma.orderPicking.updateMany({
      where: { orderId, status: 'READY' },
      data: { status: 'SHIPPED', completedAt: new Date(), updatedAt: new Date() },
    });

    if (claim.count === 0) {
      const current = await prisma.orderPicking.findUnique({ where: { orderId } });
      if (!current) {
        return NextResponse.json(
          { success: false, error: 'Заказ ещё не брали в сборку' } as ApiResponse<null>,
          { status: 404 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: `Заказ должен быть готов к отгрузке, сейчас: «${ORDER_PICKING_STATUS_LABELS[current.status] || current.status}»`,
        } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Физические единицы помечаем отгруженными и снимаем с остатка
    const movements = await prisma.warehouseMovement.findMany({
      where: { orderId, type: 'OUTBOUND' },
      include: { barcode: true },
    });

    await prisma.$transaction(
      movements.flatMap((movement) => [
        prisma.barcode.update({
          where: { id: movement.barcodeId },
          data: { status: 'SHIPPED', updatedAt: new Date() },
        }),
        prisma.warehouseItem.update({
          where: { id: movement.barcode.warehouseItemId },
          data: { quantityOnHand: { decrement: 1 }, updatedAt: new Date() },
        }),
      ])
    );

    const order = await loadOrderForPicking(orderId);

    return NextResponse.json(
      {
        success: true,
        data: {
          orderId,
          orderCode: order?.orderCode,
          status: 'SHIPPED',
          itemsShipped: movements.length,
          message: 'Заказ отмечен как отгруженный',
        },
      } as ApiResponse<any>,
      { status: 200 }
    );
  } catch (error) {
    console.error('Complete order error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
