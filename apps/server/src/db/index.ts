import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PgliteDb } from './pglite.js';
import { PgDb } from './pg.js';
import type { Db } from './types.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const MIGRATIONS = [
  { version: 1, file: 'schema.sql' },
  { version: 2, file: '002_plugins.sql' },
  { version: 3, file: '003_social.sql' },
  { version: 4, file: '004_ratings.sql' },
];

export interface DbOptions {
  /** PGlite 数据目录（仅本地模式用） */
  dataDir?: string;
}

/**
 * 有 DATABASE_URL 就走真 Postgres；否则用 PGlite 落在 .data/pg。
 * 两者 SQL 完全一致，所以本地开发和生产跑的是同一套代码路径。
 */
export async function createDb(options: DbOptions = {}): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const db = new PgDb(url);
    await db.exec('SELECT 1');
    return db;
  }

  const dataDir = path.resolve(
    options.dataDir ?? process.env.PGDATA ?? path.join(REPO_ROOT, '.data', 'pg'),
  );
  mkdirSync(dataDir, { recursive: true });

  const client = new PGlite(dataDir);
  await client.waitReady;
  return new PgliteDb(client);
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version integer PRIMARY KEY,
       applied_at bigint NOT NULL
     )`,
  );

  const rows = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => Number(row.version)));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const sql = await readFile(new URL(`./${migration.file}`, import.meta.url), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.execute('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        Date.now(),
      ]);
    });
  }
}

export type { Db } from './types.js';
