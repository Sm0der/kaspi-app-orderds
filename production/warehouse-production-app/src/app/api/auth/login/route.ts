import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from '@/lib/password';
import { signToken } from '@/lib/jwt';
import { ApiResponse, AuthResponse } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Введите email и пароль' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Почта - это логин, и вводят его на складе со сканера или планшета, где легко
    // приезжает заглавная первая буква. Храним и ищем в нижнем регистре.
    const user = await prisma.productionUser.findUnique({
      where: { email: String(email).trim().toLowerCase() },
    });

    if (!user || !user.isActive) {
      return NextResponse.json(
        { success: false, error: 'Неверный email или пароль' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      return NextResponse.json(
        { success: false, error: 'Неверный email или пароль' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const token = await signToken(user);

    const response: AuthResponse = {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role as any,
        workshopId: user.workshopId || undefined,
        warehouseId: user.warehouseId || undefined,
        storeId: user.storeId ?? undefined,
        isActive: user.isActive,
        mustChangePassword: user.mustChangePassword,
        createdAt: user.createdAt,
      },
      token,
    };

    return NextResponse.json(
      { success: true, data: response } as ApiResponse<AuthResponse>,
      { status: 200 }
    );
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { success: false, error: 'Внутренняя ошибка сервера' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
