/**
 * 端到端冒烟测试：真起一个服务，两个真人客户端把「骰子对决」打完。
 *
 * 覆盖：登录 → 开桌 → 加入 → 开局 → 轮流出牌 → 终局排名。
 * 用法：pnpm smoke（内部用 tsx 运行，直接 import TypeScript 源码）
 */
import assert from 'node:assert/strict';

const { buildApp } = await import('../apps/server/src/app.ts');

const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : 8787;
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${base}/api${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`);
  return json;
}

/** 一条 WS 连接，保存最新快照，支持"等到满足条件" */
function connect(token) {
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
    closed: new Promise((resolve) => socket.addEventListener('close', resolve)),
    send(payload) {
      socket.send(JSON.stringify(payload));
    },
    close() {
      socket.close();
    },
  };
}

async function waitFor(client, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.state.snapshot && predicate(client.state.snapshot)) return client.state.snapshot;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}（当前 snapshot=${JSON.stringify(client.state.snapshot)?.slice(0, 300)}）`);
}

/* ------------------------------------------------------------------ */

console.log('▶ 启动服务，端口', port);

const alice = await api('/auth/login', { method: 'POST', body: { name: '爱丽丝' } });
const bob = await api('/auth/login', { method: 'POST', body: { name: '鲍勃' } });
console.log('✓ 两个用户登录');

const games = await api('/games');
assert.equal(games.games.length, 1, '应注册 1 个游戏');
assert.equal(games.games[0].id, 'dice');
console.log('✓ 游戏清单：', games.games[0].name, games.games[0].version);

const { id: tableId } = await api('/tables', {
  token: alice.token,
  method: 'POST',
  body: { gameId: 'dice', maxPlayers: 2 },
});
await api(`/tables/${tableId}/join`, { token: bob.token, method: 'POST' });
console.log('✓ 建桌并加入：', tableId);

const aliceWs = connect(alice.token);
const bobWs = connect(bob.token);
await Promise.all([aliceWs.ready, bobWs.ready]);
aliceWs.send({ t: 'subscribe', tableId });
bobWs.send({ t: 'subscribe', tableId });

await waitFor(aliceWs, (s) => s.players.length === 2, '两人就位');
console.log('✓ WS 订阅成功，两人就位');

await api(`/tables/${tableId}/start`, { token: alice.token, method: 'POST' });
await waitFor(aliceWs, (s) => s.status === 'playing', '对局开始');
console.log('✓ 对局开始');

let guard = 0;
while (guard < 40) {
  guard += 1;
  const snapshot = aliceWs.state.snapshot;
  if (snapshot.status === 'finished') break;

  const activeId = snapshot.activePlayer;
  assert.ok(activeId, '进行中必须有当前玩家');

  const actor = activeId === alice.user.id ? aliceWs : bobWs;
  const before = snapshot.seq;

  assert.ok(
    actor.state.snapshot.legal.includes('roll'),
    `当前玩家应该有 roll 动作，实际 legal=${JSON.stringify(actor.state.snapshot.legal)}`,
  );

  actor.send({ t: 'action', tableId, type: 'roll' });
  await waitFor(aliceWs, (s) => s.seq !== before || s.status === 'finished', '动作生效');
}

const finalSnapshots = await Promise.all([
  waitFor(aliceWs, (s) => s.status === 'finished', '爱丽丝视角结束'),
  waitFor(bobWs, (s) => s.status === 'finished', '鲍勃视角结束'),
]);

const [aliceFinal, bobFinal] = finalSnapshots;
assert.ok(aliceFinal.view?.finished, '终局 view.finished 应为 true');
assert.ok(Array.isArray(aliceFinal.view?.ranking) && aliceFinal.view.ranking.length > 0, '应有排名');
assert.equal(aliceFinal.view.ranking.flat().length, 2, '两人都应出现在排名里');
assert.equal(aliceFinal.seq, bobFinal.seq, '两端的 seq 应一致');
assert.equal(aliceWs.state.errors.length, 0, `不应有 WS 错误：${aliceWs.state.errors.join('; ')}`);
assert.equal(bobWs.state.errors.length, 0, `不应有 WS 错误：${bobWs.state.errors.join('; ')}`);

const ranking = aliceFinal.view.ranking;
const names = Object.fromEntries(aliceFinal.players.map((p) => [p.id, p.name]));
console.log('✓ 对局结束，排名：', ranking.map((g) => g.map((id) => names[id]).join('、')).join(' > '));
console.log('✓ 日志条数：', aliceFinal.log.length);
console.log('✓ 最终 seq：', aliceFinal.seq);

aliceWs.close();
bobWs.close();
await app.close();
console.log('\n全部通过 ✅');
process.exit(0);
