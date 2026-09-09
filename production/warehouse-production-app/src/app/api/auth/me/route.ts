import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { extractToken, verifyToken } from '@/lib/jwt';
import { ApiResponse } from '@/types';

export async function GET(request: NextRequest) {
  try {
    const token = extractToken(request.headers.get('Authorization') || '');

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Токен не передан' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json(
        { success: false, error: 'Недействительный токен' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const user = await prisma.productionUser.findUnique({
      where: { id: payload.userId },
    });

    if (!user || !user.isActive) {
      return NextResponse.json(
        { success: false, error: 'Пользователь не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          workshopId: user.workshopId,
          warehouseId: user.warehouseId,
          storeId: user.storeId,
          isActive: user.isActive,
          createdAt: user.createdAt,
        },
      } as ApiResponse<any>,
      { status: 200 }
    );
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
