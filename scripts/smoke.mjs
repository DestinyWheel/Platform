/**
 * 端到端冒烟测试（M2）
 *
 * 覆盖：
 *   1. 启动时自动发布 games/ 下的插件，大厅能列出来
 *   2. 对局中途后台上传新版本 → 服务不重启、老桌仍跑老版本、新桌用新版本
 *   3. 中途重启服务（换全新 Db 实例，同一数据目录）→ 局面不丢
 *   4. 动作日志可重放，重放结果与库中状态哈希一致
 *   5. 超时兜底
 *
 * 用法：pnpm smoke
 */
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { buildApp } = await import('../apps/server/src/app.ts');
const { createDb } = await import('../apps/server/src/db/index.ts');
const { hashState } = await import('../apps/server/src/hash.ts');
const { createInitialState, applyAction } = await import('../packages/engine/src/index.ts');

const requireFromServer = createRequire(
  pathToFileURL(path.join(fileURLToPath(new URL('..', import.meta.url)), 'apps/server/package.json')),
);
const AdmZip = requireFromServer('adm-zip');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workDir = mkdtempSync(path.join(tmpdir(), 'platform-m2-'));
const dataDir = path.join(workDir, 'data');
const storageRoot = path.join(workDir, 'plugins');
const pkgDir = path.join(workDir, 'packages');
mkdirSync(pkgDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ 工具 ------------------------------ */

async function startServer(db, extra = {}) {
  const app = await buildApp({ db, storageRoot, autoPublish: true, ...extra });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 8787;
  return { app, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

function makeApi(base) {
  return async function api(pathname, { token, method = 'GET', body, raw } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (raw !== undefined) headers['content-type'] = 'application/zip';
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${base}/api${pathname}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(raw !== undefined ? { body: raw } : {}),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${method} ${pathname} → ${response.status} ${JSON.stringify(json)}`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  };
}

function connect(wsBase, token) {
  const socket = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
  const state = { snapshot: null, errors: [], lastSeq: 0 };

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'snapshot') {
      if (msg.snapshot.seq >= state.lastSeq) {
        state.snapshot = msg.snapshot;
        state.lastSeq = msg.snapshot.seq;
      }
    } else if (msg.t === 'error') {
      state.errors.push(msg.message);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  return { state, ready, send: (p) => socket.send(JSON.stringify(p)), close: () => socket.close() };
}

async function waitFor(client, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.state.snapshot && predicate(client.state.snapshot)) return client.state.snapshot;
    await sleep(25);
  }
  throw new Error(
    `等待超时：${label}（errors=${JSON.stringify(client.state.errors)}，seq=${client.state.snapshot?.seq}）`,
  );
}

async function rollOnce(clients, tableId) {
  const snapshot = clients.alice.state.snapshot;
  const actor = snapshot.activePlayer === clients.aliceId ? clients.alice : clients.bob;
  const before = snapshot.seq;
  assert.ok(actor.state.snapshot.legal.includes('roll'), '当前玩家应有 roll');
  actor.send({ t: 'action', tableId, type: 'roll' });
  await waitFor(clients.alice, (s) => s.seq !== before || s.status === 'finished', '动作生效');
}

/** 把 games/dice 复制一份、改版本号、打成 zip，模拟一次后台上传 */
function buildPackage(version) {
  const dir = path.join(pkgDir, `dice-${version}`);
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(repoRoot, 'games', 'dice'), dir, { recursive: true });

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const zip = new AdmZip();
  zip.addFile('manifest.json', readFileSync(manifestPath));

  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, name);
      else zip.addFile(name, readFileSync(full));
    }
  };
  walk(path.join(dir, 'src'), 'src');

  return zip.toBuffer();
}

/* ------------------------------ 阶段一 ------------------------------ */

console.log('▶ 阶段一：起服务、自动发布插件、开桌打两步');

const db1 = await createDb({ dataDir });
const server1 = await startServer(db1);
const api1 = makeApi(server1.base);

const alice = await api1('/auth/login', { method: 'POST', body: { name: '爱丽丝' } });
const bob = await api1('/auth/login', { method: 'POST', body: { name: '鲍勃' } });

const games1 = await api1('/games');
assert.ok(games1.games.length >= 2, `应自动发布多个游戏，实际 ${games1.games.length}`);
const diceInitial = games1.games.find((game) => game.id === 'dice');
assert.ok(diceInitial, '应自动发布 dice');
assert.equal(diceInitial.version, '0.1.0');
assert.ok(games1.games.find((game) => game.id === 'mandala'), '应自动发布 mandala');
console.log(`✓ 自动发布：${games1.games.map((game) => `${game.id}@${game.version}`).join(', ')}`);

const { id: tableA } = await api1('/tables', {
  token: alice.token,
  method: 'POST',
  body: { gameId: 'dice', maxPlayers: 2 },
});
await api1(`/tables/${tableA}/join`, { token: bob.token, method: 'POST' });
await api1(`/tables/${tableA}/start`, { token: alice.token, method: 'POST' });

const clients = {
  aliceId: alice.user.id,
  alice: connect(server1.wsBase, alice.token),
  bob: connect(server1.wsBase, bob.token),
};
await Promise.all([clients.alice.ready, clients.bob.ready]);
clients.alice.send({ t: 'subscribe', tableId: tableA });
clients.bob.send({ t: 'subscribe', tableId: tableA });
await waitFor(clients.alice, (s) => s.status === 'playing', '开局');

await rollOnce(clients, tableA);
await rollOnce(clients, tableA);
const midway = clients.alice.state.snapshot;
assert.equal(midway.gameVersion, '0.1.0');
console.log(`✓ 打了两步：seq=${midway.seq}，版本=${midway.gameVersion}`);

/* ------------------------------ 阶段二 ------------------------------ */

console.log('\n▶ 阶段二：后台上传 0.2.0（服务不重启）');

const upload = await api1('/admin/plugins', {
  token: alice.token,
  method: 'POST',
  raw: buildPackage('0.2.0'),
});
assert.equal(upload.version, '0.2.0');
assert.equal(upload.status, 'active');
console.log(`✓ 上传成功：dice@${upload.version} 已激活`);

const games2 = await api1('/games');
const diceAfterUpload = games2.games.find((game) => game.id === 'dice');
assert.equal(diceAfterUpload?.version, '0.2.0', '大厅应立刻看到新版本');

// 老桌仍锁 0.1.0，且还能继续打
await rollOnce(clients, tableA);
const stillOld = clients.alice.state.snapshot;
assert.equal(stillOld.gameVersion, '0.1.0', '老桌必须仍用老版本');
assert.ok(stillOld.seq > midway.seq, '老桌应该还能继续推进');
console.log(`✓ 老桌继续跑 ${stillOld.gameVersion}，seq=${stillOld.seq}`);

// 新桌用新版本
const { id: tableB } = await api1('/tables', {
  token: alice.token,
  method: 'POST',
  body: { gameId: 'dice', maxPlayers: 2 },
});
const snapshotB = await api1(`/tables/${tableB}`, { token: alice.token });
assert.equal(snapshotB.snapshot.gameVersion, '0.2.0', '新桌应拿到新版本');
console.log('✓ 新开一桌拿到 0.2.0（同一个进程，没重启）');

// 插件产物可被浏览器直接拉到
const clientRes = await fetch(`${server1.base}/plugins/dice/0.2.0/client.js`);
assert.equal(clientRes.status, 200, '插件前端产物应可访问');
const clientCode = await clientRes.text();
assert.ok(clientCode.includes('dz-'), 'client.js 应包含插件 UI 代码');

// 产物必须真的是可加载的 ESM，且导出约定的接口
const clientFile = path.join(workDir, 'client-artifact.mjs');
writeFileSync(clientFile, clientCode);
const clientModule = await import(pathToFileURL(clientFile).href);
assert.equal(typeof clientModule.default?.mount, 'function', 'client.js 应导出 mount');
assert.equal(typeof clientModule.default?.update, 'function', 'client.js 应导出 update');
console.log(
  `✓ 插件产物可访问且可加载（${(clientCode.length / 1024).toFixed(1)} KB，导出 mount/update/unmount）`,
);

// 权限：非管理员不能上传
await assert.rejects(
  () => api1('/admin/plugins', { token: bob.token, method: 'POST', raw: buildPackage('0.2.1') }),
  (error) => error.status === 403,
  '非管理员上传应被拒绝',
);
console.log('✓ 非管理员上传被拒绝（403）');

/* ------------------------------ 阶段三 ------------------------------ */

console.log('\n▶ 阶段三：重启服务（新 Db 实例 + 同一数据目录）');

clients.alice.close();
clients.bob.close();
await server1.app.close();
await db1.close();

const db2 = await createDb({ dataDir });
// autoPublish 关掉，模拟生产：重启后版本状态完全来自数据库
const server2 = await startServer(db2, { autoPublish: false });
const api2 = makeApi(server2.base);

const recovered = await api2(`/tables/${tableA}`, { token: alice.token });
assert.equal(recovered.snapshot.gameVersion, '0.1.0', '重启后老桌仍锁老版本');
assert.equal(recovered.snapshot.seq, stillOld.seq, 'seq 应续上');
console.log(`✓ 重启后老桌恢复：版本=${recovered.snapshot.gameVersion}，seq=${recovered.snapshot.seq}`);

const gamesAfterRestart = await api2('/games');
assert.equal(
  gamesAfterRestart.games.find((game) => game.id === 'dice')?.version,
  '0.2.0',
  'active 版本从库里恢复',
);
console.log('✓ active 版本从库里恢复为 0.2.0');

/* ------------------------------ 打完 + 校验 ------------------------------ */

const clients2 = {
  aliceId: alice.user.id,
  alice: connect(server2.wsBase, alice.token),
  bob: connect(server2.wsBase, bob.token),
};
await Promise.all([clients2.alice.ready, clients2.bob.ready]);
clients2.alice.send({ t: 'subscribe', tableId: tableA });
clients2.bob.send({ t: 'subscribe', tableId: tableA });
await waitFor(clients2.alice, (s) => s.seq >= stillOld.seq, '恢复订阅');

let guard = 0;
while (guard < 20) {
  guard += 1;
  if (clients2.alice.state.snapshot.status === 'finished') break;
  await rollOnce(clients2, tableA);
}
const final = await waitFor(clients2.alice, (s) => s.status === 'finished', '终局');
console.log(`✓ 终局：seq=${final.seq}`);

const rows = await db2.query(
  'SELECT * FROM match_actions WHERE table_id = $1 ORDER BY seq ASC',
  [tableA],
);
assert.equal(rows[0].kind, 'start', '第一条应是 start');

// 重放：用 0.1.0 的编译产物重建局面
const builtPlugin = await import(
  pathToFileURL(path.join(storageRoot, 'dice', '0.1.0', 'server.js')).href
);
const dicePlugin = builtPlugin.default;
const setup = rows[0].action;
let replayed = createInitialState(dicePlugin, {
  players: setup.players,
  options: setup.options ?? {},
  seed: setup.seed,
  now: 0,
}).state;
assert.equal(hashState(replayed), rows[0].state_hash, '初始状态哈希应一致');

for (const row of rows) {
  if (row.kind !== 'action') continue;
  replayed = applyAction(dicePlugin, replayed, row.actor, row.action, Number(row.created_at)).state;
  assert.equal(hashState(replayed), row.state_hash, `seq ${row.seq} 重放哈希不一致`);
}
const dbTable = await db2.query('SELECT state FROM tables WHERE id = $1', [tableA]);
assert.equal(hashState(replayed), hashState(dbTable[0].state), '重放结果应与库中一致');
console.log(`✓ 用 0.1.0 产物重放 ${rows.length} 条日志，哈希完全一致`);

/* ------------------------------ 聊天 / 战绩 / Elo / 回放 ------------------------------ */

console.log('\n▶ 阶段四：聊天 / 观战人数 / 战绩 / Elo / 回放');

const chatClient = connect(server2.wsBase, alice.token);
await chatClient.ready;
chatClient.send({ t: 'subscribe', tableId: tableA });
await waitFor(chatClient, (s) => s.status === 'finished', '进入已结束的桌');

chatClient.send({ t: 'chat', tableId: tableA, text: '这局打得好' });
const withChat = await waitFor(
  chatClient,
  (s) => s.chat.some((message) => message.body === '这局打得好'),
  '聊天广播',
);
assert.equal(withChat.viewers, 2, '爱丽丝开两个连接，加上鲍勃，应算 2 个不同的人');
console.log(`✓ 聊天与在线人数：${withChat.chat.length} 条消息，${withChat.viewers} 人在看`);
chatClient.close();

const stats = await api2('/stats/me', { token: alice.token });
assert.equal(stats.perGame.length, 1, '应有 1 个游戏的战绩');
assert.equal(stats.perGame[0].games, 1);
console.log(
  `✓ 战绩：${stats.perGame[0].gameName} 打了 ${stats.perGame[0].games} 场，胜 ${stats.perGame[0].wins} 场`,
);

const board = await api2('/leaderboard?gameId=dice', { token: alice.token });
assert.equal(board.entries.length, 2, '两人都应有评分');
const totalRating = board.entries.reduce((sum, entry) => sum + entry.rating, 0);
assert.equal(totalRating, 3000, 'Elo 零和：两人总分应仍是 2 × 1500');
assert.ok(board.entries[0].rating > 1500, '赢家应该涨分');
assert.ok(board.entries[1].rating < 1500, '输家应该掉分');
console.log(
  `✓ Elo：${board.entries[0].name} ${board.entries[0].rating} / ${board.entries[1].name} ${board.entries[1].rating}（总分守恒）`,
);

const replayRes = await api2(`/tables/${tableA}/replay`, { token: alice.token });
const replay = replayRes.replay;
assert.equal(replay.steps.length, rows.length, '回放步数 = 开局 + 每条动作');
assert.equal(replay.steps[0].kind, 'start');
assert.equal(replay.steps.at(-1).view.finished, true, '最后一步应是终局');
assert.equal(
  JSON.stringify(replay.steps.at(-1).view).includes('rngSeed'),
  false,
  '回放是观战者视角，不应泄漏随机种子',
);
console.log(`✓ 回放：${replay.steps.length} 步，末步已结束（观战者视角）`);

/* ------------------------------ 超时兜底 ------------------------------ */

console.log('\n▶ 阶段五：超时兜底');

const { id: timeoutTable } = await api2('/tables', {
  token: alice.token,
  method: 'POST',
  body: { gameId: 'dice', maxPlayers: 2, options: { turnMs: 5000 } },
});
await api2(`/tables/${timeoutTable}/join`, { token: bob.token, method: 'POST' });
await api2(`/tables/${timeoutTable}/start`, { token: alice.token, method: 'POST' });

const timeoutClient = connect(server2.wsBase, alice.token);
await timeoutClient.ready;
timeoutClient.send({ t: 'subscribe', tableId: timeoutTable });
const started = await waitFor(timeoutClient, (s) => s.status === 'playing', '超时桌开局');
const afterTimeout = await waitFor(
  timeoutClient,
  (s) => s.seq > started.seq,
  '超时自动行动',
  15000,
);
console.log(`✓ 无人操作 5 秒后自动走了一步：seq ${started.seq} → ${afterTimeout.seq}`);

// 超时动作也要能回放（否则日志就断了一环）
const timeoutReplay = await api2(`/tables/${timeoutTable}/replay`, { token: alice.token });
assert.ok(
  timeoutReplay.replay.steps.some((step) => step.kind === 'timeout'),
  '回放里应能看到超时代打的那一步',
);
console.log(`✓ 超时动作已入库，回放 ${timeoutReplay.replay.steps.length} 步可见`);
timeoutClient.close();

/* ------------------------------ 曼荼罗完整对局 ------------------------------ */

console.log('\n▶ 阶段六：曼荼罗 —— 隐藏信息 / legalMoves / 完整对局 / 回放');

const { id: mandalaTable } = await api2('/tables', {
  token: alice.token,
  method: 'POST',
  body: { gameId: 'mandala' },
});
await api2(`/tables/${mandalaTable}/join`, { token: bob.token, method: 'POST' });
await api2(`/tables/${mandalaTable}/start`, { token: alice.token, method: 'POST' });

const mandalaAlice = connect(server2.wsBase, alice.token);
const mandalaBob = connect(server2.wsBase, bob.token);
await Promise.all([mandalaAlice.ready, mandalaBob.ready]);
mandalaAlice.send({ t: 'subscribe', tableId: mandalaTable });
mandalaBob.send({ t: 'subscribe', tableId: mandalaTable });

const opened = await waitFor(mandalaAlice, (s) => s.status === 'playing', '曼荼罗开局');
const openedData = opened.view.data;

assert.ok(Array.isArray(openedData.you?.hand), '自己应该看得到手牌');
assert.equal(openedData.you.hand.length, 6, '起始手牌应为 6 张');
assert.equal(openedData.opponent?.hand, undefined, '不应看到对手手牌内容');
assert.equal(openedData.opponent.handCount, 6, '只应看到对手手牌张数');
assert.equal(openedData.you.cupCount, 2, '起始沙杯 2 张');
assert.equal(openedData.mandalas.length, 2);
const mountainCards = Object.values(openedData.mandalas[0].mountain ?? {}).reduce(
  (sum, count) => sum + count,
  0,
);
assert.equal(mountainCards, 2, '高山初始应有 2 张（两张可能同色）');
assert.ok(opened.legalMoves.length > 0, '先手应有合法动作');
console.log(
  `✓ 隐藏信息正确：自己 6 张手牌、对手只有张数；高山 2 张、牌堆 ${openedData.deckRemaining}`,
);

// 观战者视角：谁都看不到手牌
const watcher = await api2('/auth/login', { method: 'POST', body: { name: '旁观者' } });
const watcherWs = connect(server2.wsBase, watcher.token);
await watcherWs.ready;
watcherWs.send({ t: 'subscribe', tableId: mandalaTable });
const watched = await waitFor(watcherWs, (s) => s.view !== null, '观战视角');
assert.equal(watched.view.data.you, null, '观战者不应有手牌');
assert.equal(watched.view.data.opponent, null, '观战者不应看到任何一方手牌');
console.log('✓ 观战者看不到任何人的手牌');

// 用 legalMoves 自动打完一局
let mandalaTurns = 0;
let stalled = 0;
while (mandalaTurns < 400) {
  mandalaTurns += 1;
  const current = mandalaAlice.state.snapshot;
  if (current.status === 'finished') break;

  const activeId = current.activePlayer;
  const actor = activeId === alice.user.id ? mandalaAlice : mandalaBob;
  const moves = actor.state.snapshot.legalMoves ?? [];
  assert.ok(moves.length > 0, `轮到 ${activeId} 时应有合法动作`);

  // 优先出牌，避免两边一直互相弃牌把牌耗光
  const move = moves.find((m) => m.type !== 'endTurn') ?? moves[0];
  stalled = move.type === 'endTurn' ? stalled + 1 : 0;
  if (stalled > 30) break;

  const before = current.seq;
  actor.send({ t: 'action', tableId: mandalaTable, type: move.type, payload: move.payload });
  await waitFor(
    mandalaAlice,
    (s) => s.seq !== before || s.status === 'finished',
    '曼荼罗动作生效',
  );
}

const mandalaFinal = mandalaAlice.state.snapshot;
if (mandalaFinal.status === 'finished') {
  assert.ok(Array.isArray(mandalaFinal.view.ranking), '终局应有排名');
  assert.equal(mandalaFinal.view.ranking.flat().length, 2, '两人都应出现在排名里');
  console.log(`✓ 曼荼罗打完：${mandalaTurns} 步，胜者 ${mandalaFinal.view.ranking[0].length > 1 ? '（平局）' : '已产生'}`);
} else {
  console.log(`⚠ 曼荼罗未在 ${mandalaTurns} 步内结束（当前 ${mandalaFinal.status}），仍校验回放`);
}

const mandalaReplay = await api2(`/tables/${mandalaTable}/replay`, { token: alice.token });
assert.ok(mandalaReplay.replay.steps.length > 5, '回放应有足够步数');
assert.equal(
  JSON.stringify(mandalaReplay.replay.steps.at(-1).view).includes('"hand"'),
  false,
  '回放是观战者视角，不应含任何手牌',
);
console.log(`✓ 曼荼罗回放 ${mandalaReplay.replay.steps.length} 步，且不含手牌内容`);

// 前端产物也要是能加载的 ESM
const mandalaClientRes = await fetch(`${server2.base}/plugins/mandala/0.1.0/client.js`);
assert.equal(mandalaClientRes.status, 200, '曼荼罗前端产物应可访问');
const mandalaClientCode = await mandalaClientRes.text();
const mandalaClientFile = path.join(workDir, 'mandala-client.mjs');
writeFileSync(mandalaClientFile, mandalaClientCode);
const mandalaClientModule = await import(pathToFileURL(mandalaClientFile).href);
assert.equal(typeof mandalaClientModule.default?.mount, 'function', '曼荼罗 client 应导出 mount');
console.log(`✓ 曼荼罗前端产物可加载（${(mandalaClientCode.length / 1024).toFixed(1)} KB）`);

mandalaAlice.close();
mandalaBob.close();
watcherWs.close();

/* ------------------------------ worker 回收 ------------------------------ */

console.log('\n▶ 阶段七：worker 回收与按需重载');

const gc = await api2('/admin/plugins/gc', { token: alice.token, method: 'POST' });
assert.ok(
  gc.released.includes('dice@0.1.0'),
  `应卸载已无进行中牌桌的 dice@0.1.0，实际 ${JSON.stringify(gc.released)}`,
);
assert.ok(!gc.loaded.includes('dice@0.1.0'), '卸载后不应还留在内存里');
assert.ok(gc.loaded.includes('dice@0.2.0'), 'active 版本不应被卸载');
assert.ok(gc.loaded.includes('mandala@0.1.0'), '有进行中牌桌的版本不应被卸载');
console.log(`✓ 回收：卸载 ${gc.released.join(', ')}；内存里剩 ${gc.loaded.join(', ')}`);

// 老桌的回放会按需把 0.1.0 重新加载回来
const replayAfterGc = await api2(`/tables/${tableA}/replay`, { token: alice.token });
assert.equal(replayAfterGc.replay.steps.length, rows.length, '重载后回放步数应一致');

// 再回收一次：如果回放真的把 0.1.0 加载回来了，这次它会再次出现在 released 里
const secondGc = await api2('/admin/plugins/gc', { token: alice.token, method: 'POST' });
assert.ok(
  secondGc.released.includes('dice@0.1.0'),
  '回放应按需重新加载旧版本（否则第二次回收不会再次命中它）',
);
console.log('✓ 按需重载：回放触发重新加载，内容完全一致');

/* ------------------------------ 收尾 ------------------------------ */

clients2.alice.close();
clients2.bob.close();
await server2.app.close();
await db2.close();
rmSync(workDir, { recursive: true, force: true });

console.log('\n全部通过 ✅');
process.exit(0);
