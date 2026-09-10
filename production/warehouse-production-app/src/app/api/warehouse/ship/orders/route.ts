import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/guard';
import { loadOrdersForPicking } from '@/lib/orders';
import { ApiResponse } from '@/types';

export async function GET(request: NextRequest) {
  try {
    const auth = await guard(request, 'ship');
    if (!auth.ok) return auth.response;
    const payload = auth.user;

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
