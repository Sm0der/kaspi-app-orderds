import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { hashPassword } from '@/lib/password';
import { isRole, ROLES_NEEDING_WORKSHOP, Role } from '@/lib/roles';
import { ApiResponse } from '@/types';

// Учётные записи заводятся здесь, а не в панели Supabase: людей у склада много
// (упаковщики, цеха, кладовщики), заводить каждого в чужом кабинете неудобно, а рабочему
// у сканера почта нужна только как логин.

const MIN_PASSWORD = 8;

const publicFields = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  workshopId: true,
  warehouseId: true,
  isActive: true,
  mustChangePassword: true,
  createdAt: true,
} satisfies Prisma.ProductionUserSelect;

export async function GET(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const [users, workshops] = await Promise.all([
    prisma.productionUser.findMany({ select: publicFields, orderBy: [{ role: 'asc' }, { fullName: 'asc' }] }),
    prisma.workshop.findMany({ orderBy: { orderSequence: 'asc' } }),
  ]);

  return NextResponse.json({ success: true, data: { users, workshops } } as ApiResponse<unknown>);
}

export async function POST(request: NextRequest) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const email = String(body.email || '').trim().toLowerCase();
    const fullName = String(body.fullName || '').trim();
    const password = String(body.password || '');
    const role = body.role;
    const workshopId = body.workshopId ? String(body.workshopId) : null;

    const problem = validate({ email, fullName, password, role, workshopId });
    if (problem) {
      return NextResponse.json({ success: false, error: problem } as ApiResponse<null>, { status: 400 });
    }

    const user = await prisma.productionUser.create({
      data: {
        email,
        fullName,
        role: role as Role,
        workshopId,
        passwordHash: await hashPassword(password),
        // Пароль придумал администратор, значит его знает не только владелец учётки
        mustChangePassword: true,
      },
      select: publicFields,
    });

    return NextResponse.json({ success: true, data: user } as ApiResponse<unknown>, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        { success: false, error: 'Такая почта уже занята' } as ApiResponse<null>,
        { status: 409 }
      );
    }
    console.error('Create user error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось создать учётную запись' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

export function validate(input: {
  email: string;
  fullName: string;
  password: string;
  role: unknown;
  workshopId: string | null;
}): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) return 'Нужна корректная почта - она же логин';
  if (input.fullName.length < 2) return 'Укажите имя сотрудника';
  if (input.password.length < MIN_PASSWORD) return `Пароль короче ${MIN_PASSWORD} символов`;
  if (!isRole(input.role)) return 'Неизвестная роль';
  if (ROLES_NEEDING_WORKSHOP.includes(input.role) && !input.workshopId) return 'Для роли цеха выберите цех';
  return null;
}
