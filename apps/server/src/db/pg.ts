import pg from 'pg';
import type { Db, Tx } from './types.js';

// int8 默认返回字符串；我们的时间戳都是毫秒整数，直接转 number 更省事
pg.types.setTypeParser(20, (value: string) => Number(value));

export class PgDb implements Db {
  readonly kind = 'pg' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(sql, params as unknown[] | undefined);
    return result.rows as T[];
  }

  async execute(sql: string, params?: unknown[]): Promise<number> {
    const result = await this.pool.query(sql, params as unknown[] | undefined);
    return result.rowCount ?? 0;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Tx = {
        query: async <R>(sql: string, params?: unknown[]) =>
          (await client.query(sql, params as unknown[] | undefined)).rows as R[],
        execute: async (sql: string, params?: unknown[]) =>
          (await client.query(sql, params as unknown[] | undefined)).rowCount ?? 0,
        exec: async (sql: string) => {
          await client.query(sql);
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
