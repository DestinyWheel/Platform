import { PGlite } from '@electric-sql/pglite';
import type { Db, Tx } from './types.js';

function wrap(client: PGlite): Tx {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await client.query<T>(sql, params as unknown[] | undefined);
      return (result.rows ?? []) as T[];
    },
    async execute(sql: string, params?: unknown[]): Promise<number> {
      const result = await client.query(sql, params as unknown[] | undefined);
      return result.affectedRows ?? 0;
    },
    async exec(sql: string): Promise<void> {
      await client.exec(sql);
    },
  };
}

/** 本地/测试用：嵌入式 Postgres（WASM），数据落在目录里，重启不丢。 */
export class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  private readonly base: Tx;

  constructor(private readonly client: PGlite) {
    this.base = wrap(client);
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.base.query<T>(sql, params);
  }

  execute(sql: string, params?: unknown[]): Promise<number> {
    return this.base.execute(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.base.exec(sql);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => fn(wrap(tx as unknown as PGlite))) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
