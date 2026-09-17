import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { ApiResponse } from '@/types';

type Params = { params: Promise<{ id: string; skuId: string }> };

// DELETE /api/admin/items/:id/skus/:skuId - отвязать артикул (изделие остаётся)
export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id, skuId } = await params;

  try {
    const link = await prisma.warehouseItemSku.findUnique({ where: { id: Number(skuId) } });
    if (!link || link.warehouseItemId !== id) {
      return NextResponse.json({ success: false, error: 'Связь не найдена' } as ApiResponse<null>, { status: 404 });
    }

    await prisma.warehouseItemSku.delete({ where: { id: Number(skuId) } });
    return NextResponse.json({ success: true, data: { id: Number(skuId) } } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json({ success: false, error: 'Связь не найдена' } as ApiResponse<null>, { status: 404 });
    }
    console.error('Unlink SKU error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось отвязать артикул' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
