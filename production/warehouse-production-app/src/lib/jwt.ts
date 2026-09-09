import * as jose from 'jose';

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET || 'your_jwt_secret_key_change_in_production'
);

export interface AppJWTPayload extends jose.JWTPayload {
  userId: string;
  email: string;
  role: string;
}

// Narrow shape instead of the full `User` type — avoids friction between
// Prisma's `string | null` fields and the app-level `string | undefined` type.
export async function signToken(user: { id: string; email: string; role: string }): Promise<string> {
  const payload: AppJWTPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const token = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);

  return token;
}

export async function verifyToken(token: string): Promise<AppJWTPayload | null> {
  try {
    const verified = await jose.jwtVerify<AppJWTPayload>(token, secret);
    return verified.payload;
  } catch (err) {
    return null;
  }
}

export function extractToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    return parts[1];
  }
  return null;
}
