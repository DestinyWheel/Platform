import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * 密码哈希：scrypt。
 *
 * 为什么是 scrypt 而不是 bcrypt/argon2：
 * - Node 内置，不引入原生依赖（这个项目要能在 Windows 上零编译跑起来）
 * - 内存硬，GPU 撞库成本比 PBKDF2 高一个量级
 * - 参数写在哈希串里，将来调参不用迁移数据：老哈希用自己的参数校验，登录成功后可以按新参数重算
 *
 * 存储格式：`scrypt$N$r$p$salt$hash`（salt 16B，hash 32B，base64url）
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
/** scrypt 默认 maxmem 是 32MB，N=16384,r=8 需要约 16MB，留够余量 */
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC：避免同一个密码因为全角/半角、带不带组合字符而"看着一样但登不上"
    scrypt(
      password.normalize('NFKC'),
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key as Buffer)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** 校验失败一律返回 false，不区分"没设密码"和"密码错"——调用方自己决定对外怎么说 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await derive(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 密码强度校验。返回 null 表示通过，否则是给用户看的错因。
 *
 * 只在注册/改密时用，登录时不校验——否则改了规则会把老用户锁在门外。
 */
export function checkPasswordInput(password: string, name: string): string | null {
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  if (password.trim().length === 0) return '密码不能全是空格';
  if (password.normalize('NFKC').toLowerCase() === name.trim().normalize('NFKC').toLowerCase()) {
    return '密码不能和昵称一样';
  }
  // 全是一样的字符（aaaaaaaa / 11111111）
  if (new Set(password).size === 1) return '密码太简单了，换一个';
  if (WEAK.includes(password.toLowerCase())) return '这个密码太常见了，换一个';
  return null;
}

const WEAK = [
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password1',
  'passw0rd',
  'qwertyui',
  'abc12345',
  'iloveyou',
  'admin123',
  '11111111',
  '66666666',
  '88888888',
];

/**
 * 管理员重置密码时生成的临时口令。
 *
 * 12 位、去掉视觉上容易混淆的字符（0/O、1/l/I），保证念一遍就能抄对。
 * 这个口令只在重置的响应里出现一次，服务端不留明文，也不写日志。
 */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(12), (byte) => alphabet[byte % alphabet.length]).join('');
}
