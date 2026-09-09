import { NextRequest, NextResponse } from 'next/server';
import { extractToken, verifyToken } from '@/lib/jwt';
import { loadOrdersForPicking } from '@/lib/orders';
import { ApiResponse } from '@/types';

export async function GET(request: NextRequest) {
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

    const orders = await loadOrdersForPicking();

    return NextResponse.json(
      { success: true, data: orders } as ApiResponse<typeof orders>,
      { status: 200 }
    );
  } catch (error) {
    console.error('Get orders error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
