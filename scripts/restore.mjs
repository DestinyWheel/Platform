/**
 * 从备份文件恢复。
 *
 * 用法：pnpm tsx scripts/restore.mjs <备份.json.gz> [--data-dir <目录>]
 *
 * ⚠️ 会先清空目标库里对应的表再导入，属于破坏性操作。
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const { createDb, migrate } = await import('../apps/server/src/db/index.ts');
const { PgStore } = await import('../apps/server/src/store.ts');

const file = process.argv[2];
if (!file) {
  console.error('用法：tsx scripts/restore.mjs <备份文件.json.gz> [--data-dir <目录>]');
  process.exit(1);
}

const dataDirIndex = process.argv.indexOf('--data-dir');
const dataDir = dataDirIndex >= 0 ? process.argv[dataDirIndex + 1] : undefined;

const payload = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
if (!payload?.tables) {
  console.error('备份文件格式不对：缺少 tables 字段');
  process.exit(1);
}

console.log(`恢复 ${file}（导出于 ${new Date(payload.createdAt).toLocaleString()}）`);

const db = await createDb({ dataDir });
await migrate(db);

const store = new PgStore(db);
const counts = await store.importAll(payload.tables);

console.log('已恢复：');
for (const [table, count] of Object.entries(counts)) {
  console.log(`  ${table.padEnd(14)} ${count}`);
}

await db.close();
console.log('完成。');
