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
import { randomUUID } from 'node:crypto';
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
const { createDb, migrate } = await import('../apps/server/src/db/index.ts');
const { PgStore } = await import('../apps/server/src/store.ts');
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
    // 冒烟里建桌默认走「回合制 + 每天一动」：测试期间不会超时，也不占"即时房间"名额
    const payload =
      pathname === '/tables' && method === 'POST' && body && !body.mode
        ? { mode: 'turnbased', pace: '1', ...body }
        : body;

    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (raw !== undefined) headers['content-type'] = 'application/zip';
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${base}/api${pathname}`, {
      method,
      headers,
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
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

/** 建桌限流在阶段八被故意打满过，后面的用例要能等一下令牌补充 */
async function createTableWithRetry(api, token, body, attempts = 8) {
  // 默认回合制、每天一动：测试期间不会超时，也不会撞"一人一个即时房"的限制
  const withDefaults = { mode: 'turnbased', pace: '1', ...body };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api('/tables', { token, method: 'POST', body: withDefaults });
    } catch (error) {
      if (error.status !== 429) throw error;
      await sleep(1200);
    }
  }
  throw new Error('建桌一直被限流，放弃');
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
function buildPackage(version, notes = null, patchServer = null) {
  const dir = path.join(pkgDir, `dice-${version}`);
  mkdirSync(dir, { recursive: true });
  // 不带 node_modules：插件包里本来就不该有依赖目录（依赖由宿主解析），
  // 而且里面是 pnpm 的符号链接，Windows 上复制链接会直接 EPERM
  cpSync(path.join(repoRoot, 'games', 'dice'), dir, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes('node_modules'),
  });

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  if (notes) manifest.notes = notes;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (patchServer) {
    const serverPath = path.join(dir, 'src', 'server.ts');
    writeFileSync(serverPath, `${readFileSync(serverPath, 'utf8')}\n${patchServer}\n`);
  }

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

/** 冒烟用的固定口令；强度够过校验，也不在常见弱口令表里 */
const PASSWORD = {
  alice: 'alice-smoke-2024',
  bob: 'bob-smoke-2024',
  watcher: 'watcher-smoke-2024',
};

async function registerUser(api, name, password, extra = {}) {
  return api('/auth/register', {
    method: 'POST',
    body: { name, password, confirm: password, ...extra },
  });
}

/** 断言这个请求确实失败，并且是预期的状态码和错误码 */
async function expectFailure(promise, status, code, label) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.status, status, `${label}：期望 ${status}，实际 ${error.status}`);
    assert.equal(error.body?.code, code, `${label}：期望 code=${code}，实际 ${JSON.stringify(error.body)}`);
    return error;
  }
  throw new Error(`${label}：期望失败但成功了`);
}

const alice = await registerUser(api1, '爱丽丝', PASSWORD.alice);
const bob = await registerUser(api1, '鲍勃', PASSWORD.bob);
assert.equal(alice.user.isAdmin, true, '第一个注册的人应该是管理员');
assert.equal(bob.user.isAdmin, false, '第二个人不是管理员');

/* ---------------------------- 个人邀请码 ---------------------------- */

const invitePattern = /^[A-HJ-NP-Z2-9]{8}$/;

const aliceInvite = await api1('/me/invite', { token: alice.token });
assert.match(aliceInvite.code ?? '', invitePattern, '注册时应自动生成 8 位邀请码');
assert.equal(aliceInvite.invited.length, 0, '刚注册时还没邀请过人');

// 这个功能上线前注册的老账号：邀请码是空的，可以补生成一次
await db1.execute('UPDATE users SET invite_code = NULL, invite_code_at = NULL WHERE id = $1', [
  bob.user.id,
]);
const bobBefore = await api1('/me/invite', { token: bob.token });
assert.equal(bobBefore.code, null, '老账号初始没有邀请码');

const bobGenerated = await api1('/me/invite', { token: bob.token, method: 'POST' });
assert.match(bobGenerated.code, invitePattern, '生成出来的邀请码格式应该对');
await expectFailure(
  api1('/me/invite', { token: bob.token, method: 'POST' }),
  409,
  'invite_exists',
  '邀请码只能生成一次',
);

// 不填邀请码照样能注册；填了就得是真的，并且要记下邀请人
const dave = await registerUser(api1, '戴夫', 'dave-smoke-2024', { code: aliceInvite.code.toLowerCase() });
assert.equal(dave.user.isAdmin, false, '用邀请码注册的人不是管理员');
const aliceAfter = await api1('/me/invite', { token: alice.token });
assert.ok(
  aliceAfter.invited.some((person) => person.name === '戴夫'),
  '爱丽丝的邀请列表里应该有戴夫',
);
await expectFailure(
  registerUser(api1, '查码人', 'nobody-smoke-2024', { code: 'ZZZZZZZZ' }),
  403,
  'bad_code',
  '邀请码不存在',
);
const openUser = await registerUser(api1, '自来的', 'walkin-smoke-2024');
assert.equal(openUser.user.isAdmin, false, '不填邀请码也能注册');
console.log('✓ 邀请码：注册自动生成、老账号可补生成一次、填了记账、不填也能注册');

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
// 骰子是按点数分胜负的，运气好时可能并列第一；并列就双方都不动分
if (board.entries[0].rating === board.entries[1].rating) {
  console.log(`✓ Elo：本局平局，双方都停在 ${board.entries[0].rating}（总分守恒）`);
} else {
  assert.ok(board.entries[0].rating > 1500, '赢家应该涨分');
  assert.ok(board.entries[1].rating < 1500, '输家应该掉分');
  console.log(
    `✓ Elo：${board.entries[0].name} ${board.entries[0].rating} / ${board.entries[1].name} ${board.entries[1].rating}（总分守恒）`,
  );
}

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
  body: { gameId: 'dice', maxPlayers: 2, mode: 'realtime', pace: 'fast' },
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
/** 曼荼罗的版本号会随发版变，别写死 */
const mandalaVersion = opened.gameVersion;

assert.ok(Array.isArray(openedData.you?.hand), '自己应该看得到手牌');
assert.equal(openedData.you.hand.length, 6, '起始手牌应为 6 张');
assert.equal(openedData.opponent?.hand, undefined, '不应看到对手手牌内容');
assert.equal(openedData.opponent.handCount, 6, '只应看到对手手牌张数');
assert.equal(openedData.you.cupCount, 2, '起始沙杯 2 张');
assert.ok(Array.isArray(openedData.you.cup), '自己的沙杯应该看得到具体颜色');
assert.equal(openedData.you.cup.length, 2, '自己沙杯的张数要和 cupCount 对上');
assert.equal(openedData.opponent.cup, null, '对手的沙杯只能看到张数');
assert.equal(openedData.opponent.cupCount, 2, '对手沙杯张数还是可见的');
assert.equal(openedData.scores, null, '对局中不给总分（会泄露对手沙杯的颜色）');
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
const watcher = await registerUser(api2, '旁观者', PASSWORD.watcher);
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
const mandalaClientRes = await fetch(`${server2.base}/plugins/mandala/${mandalaVersion}/client.js`);
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
assert.ok(
  gc.loaded.includes(`mandala@${mandalaVersion}`),
  '有进行中牌桌的版本不应被卸载',
);
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

/* ------------------------------ 限流 / 指标 / 备份 ------------------------------ */

console.log('\n▶ 阶段八：限流 / 指标 / 备份与恢复');

// 连续建桌直到被 429
let rateLimited = 0;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    await api2('/tables', {
      token: alice.token,
      method: 'POST',
      body: { gameId: 'dice', maxPlayers: 2 },
    });
  } catch (error) {
    if (error.status === 429) {
      rateLimited += 1;
      break;
    }
    throw error;
  }
}
assert.ok(rateLimited > 0, '连续建桌应该触发限流');
console.log('✓ 限流生效：连续建桌被 429 拦下');

// 指标
const metricsRes = await fetch(`${server2.base}/api/metrics`, {
  headers: { authorization: `Bearer ${alice.token}` },
});
assert.equal(metricsRes.status, 200, '指标接口应可访问');
const metricsText = await metricsRes.text();
assert.ok(metricsText.includes('platform_http_requests'), '应包含请求计数');
assert.ok(metricsText.includes('platform_workers_loaded'), '应包含 worker 数');
assert.ok(metricsText.includes('platform_tables_playing'), '应包含牌桌状态');
console.log(`✓ 指标可用（${metricsText.split('\n').filter(Boolean).length} 项）`);

// 备份
const backup = await api2('/admin/backup', { token: alice.token, method: 'POST' });
assert.ok(backup.counts.users >= 2, '备份应包含用户');
assert.ok(backup.counts.tables >= 5, '备份应包含牌桌');
assert.ok(backup.counts.match_actions > 0, '备份应包含动作日志');

const { gunzipSync } = await import('node:zlib');
const dump = JSON.parse(gunzipSync(readFileSync(backup.file)).toString('utf8'));
assert.equal(dump.tables.tables.length, backup.counts.tables, '落盘内容应与统计一致');
console.log(
  `✓ 备份完成：${(backup.bytes / 1024).toFixed(1)} KB，` +
    Object.entries(backup.counts)
      .map(([table, count]) => `${table}=${count}`)
      .join(' '),
);

// 恢复到一个全新的数据目录，并逐个比对
const restoreDir = path.join(workDir, 'restore');
const restoreDb = await createDb({ dataDir: restoreDir });
await migrate(restoreDb);
const restoreStore = new PgStore(restoreDb);
const restoredCounts = await restoreStore.importAll(dump.tables);
assert.deepEqual(restoredCounts, backup.counts, '恢复后的行数应与备份一致');

const original = await db2.query('SELECT seq, state FROM tables WHERE id = $1', [tableA]);
const restored = await restoreDb.query('SELECT seq, state FROM tables WHERE id = $1', [tableA]);
assert.equal(restored[0].seq, original[0].seq, '恢复后 seq 应一致');
assert.equal(hashState(restored[0].state), hashState(original[0].state), '恢复后局面哈希应一致');
await restoreDb.close();
console.log('✓ 恢复校验：行数一致，牌桌局面哈希一致');

/* ------------------------------ 人机 ------------------------------ */

console.log('\n▶ 阶段九：人机');

const { id: botTable } = await createTableWithRetry(api2, alice.token, {
  gameId: 'mandala',
  maxPlayers: 2,
  options: { bots: 1 },
});
// 只有一个人也允许开局——机器人补位
await api2(`/tables/${botTable}/start`, { token: alice.token, method: 'POST' });

const botWs = connect(server2.wsBase, alice.token);
await botWs.ready;
botWs.send({ t: 'subscribe', tableId: botTable });

const botOpened = await waitFor(botWs, (s) => s.status === 'playing', '人机桌开局');
const botSeats = botOpened.players.filter((player) => player.bot);
assert.equal(botSeats.length, 1, '单人开局应补 1 个机器人');
assert.equal(botOpened.players.length, 2, '总共应有 2 个座位');
console.log(`✓ 单人开局补位成功：${botOpened.players.map((p) => p.name).join(' vs ')}`);

// 先把人类这一回合走完（打原野不换手，可能要走好几步），再等机器人动
let humanSteps = 0;
while (humanSteps < 12) {
  const current = botWs.state.snapshot;
  if (current.activePlayer !== alice.user.id) break;
  const move = current.legalMoves[0];
  if (!move) break;

  humanSteps += 1;
  const before = current.seq;
  botWs.send({ t: 'action', tableId: botTable, type: move.type, payload: move.payload });
  await waitFor(botWs, (s) => s.seq !== before, '人类动作生效');
}

const beforeBot = botWs.state.snapshot;
assert.notEqual(beforeBot.activePlayer, alice.user.id, '人类走完后应该轮到机器人');

const botMoved = await waitFor(botWs, (s) => s.seq > beforeBot.seq, '机器人自动行动', 8000);
console.log(`✓ 机器人自动走了一步：seq ${beforeBot.seq} → ${botMoved.seq}`);

// 机器人走的是和真人完全相同的通道，所以动作日志里能看到它的提交
const botActions = await db2.query(
  "SELECT actor, kind FROM match_actions WHERE table_id = $1 AND actor LIKE 'bot:%'",
  [botTable],
);
assert.ok(botActions.length >= 1, '动作日志里应有机器人提交的动作');
console.log(`✓ 机器人动作已入库（${botActions.length} 条，actor 形如 bot:…）`);
botWs.close();

/* ------------------------------ 撤销 / 不限时 ------------------------------ */

console.log('\n▶ 阶段十：回合内撤销 / 不限时房间');

const { id: calmTable } = await createTableWithRetry(api2, alice.token, {
  gameId: 'mandala',
  maxPlayers: 2,
  mode: 'turnbased',
  pace: 'none',
  // untimed 是游戏规则变体（不自动换手），和平台计时是两件事
  options: { untimed: true },
});
await api2(`/tables/${calmTable}/join`, { token: bob.token, method: 'POST' });
await api2(`/tables/${calmTable}/start`, { token: alice.token, method: 'POST' });

const calmWs = connect(server2.wsBase, alice.token);
await calmWs.ready;
calmWs.send({ t: 'subscribe', tableId: calmTable });

const calmOpened = await waitFor(calmWs, (s) => s.status === 'playing', '不限时桌开局');
assert.equal(calmOpened.deadlineAt, null, '不限时房间不应有截止时间');
console.log('✓ 不限时房间没有截止时间');

const mountainMove = calmOpened.legalMoves.find((move) => move.type === 'playMountain');
assert.ok(mountainMove, '应该有打到高山的合法动作');

calmWs.send({
  t: 'action',
  tableId: calmTable,
  type: mountainMove.type,
  payload: mountainMove.payload,
});
const afterPlay = await waitFor(calmWs, (s) => s.seq > calmOpened.seq, '打高山生效');
assert.equal(afterPlay.activePlayer, alice.user.id, '不限时房间不应自动换手');
assert.equal(afterPlay.view.data.undoCount, 0, '打高山抽了牌，这一步不能撤销');
console.log('✓ 打高山后仍轮到自己，但抽过牌，撤销栈被清空');

// 打原野不抽牌，仍然可以撤销
const fieldMove = afterPlay.legalMoves.find((move) => move.type === 'playField');
assert.ok(fieldMove, '应该有打原野的合法动作');

calmWs.send({
  t: 'action',
  tableId: calmTable,
  type: fieldMove.type,
  payload: fieldMove.payload,
});
const afterField = await waitFor(calmWs, (s) => s.seq > afterPlay.seq, '打原野生效');
assert.equal(afterField.view.data.undoCount, 1, '打原野不抽牌，可以撤销');
const handAfterField = afterField.view.data.you.hand.length;

calmWs.send({ t: 'action', tableId: calmTable, type: 'undo', payload: {} });
const afterUndo = await waitFor(calmWs, (s) => s.seq > afterField.seq, '撤销生效');
assert.equal(
  afterUndo.view.data.you.hand.length,
  handAfterField + 1,
  '撤销后手牌应回到打原野之前',
);
assert.equal(afterUndo.view.data.undoCount, 0, '撤销栈应被清空');
console.log('✓ 打原野可以撤销，手牌恢复；打高山不行');

calmWs.send({ t: 'action', tableId: calmTable, type: 'endTurn', payload: {} });
const afterEnd = await waitFor(calmWs, (s) => s.seq > afterUndo.seq, '结束回合生效');
assert.equal(afterEnd.activePlayer, bob.user.id, '只有主动结束回合才换人');
console.log('✓ 主动「结束回合」才换人');
calmWs.close();

/* ------------------------------ 账号 ------------------------------ */

console.log('\n▶ 阶段十一：注册 / 登录 / 登出 / 改密码');

await expectFailure(registerUser(api2, '鲍勃', 'another-pass-1'), 409, 'name_taken', '重名注册');
await expectFailure(registerUser(api2, '查理', '12345678'), 400, 'weak_password', '弱口令注册');
await expectFailure(
  api2('/auth/login', { method: 'POST', body: { name: '鲍勃', password: 'wrong-pass-1' } }),
  401,
  'invalid_credentials',
  '密码错误',
);
await expectFailure(
  api2('/auth/login', { method: 'POST', body: { name: '查无此人', password: 'nobody-pass-1' } }),
  401,
  'invalid_credentials',
  '账号不存在',
);
console.log('✓ 重名 409、弱口令 400、密码错/账号不存在都是 401 且不泄露"这个昵称在不在"');

const bobRelogin = await api2('/auth/login', {
  method: 'POST',
  body: { name: '鲍勃', password: PASSWORD.bob },
});
assert.equal(bobRelogin.user.id, bob.user.id, '重新登录应回到同一个账号');
console.log('✓ 密码正确时回到原账号（id 不变）');

const charlie = await registerUser(api2, '查理', 'charlie-smoke-2024');
assert.equal(charlie.user.isAdmin, false);

// 改密码后旧令牌必须立刻失效——这是 token_version 存在的唯一理由
const charlieRenewed = await api2('/auth/password', {
  token: charlie.token,
  method: 'POST',
  body: { oldPassword: 'charlie-smoke-2024', newPassword: 'charlie-smoke-2025' },
});
await expectFailure(
  api2('/me', { token: charlie.token }),
  401,
  'unauthorized',
  '改密码后的旧令牌',
);
const charlieMe = await api2('/me', { token: charlieRenewed.token });
assert.equal(charlieMe.user.id, charlie.user.id, '新令牌应该仍然有效');
await expectFailure(
  api2('/auth/login', {
    method: 'POST',
    body: { name: '查理', password: 'charlie-smoke-2024' },
  }),
  401,
  'invalid_credentials',
  '用旧密码登录',
);
console.log('✓ 改密码：旧令牌失效、新令牌可用、旧密码登不进');

const charlieFinal = await api2('/auth/login', {
  method: 'POST',
  body: { name: '查理', password: 'charlie-smoke-2025' },
});
await api2('/auth/logout', { token: charlieFinal.token, method: 'POST' });
await expectFailure(api2('/me', { token: charlieFinal.token }), 401, 'unauthorized', '登出后的旧令牌');
console.log('✓ 退出登录后令牌立刻作废（不只是前端删一下 localStorage）');

// 旧版本"输昵称即登录"留下的账号：没有密码，登录时提示去认领
const legacyId = randomUUID();
await db2.execute(
  `INSERT INTO users (id, name, created_at, is_admin, password_hash, token_version)
   VALUES ($1, $2, $3, false, NULL, 0)`,
  [legacyId, '老账号', Date.now()],
);
await expectFailure(
  api2('/auth/login', { method: 'POST', body: { name: '老账号', password: 'anything-1' } }),
  409,
  'password_not_set',
  '老账号直接登录',
);
const claimed = await api2('/auth/claim', {
  method: 'POST',
  body: { name: '老账号', password: 'legacy-pass-1' },
});
assert.equal(claimed.user.id, legacyId, '认领应落在原来那条记录上，战绩不丢');
const legacyMe = await api2('/me', { token: claimed.token });
assert.equal(legacyMe.user.id, legacyId);
await expectFailure(
  api2('/auth/claim', { method: 'POST', body: { name: '老账号', password: 'legacy-pass-2' } }),
  409,
  'claim_unavailable',
  '已认领的账号再认领',
);
console.log('✓ 老账号可认领一次，认领后原 id 不变、不能重复认领');

/* ------------------------------ 管理后台 ------------------------------ */

console.log('\n▶ 阶段十二：管理后台');

await expectFailure(api2('/admin/overview', { token: bob.token }), 403, 'forbidden', '非管理员看概览');
await expectFailure(api2('/admin/users', { token: bob.token }), 403, 'forbidden', '非管理员看用户列表');
await expectFailure(
  api2('/admin/plugins', { token: bob.token, method: 'POST', raw: buildPackage('9.9.9') }),
  403,
  'forbidden',
  '非管理员传插件',
);
console.log('✓ 非管理员的 /api/admin/* 一律 403');

const overview = await api2('/admin/overview', { token: alice.token });
assert.ok(overview.users.total >= 4, `用户数应不少于 4，实际 ${overview.users.total}`);
assert.ok(Array.isArray(overview.workers), '概览应带 worker 列表');
assert.ok(
  overview.games.some((game) => game.id === 'dice'),
  '概览应列出在线游戏',
);
assert.equal(overview.users.admins, 1, '当前应该只有爱丽丝一个管理员');
console.log(
  `✓ 概览：${overview.users.total} 个用户 / ${overview.workers.length} 个 worker / 数据库 ${overview.db}`,
);

const userList = await api2('/admin/users', { token: alice.token });
const aliceRow = userList.users.find((user) => user.id === alice.user.id);
const bobRow = userList.users.find((user) => user.id === bob.user.id);
assert.equal(aliceRow.isAdmin, true);
assert.equal(bobRow.isAdmin, false);
assert.equal(bobRow.hasPassword, true, '注册出来的账号应该有密码');
console.log('✓ 用户列表带权限、密码状态和局数');

await expectFailure(
  api2(`/admin/users/${alice.user.id}/admin`, {
    token: alice.token,
    method: 'POST',
    body: { isAdmin: false },
  }),
  400,
  'cannot_demote_self',
  '取消自己的管理员',
);
await expectFailure(
  api2('/admin/users/不存在的id/admin', {
    token: alice.token,
    method: 'POST',
    body: { isAdmin: true },
  }),
  404,
  'not_found',
  '改不存在的用户',
);
console.log('✓ 不能取消自己的管理员，也不接受不存在的用户');

await api2(`/admin/users/${bob.user.id}/admin`, {
  token: alice.token,
  method: 'POST',
  body: { isAdmin: true },
});
let bobAfter = (await api2('/admin/users', { token: alice.token })).users.find(
  (user) => user.id === bob.user.id,
);
assert.equal(bobAfter.isAdmin, true, '应已授予管理员');
await api2(`/admin/users/${bob.user.id}/admin`, {
  token: alice.token,
  method: 'POST',
  body: { isAdmin: false },
});
bobAfter = (await api2('/admin/users', { token: alice.token })).users.find(
  (user) => user.id === bob.user.id,
);
assert.equal(bobAfter.isAdmin, false, '应已收回管理员');
console.log('✓ 授予 / 收回管理员权限立即生效');

const charlieLogin = await api2('/auth/login', {
  method: 'POST',
  body: { name: '查理', password: 'charlie-smoke-2025' },
});
const reset = await api2(`/admin/users/${charlieLogin.user.id}/password`, {
  token: alice.token,
  method: 'POST',
  body: {},
});
assert.equal(reset.password.length, 12, '应生成 12 位临时口令');
await expectFailure(
  api2('/me', { token: charlieLogin.token }),
  401,
  'unauthorized',
  '重置密码后的旧令牌',
);
const reloginWithTemp = await api2('/auth/login', {
  method: 'POST',
  body: { name: '查理', password: reset.password },
});
assert.equal(reloginWithTemp.user.id, charlieLogin.user.id, '临时口令应能登回同一个账号');
console.log('✓ 重置密码：旧令牌立刻失效，12 位临时口令可登录');

const uploaded = await api2('/admin/plugins', {
  token: alice.token,
  method: 'POST',
  raw: buildPackage('0.2.2'),
});
assert.equal(uploaded.gameId, 'dice');
assert.equal(uploaded.version, '0.2.2');

const pluginList = await api2('/admin/plugins', { token: alice.token });
const v22 = pluginList.versions.find((item) => item.gameId === 'dice' && item.version === '0.2.2');
const v20 = pluginList.versions.find((item) => item.gameId === 'dice' && item.version === '0.2.0');
assert.equal(v22.status, 'active', '新版本应自动激活');
assert.equal(v22.loaded, true, '新版本应在内存里');
assert.equal(v20.status, 'retired', '旧版本应退役');
console.log('✓ 后台上传插件：0.2.2 生效、0.2.0 自动退役（服务没有重启）');

const gcResult = await api2('/admin/plugins/gc', { token: alice.token, method: 'POST' });
assert.ok(Array.isArray(gcResult.released), '回收应返回清单');
assert.ok(
  !gcResult.released.includes('dice@0.2.2'),
  '正在生效的版本不能被回收',
);
console.log(`✓ 回收：卸载 ${gcResult.released.join('、') || '（无）'}，内存里剩 ${gcResult.loaded.join('、')}`);

const adminBackup = await api2('/admin/backup', { token: alice.token, method: 'POST' });
assert.ok(adminBackup.bytes > 0, '备份文件不应为空');
assert.ok(adminBackup.counts.users >= 4, '备份应包含用户表');
console.log(`✓ 一键备份：${Object.keys(adminBackup.counts).length} 张表，${(adminBackup.bytes / 1024).toFixed(1)} KB`);

/* ------------------------------ 房间号 / 认负 / 再来一局 ------------------------------ */

console.log('\n▶ 阶段十三：房间号 / 随机加入 / 离开 / 认负 / 再来一局 / 版本公告');

// 先发一版带更新公告的插件
const NOTES = ['结算顺序调整：先手玩家优先选牌。', '修复撤销后手牌没有归位的问题。'];
const noted = await api2('/admin/plugins', {
  token: alice.token,
  method: 'POST',
  raw: buildPackage('0.2.3', NOTES),
});
assert.equal(noted.version, '0.2.3');

const { id: roomTable } = await createTableWithRetry(api2, alice.token, {
  gameId: 'dice',
  maxPlayers: 99,
});
const roomSnap = await api2(`/tables/${roomTable}`, { token: alice.token });
assert.equal(roomSnap.snapshot.gameVersion, '0.2.3', '新桌应该用最新版');
assert.equal(roomSnap.snapshot.maxPlayers, 4, '超过上限的座位数应被钳到游戏声明的 4');
const roomCode = roomSnap.snapshot.code;
assert.ok(/^[A-Z0-9]{6}$/.test(roomCode ?? ''), `房间号应是 6 位，实际 ${roomCode}`);
console.log(`✓ 新桌拿到 6 位房间号 ${roomCode}，座位数被钳到 4`);

assert.ok(roomSnap.snapshot.notice, '第一次进这个版本应该弹公告');
assert.equal(roomSnap.snapshot.notice.notes.length, NOTES.length);
assert.equal(roomSnap.snapshot.notice.version, '0.2.3');
console.log('✓ 没读过的版本会带出更新公告');

await api2('/notices/ack', {
  token: alice.token,
  method: 'POST',
  body: { gameId: 'dice', version: '0.2.3' },
});
const afterAck = await api2(`/tables/${roomTable}`, { token: alice.token });
assert.equal(afterAck.snapshot.notice, null, '读过的版本不应再弹');
console.log('✓ 「我知道了」之后同一版本不再弹');

// 房间号不区分大小写——念出来的东西不该逼人回忆大小写
const joined = await api2('/tables/join-by-code', {
  token: bob.token,
  method: 'POST',
  body: { code: roomCode.toLowerCase() },
});
assert.equal(joined.id, roomTable);
const bobSees = await api2(`/tables/${roomTable}`, { token: bob.token });
assert.equal(bobSees.snapshot.players.length, 2);
assert.ok(bobSees.snapshot.notice, 'bob 也还没读过这一版');
await api2('/notices/ack', {
  token: bob.token,
  method: 'POST',
  body: { gameId: 'dice', version: '0.2.3' },
});
console.log('✓ 按房间号加入（大小写不敏感），新玩家各弹一次公告');

await expectFailure(
  api2('/tables/join-by-code', { token: bob.token, method: 'POST', body: { code: 'ZZZZZZ' } }),
  400,
  'no_such_room',
  '加入不存在的房间号',
);

const mineForBob = await api2('/tables/mine', { token: bob.token });
assert.ok(
  mineForBob.tables.some((table) => table.id === roomTable),
  '「我的对局」里应该有这张桌',
);
assert.equal(
  mineForBob.tables.find((table) => table.id === roomTable).code,
  roomCode,
  '「我的对局」要带上房间号',
);
console.log('✓ 「我的对局」能找回进行中的桌（含房间号）');

// 离开：未开局时座位释放
await api2(`/tables/${roomTable}/leave`, { token: bob.token, method: 'POST' });
const afterLeave = await api2(`/tables/${roomTable}`, { token: alice.token });
assert.equal(afterLeave.snapshot.players.length, 1, '离开后应该少一个座位');
console.log('✓ 未开局时离开，座位释放');

// 房主离开 → 房主顺位转移
const { id: hostTable } = await createTableWithRetry(api2, alice.token, { gameId: 'dice' });
await api2('/tables/join-by-code', {
  token: bob.token,
  method: 'POST',
  body: { code: (await api2(`/tables/${hostTable}`, { token: alice.token })).snapshot.code },
});
await api2(`/tables/${hostTable}/leave`, { token: alice.token, method: 'POST' });
const afterHostLeave = await api2(`/tables/${hostTable}`, { token: bob.token });
assert.equal(afterHostLeave.snapshot.hostId, bob.user.id, '房主走了，房主应该交给下一个人');
assert.equal(afterHostLeave.snapshot.you.isHost, true);
console.log('✓ 房主离开后，房主顺位交给下一个人');

// 再加回房间桌并开局，然后认负
await api2('/tables/join-by-code', {
  token: bob.token,
  method: 'POST',
  body: { code: roomCode },
});
await api2(`/tables/${roomTable}/start`, { token: alice.token, method: 'POST' });
const startedSnap = await api2(`/tables/${roomTable}`, { token: bob.token });
assert.equal(startedSnap.snapshot.status, 'playing');

await api2(`/tables/${roomTable}/forfeit`, { token: alice.token, method: 'POST' });
const forfeited = await api2(`/tables/${roomTable}`, { token: bob.token });
assert.equal(forfeited.snapshot.status, 'finished', '认负后对局应立即结束');

const forfeitRows = await db2.query(
  'SELECT user_id, rank, is_win FROM match_results WHERE table_id = $1 ORDER BY rank',
  [roomTable],
);
assert.equal(forfeitRows.length, 2, '认负也要落战绩');
assert.equal(forfeitRows[0].user_id, bob.user.id, '没认负的人第一');
assert.equal(forfeitRows[0].is_win, true);
assert.equal(forfeitRows[1].user_id, alice.user.id, '认负的人排最后');
assert.equal(forfeitRows[1].is_win, false);
console.log('✓ 认负：对局立刻结束，认负者判负，战绩和 Elo 照常记');

// 再来一局：版本必须跟原桌一致
const { id: nextTable } = await api2(`/tables/${roomTable}/rematch`, {
  token: bob.token,
  method: 'POST',
});
const nextSnap = await api2(`/tables/${nextTable}`, { token: bob.token });
assert.equal(nextSnap.snapshot.status, 'lobby');
assert.equal(nextSnap.snapshot.gameVersion, '0.2.3', '再来一局必须沿用原桌版本');
assert.equal(nextSnap.snapshot.players.length, 1, '认负退出的人不该被拉进下一局');
assert.equal(nextSnap.snapshot.players[0].id, bob.user.id);
assert.notEqual(nextSnap.snapshot.code, roomCode, '新桌要有新的房间号');
console.log('✓ 再来一局：沿用原版本、不带认负退出的人，房间号是新的');

// 随机加入：一定给你一张能坐的桌
let quick = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  try {
    quick = await api2('/tables/quick-match', {
      token: bob.token,
      method: 'POST',
      body: { gameId: 'dice' },
    });
    break;
  } catch (error) {
    if (error.status !== 429) throw error;
    await sleep(1200);
  }
}
assert.ok(quick, '随机加入应该成功');
const quickSnap = await api2(`/tables/${quick.id}`, { token: bob.token });
assert.ok(
  quickSnap.snapshot.players.some((player) => player.id === bob.user.id),
  '随机加入之后必须在座位里',
);
assert.equal(quickSnap.snapshot.status, 'lobby');
console.log(`✓ 随机加入：${quick.created ? '没有等人的桌，现开了一张' : '进了一张正在等人的桌'}`);

// 确定性扫描只针对服务端代码：客户端用 Date.now() 做动画是合法的
await expectFailure(
  api2('/admin/plugins', {
    token: alice.token,
    method: 'POST',
    raw: buildPackage('0.9.9', null, 'export const _now = Date.now();'),
  }),
  400,
  'nondeterministic',
  '服务端用了 Date.now',
);
console.log('✓ 服务端代码里出现 Date.now() 会被发布流水线挡下（客户端不受这条约束）');

/* ------------------------------ 即时房间限制 ------------------------------ */

const realtimeBody = { gameId: 'dice', maxPlayers: 2, mode: 'realtime', pace: 'slow' };
// 用一个全新账号：别人身上可能还挂着之前建的即时桌
const realtimeProbe = await registerUser(api2, '即时测试', 'rt-solo-123456');
const { id: realtimeOne } = await api2('/tables', {
  token: realtimeProbe.token,
  method: 'POST',
  body: realtimeBody,
});
await expectFailure(
  api2('/tables', { token: realtimeProbe.token, method: 'POST', body: realtimeBody }),
  409,
  'already_in_realtime',
  '一个人同时只能占一个即时房',
);
await api2(`/tables/${realtimeOne}/leave`, { token: realtimeProbe.token, method: 'POST' });
console.log('✓ 即时制：一个人同时只能占一个实时房（等待中的也算）');

/* ------------------------------ 收尾 ------------------------------ */

clients2.alice.close();
clients2.bob.close();
await server2.app.close();
await db2.close();
rmSync(workDir, { recursive: true, force: true });

console.log('\n全部通过 ✅');
process.exit(0);
