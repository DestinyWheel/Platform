/**
 * 插件版本状态：列出来、启用、禁用。
 *
 * 用法：
 *   tsx scripts/plugin-status.mjs                      # 列出所有版本
 *   tsx scripts/plugin-status.mjs enable <id> [ver]    # 启用（不给版本就用最新的那个）
 *   tsx scripts/plugin-status.mjs disable <id> [ver]
 *
 * 管理后台能做同样的事，但服务起不来（或者被自己禁用了唯一的版本）时，
 * 这个脚本是最后一根绳子——**要先停服务**，PGlite 同一时间只允许一个进程打开。
 */
const { createDb, migrate } = await import('../apps/server/src/db/index.ts');
const { PgStore } = await import('../apps/server/src/store.ts');

const [action, gameId, version] = process.argv.slice(2);

const db = await createDb({ dataDir: process.env.PGDATA });
await migrate(db);
const store = new PgStore(db);

const versions = await store.listGameVersions();

if (!action) {
  for (const row of versions) {
    console.log(
      `${row.gameId}@${row.version}  ${row.status.padEnd(8)} ${row.manifest.name}  ${row.dir}`,
    );
  }
  await db.close();
  process.exit(0);
}

if (action !== 'enable' && action !== 'disable') {
  console.error('用法：plugin-status.mjs [enable|disable] <gameId> [version]');
  process.exit(1);
}
if (!gameId) {
  console.error('要给游戏 id');
  process.exit(1);
}

const candidates = versions.filter((row) => row.gameId === gameId);
if (candidates.length === 0) {
  console.error(`没有这个游戏：${gameId}`);
  process.exit(1);
}

// 没给版本：enable 用最新的（createdAt 最大），disable 用当前 active 的
const target =
  (version && candidates.find((row) => row.version === version)) ||
  (action === 'disable'
    ? candidates.find((row) => row.status === 'active')
    : candidates.sort((a, b) => b.createdAt - a.createdAt)[0]);

if (!target) {
  console.error('没找到要操作的版本');
  process.exit(1);
}

if (action === 'enable') {
  await store.setActiveVersion(target.gameId, target.version);
  console.log(`已启用 ${target.gameId}@${target.version}`);
} else {
  await store.setVersionStatus(target.gameId, target.version, 'disabled');
  console.log(`已禁用 ${target.gameId}@${target.version}`);
}

await db.close();
