/** 数据库抽象：PGlite（本地零配置）与 pg（生产 Postgres）共用同一套 SQL。 */
export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** 只关心影响行数时用它（CAS 判断就靠它） */
  execute(sql: string, params?: unknown[]): Promise<number>;
  /** 多语句 DDL / 迁移 */
  exec(sql: string): Promise<void>;
}

export interface Db extends Tx {
  readonly kind: 'pglite' | 'pg';
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
