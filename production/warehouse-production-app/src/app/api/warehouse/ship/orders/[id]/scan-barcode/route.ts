import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { loadOrderForPicking, isFullyPicked } from '@/lib/orders';
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
    const { barcodeValue } = await request.json();

    if (!Number.isInteger(orderId)) {
      return NextResponse.json(
        { success: false, error: 'Некорректный номер заказа' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    if (!barcodeValue) {
      return NextResponse.json(
        { success: false, error: 'Укажите штрихкод' } as ApiResponse<null>,
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
    if (order.status !== 'BLOCKED') {
      return NextResponse.json(
        {
          success: false,
          error: `Заказ в статусе «${ORDER_PICKING_STATUS_LABELS[order.status] || order.status}», сканирование недоступно`,
        } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const barcode = await prisma.barcode.findUnique({
      where: { barcodeValue },
      include: { warehouseItem: true },
    });

    if (!barcode) {
      return NextResponse.json(
        { success: false, error: 'Штрихкод не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    // Штрихкод указывает на изделие, а позиция заказа - на артикул Kaspi. Сходятся они
    // через warehouse_item_skus: один и тот же шкаф в заказе может стоять под любым из
    // своих артикулов, а на складе он один.
    const line = order.lines.find((candidate) => candidate.warehouseItemId === barcode.warehouseItemId);

    if (!line) {
      const knownSku = order.unmapped.length
        ? ` В заказе есть позиции без привязки к изделию: ${order.unmapped.join(', ')}.`
        : '';
      return NextResponse.json(
        {
          success: false,
          error: `Изделие «${barcode.warehouseItem.name}» не входит в этот заказ.${knownSku}`,
        } as ApiResponse<null>,
        { status: 400 }
      );
    }

    if (line.quantityPicked >= line.quantityRequired) {
      return NextResponse.json(
        { success: false, error: `Уже собрано ${line.quantityRequired} шт. этого изделия` } as ApiResponse<null>,
        { status: 400 }
      );
    }

    if (!barcode.warehouseItem.warehouseId) {
      return NextResponse.json(
        {
          success: false,
          error: `У изделия «${barcode.warehouseItem.name}» не указан склад — движение записать некуда`,
        } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Всё ниже - одной транзакцией, чтобы одна физическая единица не ушла в два заказа
    // при одновременном сканировании.
    let orderComplete = false;
    try {
      await prisma.$transaction(async (tx) => {
        // Занимаем конкретную единицу: получится только если она ещё на складе.
        // Именно это делает правило «один штрихкод - один заказ» настоящим.
        const claim = await tx.barcode.updateMany({
          where: { id: barcode.id, status: 'IN_STOCK' },
          data: { status: 'IN_ORDER', updatedAt: new Date() },
        });
        if (claim.count === 0) throw new Error('BARCODE_ALREADY_USED');

        await tx.orderItemPicking.upsert({
          where: { orderItemId: line.orderItemId },
          create: { orderItemId: line.orderItemId, quantityPicked: 0 },
          update: {},
        });

        // Инкремент со сторожем на количество: два одновременных скана не проскочат
        // мимо проверки выше, потому что здесь совпадёт только один.
        const picked = await tx.orderItemPicking.updateMany({
          where: { orderItemId: line.orderItemId, quantityPicked: { lt: line.quantityRequired } },
          data: { quantityPicked: { increment: 1 }, updatedAt: new Date() },
        });
        if (picked.count === 0) throw new Error('OVER_PICKED');

        await tx.warehouseMovement.create({
          data: {
            type: 'OUTBOUND',
            barcodeId: barcode.id,
            warehouseId: barcode.warehouseItem.warehouseId!,
            orderId,
            staffId: payload.userId,
            quantity: 1,
            recordedAt: new Date(),
          },
        });

        const fresh = await loadOrderForPicking(orderId);
        orderComplete = !!fresh && isFullyPicked(fresh.lines);

        if (orderComplete) {
          await tx.orderPicking.update({
            where: { orderId },
            data: { status: 'READY', updatedAt: new Date() },
          });
        }
      });
    } catch (txError: any) {
      if (txError.message === 'BARCODE_ALREADY_USED') {
        return NextResponse.json(
          { success: false, error: 'Этот штрихкод уже отсканирован (в этом или другом заказе)' } as ApiResponse<null>,
          { status: 409 }
        );
      }
      if (txError.message === 'OVER_PICKED') {
        return NextResponse.json(
          { success: false, error: `Уже собрано ${line.quantityRequired} шт. этого изделия` } as ApiResponse<null>,
          { status: 409 }
        );
      }
      throw txError;
    }

    const after = await prisma.orderItemPicking.findUniqueOrThrow({
      where: { orderItemId: line.orderItemId },
    });
    const left = line.quantityRequired - after.quantityPicked;

    return NextResponse.json(
      {
        success: true,
        data: {
          barcode: barcodeValue,
          item: { id: barcode.warehouseItem.id, code: barcode.warehouseItem.code, name: barcode.warehouseItem.name },
          picked: after.quantityPicked,
          required: line.quantityRequired,
          orderComplete,
          message: orderComplete
            ? 'Сборка заказа завершена! Готов к отгрузке.'
            : `Осталось собрать ещё ${left} шт.`,
        },
      } as ApiResponse<any>,
      { status: 200 }
    );
  } catch (error) {
    console.error('Scan barcode error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
