import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';
import { BARCODE_STATUS_LABELS } from '@/lib/labels';

export async function POST(request: NextRequest) {
  try {
    const auth = await guard(request, 'receive');
    if (!auth.ok) return auth.response;
    const payload = auth.user;

    const body = await request.json();
    const { barcodeValue } = body;

    if (!barcodeValue) {
      return NextResponse.json(
        { success: false, error: 'Укажите штрихкод' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Find the barcode
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

    if (barcode.status !== 'IN_STOCK') {
      return NextResponse.json(
        { success: false, error: `Статус штрихкода: ${BARCODE_STATUS_LABELS[barcode.status] || barcode.status}` } as ApiResponse<null>,
        { status: 400 }
      );
    }

    if (!barcode.warehouseItem.warehouseId) {
      return NextResponse.json(
        {
          success: false,
          error: `У изделия «${barcode.warehouseItem.name}» не указан склад — приход записать некуда`,
        } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Create warehouse movement (inbound)
    const movement = await prisma.warehouseMovement.create({
      data: {
        type: 'INBOUND',
        barcodeId: barcode.id,
        warehouseId: barcode.warehouseItem.warehouseId!,
        staffId: payload.userId,
        quantity: 1,
        recordedAt: new Date(),
      },
      include: {
        barcode: {
          include: { warehouseItem: true },
        },
      },
    });

    // Update barcode status
    await prisma.barcode.update({
      where: { id: barcode.id },
      data: { status: 'IN_STOCK' },
    });

    // Update quantity on hand
    await prisma.warehouseItem.update({
      where: { id: barcode.warehouseItemId },
      data: { quantityOnHand: { increment: 1 } },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          movementId: movement.id,
          barcode: barcode.barcodeValue,
          item: {
            id: barcode.warehouseItem.id,
            code: barcode.warehouseItem.code,
            name: barcode.warehouseItem.name,
          },
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
