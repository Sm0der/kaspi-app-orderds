import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { hashPassword } from '@/lib/password';
import { isRole, ROLES_NEEDING_WORKSHOP, Role } from '@/lib/roles';
import { ApiResponse } from '@/types';

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

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const body = await request.json();
    const data: Prisma.ProductionUserUpdateInput = {};

    if (body.fullName !== undefined) {
      const fullName = String(body.fullName).trim();
      if (fullName.length < 2) return bad('Укажите имя сотрудника');
      data.fullName = fullName;
    }

    if (body.role !== undefined) {
      if (!isRole(body.role)) return bad('Неизвестная роль');
      const role = body.role as Role;
      // Цех приходит вместе с ролью: если человека переводят из цеха в кладовщики,
      // старый цех надо снять, иначе он останется числиться за «Присадкой»
      const workshopId = body.workshopId ? String(body.workshopId) : null;
      if (ROLES_NEEDING_WORKSHOP.includes(role) && !workshopId) return bad('Для роли цеха выберите цех');
      data.role = role;
      data.workshop = workshopId ? { connect: { id: workshopId } } : { disconnect: true };
    }

    if (body.isActive !== undefined) {
      data.isActive = Boolean(body.isActive);
    }

    if (body.password !== undefined) {
      const password = String(body.password);
      if (password.length < MIN_PASSWORD) return bad(`Пароль короче ${MIN_PASSWORD} символов`);
      data.passwordHash = await hashPassword(password);
      data.mustChangePassword = true;
    }

    // Оставить систему без единого администратора - самая дорогая ошибка здесь: чинить
    // придётся руками в базе. Поэтому смену роли и отключение проверяем на этот случай.
    const losesAdmin =
      (data.role !== undefined && data.role !== 'ADMIN') || data.isActive === false;
    if (losesAdmin) {
      const target = await prisma.productionUser.findUnique({ where: { id }, select: { role: true, isActive: true } });
      if (target?.role === 'ADMIN' && target.isActive) {
        const admins = await prisma.productionUser.count({ where: { role: 'ADMIN', isActive: true } });
        if (admins <= 1) return bad('Это единственный администратор - сначала назначьте другого');
      }
    }

    if (Object.keys(data).length === 0) return bad('Нечего менять');

    data.updatedAt = new Date();
    const user = await prisma.productionUser.update({ where: { id }, data, select: publicFields });
    return NextResponse.json({ success: true, data: user } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json(
        { success: false, error: 'Учётная запись не найдена' } as ApiResponse<null>,
        { status: 404 }
      );
    }
    console.error('Update user error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить изменения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (id === auth.user.userId) return bad('Нельзя удалить самого себя');

  const target = await prisma.productionUser.findUnique({ where: { id }, select: { role: true } });
  if (!target) {
    return NextResponse.json(
      { success: false, error: 'Учётная запись не найдена' } as ApiResponse<null>,
      { status: 404 }
    );
  }

  try {
    await prisma.productionUser.delete({ where: { id } });
    return NextResponse.json({ success: true, data: { id } } as ApiResponse<unknown>);
  } catch (error) {
    // За человеком тянутся операции цеха, движения склада, партии этикеток - это история,
    // стирать её вместе с учёткой нельзя. Такого сотрудника отключают, а не удаляют.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      return bad('За сотрудником уже числятся приёмки или отгрузки - его можно только отключить');
    }
    console.error('Delete user error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось удалить учётную запись' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
