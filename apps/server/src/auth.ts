import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 会话令牌：自签 JWT（HS256）。
 *
 * 载荷里有 `ver`（令牌版本）。库里 users.token_version 一变，旧令牌立刻失效——
 * 改密码、退出登录、"退出所有设备"都靠它。没有这一位的话，"退出登录"只是前端删了个
 * localStorage，被抄走的令牌还能用到过期为止。
 */
const SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
/** 不勾"记住我"：12 小时，够一晚上的桌游局 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
/** 勾了：30 天，但改密码/登出仍会立刻作废 */
const REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/** 老令牌没有 exp，按老的 7 天兜底，别让升级把人踢下线 */
const LEGACY_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface TokenUser {
  id: string;
  name: string;
  /** 令牌版本；老令牌没有这一位，按 0 处理 */
  ver: number;
}

export interface SignOptions {
  remember?: boolean;
  tokenVersion?: number;
}

/** 认证域的错误：带 code 和 HTTP 状态码，由统一错误处理器翻译 */
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(header: string, body: string): string {
  return createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
}

export function signToken(user: { id: string; name: string }, options: SignOptions = {}): string {
  const now = Date.now();
  const ttl = options.remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      sub: user.id,
      name: user.name,
      ver: options.tokenVersion ?? 0,
      iat: now,
      exp: now + ttl,
    }),
  );
  return `${header}.${body}.${sign(header, body)}`;
}

export function verifyToken(token: string | undefined | null): TokenUser | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts as [string, string, string];
  const expected = sign(header, body);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      sub?: string;
      name?: string;
      ver?: number;
      iat?: number;
      exp?: number;
    };
    if (!payload.sub || !payload.name) return null;

    const now = Date.now();
    // 新令牌按 exp 判；老令牌只有 iat，按 7 天兜底
    const deadline =
      typeof payload.exp === 'number'
        ? payload.exp
        : typeof payload.iat === 'number'
          ? payload.iat + LEGACY_TTL_MS
          : 0;
    if (deadline <= now) return null;

    return {
      id: payload.sub,
      name: payload.name,
      ver: typeof payload.ver === 'number' ? payload.ver : 0,
    };
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
