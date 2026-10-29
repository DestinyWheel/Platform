/**
 * 令牌桶限流。
 *
 * 单实例内存实现；多实例时换成 Redis（接口不变）。
 * 桶会定时清理，避免被大量临时 IP 撑爆内存。
 */
export interface LimitResult {
  ok: boolean;
  retryAfterMs: number;
}

/** 超限时直接抛这个，由统一的错误处理器转成 429 */
export class RateLimitExceeded extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('请求太频繁了，请稍后再试');
    this.name = 'RateLimitExceeded';
  }
}

export function checkLimit(result: LimitResult): void {
  if (!result.ok) throw new RateLimitExceeded(result.retryAfterMs);
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, cost = 1): LimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };

    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(key, bucket);
      return { ok: true, retryAfterMs: 0 };
    }

    this.buckets.set(key, bucket);
    const missing = cost - bucket.tokens;
    return { ok: false, retryAfterMs: Math.ceil((missing / this.refillPerSecond) * 1000) };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 清掉长时间没动过的桶 */
  sweep(maxIdleMs = 10 * 60_000): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > maxIdleMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** 把一组限流规则打成一个方便调用的集合 */
export class Limiters {
  /** 登录：按 IP，防撞库/刷账号 */
  readonly login = new RateLimiter(10, 10 / 60);
  /** 建桌：按用户 */
  readonly createTable = new RateLimiter(20, 20 / 60);
  /** 聊天：按用户，1 秒 1 条、允许 3 条突发 */
  readonly chat = new RateLimiter(3, 1);
  /** 游戏动作：按用户，每秒 10 次、允许 20 次突发 */
  readonly action = new RateLimiter(20, 10);
  /** 插件上传：按用户，很贵，限得很死 */
  readonly upload = new RateLimiter(5, 5 / 60);

  sweep(): void {
    for (const limiter of [this.login, this.createTable, this.chat, this.action, this.upload]) {
      limiter.sweep();
    }
  }
}
