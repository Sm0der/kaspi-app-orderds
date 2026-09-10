import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/guard';
import { hashPassword, verifyPassword } from '@/lib/password';
import { ApiResponse } from '@/types';

const MIN_PASSWORD = 8;

// Смена собственного пароля. Доступна любой роли: пароли, выданные администратором,
// временные, и пока человек не сменит свой, интерфейс не пускает его дальше.
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  try {
    const { currentPassword, newPassword } = await request.json();

    if (String(newPassword || '').length < MIN_PASSWORD) {
      return bad(`Новый пароль короче ${MIN_PASSWORD} символов`);
    }

    const user = await prisma.productionUser.findUnique({ where: { id: auth.user.userId } });
    if (!user || !user.isActive) {
      return NextResponse.json(
        { success: false, error: 'Учётная запись недоступна' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    // Текущий пароль спрашиваем даже у того, кому его выдал администратор: иначе забытый
    // на складе открытый сеанс позволяет любому прохожему запереть учётку на своём пароле.
    if (!(await verifyPassword(String(currentPassword || ''), user.passwordHash))) {
      return bad('Текущий пароль введён неверно');
    }

    if (await verifyPassword(String(newPassword), user.passwordHash)) {
      return bad('Новый пароль совпадает со старым');
    }

    await prisma.productionUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(String(newPassword)),
        mustChangePassword: false,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, data: { ok: true } } as ApiResponse<unknown>);
  } catch (error) {
    console.error('Change password error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сменить пароль' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}
