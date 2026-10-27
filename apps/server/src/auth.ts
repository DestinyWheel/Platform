import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '@platform/sdk';

const SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signToken(user: AuthUser): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ sub: user.id, name: user.name, iat: Date.now() }));
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string | undefined | null): AuthUser | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      sub?: string;
      name?: string;
      iat?: number;
    };
    if (!payload.sub || !payload.name) return null;
    if (typeof payload.iat === 'number' && Date.now() - payload.iat > MAX_AGE_MS) return null;
    return { id: payload.sub, name: payload.name };
  } catch {
    return null;
  }
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}
