import { NextRequest, NextResponse } from 'next/server';
import { extractToken, verifyToken, AppJWTPayload } from '@/lib/jwt';
import { can, Area } from '@/lib/roles';
import { ApiResponse } from '@/types';

// Проверка «кто ты и можно ли тебе сюда» для route-обработчиков. Возвращает либо готовый
// отказ, либо payload токена - так вызывающий код не может случайно продолжить работу,
// забыв проверить результат: без payload у него просто нет пользователя.
//
// Права берутся из общего справочника (src/lib/roles.ts), а не перечисляются строками в
// каждом файле: иначе новая роль требует найти все места и ни одно не пропустить.
type GuardResult =
  | { ok: true; user: AppJWTPayload }
  | { ok: false; response: NextResponse<ApiResponse<null>> };

function deny(error: string, status: number): GuardResult {
  return { ok: false, response: NextResponse.json({ success: false, error }, { status }) };
}

export async function guard(request: NextRequest, area: Area): Promise<GuardResult> {
  const token = extractToken(request.headers.get('Authorization') || '');
  if (!token) return deny('Требуется авторизация', 401);

  const user = await verifyToken(token);
  if (!user) return deny('Недействительный или истёкший токен', 401);

  if (!can(user.role, area)) return deny('Недостаточно прав', 403);

  return { ok: true, user };
}

/** То же, но без проверки раздела - когда нужен просто вошедший человек (например, смена своего пароля) */
export async function requireUser(request: NextRequest): Promise<GuardResult> {
  const token = extractToken(request.headers.get('Authorization') || '');
  if (!token) return deny('Требуется авторизация', 401);

  const user = await verifyToken(token);
  if (!user) return deny('Недействительный или истёкший токен', 401);

  return { ok: true, user };
}
