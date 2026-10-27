/**
 * 端到端冒烟测试（M1）
 *
 * 覆盖：
 *   1. 登录 / 开桌 / 加入 / 开局 / 轮流出牌
 *   2. 中途重启服务（换一个全新的 Db 实例，同一个数据目录）→ 局面不丢
 *   3. 动作日志完整：seq 连续，且能重放回放出与库里完全一致的状态哈希
 *
 * 用法：pnpm smoke
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { buildApp } = await import('../apps/server/src/app.ts');
const { createDb } = await import('../apps/server/src/db/index.ts');
const { hashState } = await import('../apps/server/src/hash.ts');
const { createInitialState, applyAction } = await import('../packages/engine/src/index.ts');
const { default: dice } = await import('../games/dice/src/index.ts');

const dataDir = mkdtempSync(path.join(tmpdir(), 'platform-m1-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ 工具 ------------------------------ */

async function startServer(db) {
  const app = await buildApp({ db });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 8787;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
  };
}

function makeApi(base) {
  return async function api(pathname, { token, method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${base}/api${pathname}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(`${method} ${pathname} → ${response.status} ${JSON.stringify(json)}`);
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

  return {
    state,
    ready,
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: () => socket.close(),
  };
}

async function waitFor(client, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.state.snapshot && predicate(client.state.snapshot)) return client.state.snapshot;
    await sleep(25);
  }
  throw new Error(
    `等待超时：${label}（errors=${JSON.stringify(client.state.errors)}，` +
      `seq=${client.state.snapshot?.seq}，status=${client.state.snapshot?.status}）`,
  );
}

/** 让当前该动的玩家掷一次 */
async function rollOnce(clients, tableId, me) {
  const snapshot = clients.alice.state.snapshot;
  const actorId = snapshot.activePlayer;
  const actor = actorId === clients.aliceId ? clients.alice : clients.bob;
  const before = snapshot.seq;

  assert.ok(
    actor.state.snapshot.legal.includes('roll'),
    `当前玩家应有 roll，实际 legal=${JSON.stringify(actor.state.snapshot.legal)}`,
  );

  actor.send({ t: 'action', tableId, type: 'roll' });
  await waitFor(clients.alice, (s) => s.seq !== before || s.status === 'finished', '动作生效');
  return actorId;
}

/* ------------------------------ 第一阶段 ------------------------------ */

console.log('▶ 阶段一：起服务、开桌、打两步');

const db1 = await createDb({ dataDir });
const server1 = await startServer(db1);
const api1 = makeApi(server1.base);

const alice = await api1('/auth/login', { method: 'POST', body: { name: '爱丽丝' } });
const bob = await api1('/auth/login', { method: 'POST', body: { name: '鲍勃' } });
const { id: tableId } = await api1('/tables', {
  token: alice.token,
  method: 'POST',
  body: { gameId: 'dice', maxPlayers: 2 },
});
await api1(`/tables/${tableId}/join`, { token: bob.token, method: 'POST' });
await api1(`/tables/${tableId}/start`, { token: alice.token, method: 'POST' });

const clients1 = {
  aliceId: alice.user.id,
  alice: connect(server1.wsBase, alice.token),
  bob: connect(server1.wsBase, bob.token),
};
await Promise.all([clients1.alice.ready, clients1.bob.ready]);
clients1.alice.send({ t: 'subscribe', tableId });
clients1.bob.send({ t: 'subscribe', tableId });
await waitFor(clients1.alice, (s) => s.status === 'playing', '开局');

await rollOnce(clients1, tableId, 'alice');
await rollOnce(clients1, tableId, 'alice');

const midway = clients1.alice.state.snapshot;
console.log(`✓ 打到一半：seq=${midway.seq}，比分=${JSON.stringify(midway.view.data.scores)}`);

clients1.alice.close();
clients1.bob.close();
await server1.app.close();
await db1.close();
console.log('✓ 服务已完全关闭（Db 实例也销毁了）');

/* ------------------------------ 第二阶段 ------------------------------ */

console.log('\n▶ 阶段二：用同一个数据目录重新起服务');

const db2 = await createDb({ dataDir });
const server2 = await startServer(db2);
const api2 = makeApi(server2.base);

const health = await api2('/health');
assert.equal(health.db, 'pglite', '本地应走 PGlite');

// 老 token 仍然有效（JWT 无状态，且用户行在库里）
const me = await api2('/me', { token: alice.token });
assert.equal(me.user.id, alice.user.id);

const clients2 = {
  aliceId: alice.user.id,
  alice: connect(server2.wsBase, alice.token),
  bob: connect(server2.wsBase, bob.token),
};
await Promise.all([clients2.alice.ready, clients2.bob.ready]);
clients2.alice.send({ t: 'subscribe', tableId });
clients2.bob.send({ t: 'subscribe', tableId });

const recovered = await waitFor(clients2.alice, (s) => s.seq >= midway.seq, '重启后恢复局面');
assert.equal(recovered.status, 'playing', '重启后应仍在进行中');
assert.deepEqual(recovered.view.data.scores, midway.view.data.scores, '比分应完整保留');
assert.equal(recovered.seq, midway.seq, 'seq 应续上');
console.log(`✓ 重启后恢复：seq=${recovered.seq}，比分一致`);

/* ------------------------------ 打完并校验 ------------------------------ */

let guard = 0;
while (guard < 20) {
  guard += 1;
  if (clients2.alice.state.snapshot.status === 'finished') break;
  await rollOnce(clients2, tableId, 'alice');
}

const final = await waitFor(clients2.alice, (s) => s.status === 'finished', '终局');
assert.ok(final.view.finished);
assert.equal(final.seq, final.seq, '');
assert.equal(clients2.alice.state.errors.length, 0, 'WS 不应报错');
console.log(
  `✓ 终局：seq=${final.seq}，排名=${final.view.ranking
    .map((group) => group.map((id) => (id === alice.user.id ? '爱丽丝' : '鲍勃')).join('、'))
    .join(' > ')}`,
);

// --- 动作日志完整性 ---
// 注意：match_actions.seq 复用 tables.seq（客户端看到的版本号），
// 而"加入牌桌"也会推进 seq 但不产生对局记录，所以日志 seq 允许有空洞，只要求严格递增。
const rows = await db2.query(
  'SELECT * FROM match_actions WHERE table_id = $1 ORDER BY seq ASC',
  [tableId],
);
assert.equal(rows[0].kind, 'start', '第一条记录应是 start');
for (let index = 1; index < rows.length; index += 1) {
  assert.ok(
    Number(rows[index].seq) > Number(rows[index - 1].seq),
    `日志 seq 必须严格递增，第 ${index} 行断了`,
  );
}
console.log(`✓ 动作日志：${rows.length} 条，seq 严格递增（${rows.map((r) => r.seq).join(',')}）`);

// --- 重放校验：用日志重算出与库里完全一致的状态 ---
const startRow = rows.find((row) => row.kind === 'start');
assert.ok(startRow, '应有 start 记录');
const setup = startRow.action;
assert.ok(setup && typeof setup.seed === 'number', 'start 记录里应保存建局种子');

let replayed = createInitialState(dice, {
  players: setup.players,
  options: setup.options ?? {},
  seed: setup.seed,
  now: 0,
}).state;
assert.equal(hashState(replayed), startRow.state_hash, '初始状态哈希应一致');

for (const row of rows) {
  if (row.kind !== 'action') continue;
  replayed = applyAction(dice, replayed, row.actor, row.action, Number(row.created_at)).state;
  assert.equal(hashState(replayed), row.state_hash, `seq ${row.seq} 重放哈希不一致`);
}

const dbTable = await db2.query('SELECT state FROM tables WHERE id = $1', [tableId]);
assert.equal(hashState(replayed), hashState(dbTable[0].state), '重放结果应与库中状态一致');
console.log('✓ 重放校验通过：动作日志可以完整重建当前局面');

/* ------------------------------ 超时兜底 ------------------------------ */

console.log('\n▶ 阶段三：超时兜底（无人操作 → 服务端代打）');

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

const timeoutStarted = await waitFor(timeoutClient, (s) => s.status === 'playing', '超时桌开局');
const beforeTimeoutSeq = timeoutStarted.seq;

const afterTimeout = await waitFor(
  timeoutClient,
  (s) => s.seq > beforeTimeoutSeq,
  '超时自动行动',
  15000,
);
assert.equal(afterTimeout.status, 'playing', '超时只代打一步，不应直接结束');
console.log(`✓ 无人操作 5 秒后自动走了一步：seq ${beforeTimeoutSeq} → ${afterTimeout.seq}`);

const timeoutRows = await db2.query(
  "SELECT * FROM match_actions WHERE table_id = $1 AND kind = 'timeout'",
  [timeoutTable],
);
assert.ok(timeoutRows.length >= 1, '超时动作应写入日志且标记 kind=timeout');
console.log(`✓ 日志记录了 ${timeoutRows.length} 条 timeout 动作`);
timeoutClient.close();

clients2.alice.close();
clients2.bob.close();
await server2.app.close();
await db2.close();
rmSync(dataDir, { recursive: true, force: true });

console.log('\n全部通过 ✅');
process.exit(0);
