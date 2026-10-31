/**
 * 单元测试：纯函数层。
 *
 * 端到端（scripts/smoke.mjs）证明"整套能跑"，这里补的是"每一块单独对不对"——
 * 这两者覆盖的东西不一样，前者挂了很难定位，后者挂了能直接指出哪个函数坏了。
 *
 * 跑法：pnpm test（= node --import tsx --test tests/unit.test.ts）
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  RuleError,
  activePlayerOf,
  applyAction,
  createInitialState,
  legalActions,
} from '../packages/engine/src/index.ts';
import { computeDeltas, expectedScore, kFactor } from '../apps/server/src/elo.ts';
import { checkPasswordInput, hashPassword, verifyPassword } from '../apps/server/src/password.ts';
import { signToken, verifyToken } from '../apps/server/src/auth.ts';
import { INVITE_CODE_LENGTH, ROOM_CODE_LENGTH, randomCode } from '../apps/server/src/codes.ts';
import { hashState } from '../apps/server/src/hash.ts';
import dice from '../games/dice/src/server.ts';
import mandala from '../games/mandala/src/server.ts';

const SETUP = {
  players: ['p1', 'p2'],
  options: {},
  seed: 12345,
  now: 1_700_000_000_000,
};

/* ------------------------------ 引擎 ------------------------------ */

test('同一 seed 建出来的局面完全一致', () => {
  const a = createInitialState(dice, SETUP).state;
  const b = createInitialState(dice, SETUP).state;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(hashState(a), hashState(b));
});

test('不同 seed 建出来的局面不一定一样，但结构合法', () => {
  const a = createInitialState(dice, { ...SETUP, seed: 1 }).state;
  const b = createInitialState(dice, { ...SETUP, seed: 2 }).state;
  assert.equal(a.players.length, 2);
  assert.equal(b.players.length, 2);
  assert.equal(a.finished, false);
});

test('轮到谁就只允许谁行动', () => {
  const { state } = createInitialState(dice, SETUP);
  const active = activePlayerOf(dice, state);
  assert.equal(active, 'p1', '先手应该是 players[0]');

  // 非当前玩家提交 → 规则错误
  assert.throws(
    () => applyAction(dice, state, 'p2', { type: 'roll' }, SETUP.now),
    (error: unknown) => error instanceof RuleError,
  );

  const after = applyAction(dice, state, 'p1', { type: 'roll' }, SETUP.now).state;
  assert.notEqual(activePlayerOf(dice, after), 'p1', '走完之后应该换人');
  assert.equal(state.turn, 0, '原状态不能被就地改掉（纯函数）');
});

test('未知动作直接拒绝', () => {
  const { state } = createInitialState(dice, SETUP);
  assert.throws(
    () => applyAction(dice, state, 'p1', { type: 'nope' }, SETUP.now),
    (error: unknown) => error instanceof RuleError && error.code === 'unknown_action',
  );
});

test('legalActions 只给当前玩家', () => {
  const { state } = createInitialState(dice, SETUP);
  assert.ok(legalActions(dice, state, 'p1').includes('roll'));
  assert.deepEqual(legalActions(dice, state, 'p2'), []);
});

test('视图不泄漏内部字段', () => {
  const { state } = createInitialState(dice, SETUP);
  const view = dice.view(state, 'spectator');
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('rngSeed'), false, '视图里不该出现随机种子');
  assert.equal(view.players.length, 2);
});

/* ------------------------------ 哈希 ------------------------------ */

test('稳定序列化：键序不同但内容相同 → 同一个哈希', () => {
  assert.equal(hashState({ a: 1, b: 2 }), hashState({ b: 2, a: 1 }));
  assert.notEqual(hashState({ a: 1 }), hashState({ a: 2 }));
  assert.equal(hashState({ nested: [{ x: 1, y: 2 }] }), hashState({ nested: [{ y: 2, x: 1 }] }));
});

/* ------------------------------ Elo ------------------------------ */

test('Elo 零和：赢家涨的正好是输家掉的', () => {
  const deltas = computeDeltas([
    { userId: 'a', rating: 1500, games: 0, rank: 1 },
    { userId: 'b', rating: 1500, games: 0, rank: 2 },
  ]);
  const a = deltas.get('a')!;
  const b = deltas.get('b')!;
  assert.ok(a > 0 && b < 0);
  assert.equal(a + b, 0);
});

test('Elo 平局双方都不动分（新人 K 大也一样）', () => {
  const deltas = computeDeltas([
    { userId: 'a', rating: 1500, games: 0, rank: 1 },
    { userId: 'b', rating: 1500, games: 0, rank: 1 },
  ]);
  assert.equal(deltas.get('a'), 0);
  assert.equal(deltas.get('b'), 0);
});

test('Elo 弱者赢强者涨得更多', () => {
  const normal = computeDeltas([
    { userId: 'a', rating: 1500, games: 20, rank: 1 },
    { userId: 'b', rating: 1500, games: 20, rank: 2 },
  ]).get('a')!;
  const upset = computeDeltas([
    { userId: 'a', rating: 1200, games: 20, rank: 1 },
    { userId: 'b', rating: 1800, games: 20, rank: 2 },
  ]).get('a')!;
  assert.ok(upset > normal, `爆冷应该涨更多（${upset} vs ${normal}）`);
});

test('K 因子按场次递减，期望分随分差变化', () => {
  assert.equal(kFactor(0), 40);
  assert.equal(kFactor(10), 28);
  assert.equal(kFactor(30), 20);
  assert.ok(expectedScore(1500, 1500) === 0.5);
  assert.ok(expectedScore(1800, 1500) > 0.5);
});

test('多人局：平分时一局的变动不随人数膨胀', () => {
  const four = computeDeltas([
    { userId: 'a', rating: 1500, games: 20, rank: 1 },
    { userId: 'b', rating: 1500, games: 20, rank: 2 },
    { userId: 'c', rating: 1500, games: 20, rank: 3 },
    { userId: 'd', rating: 1500, games: 20, rank: 4 },
  ]);
  const sum = [...four.values()].reduce((acc, value) => acc + value, 0);
  assert.equal(sum, 0, '多人局也要零和');
});

/* ------------------------------ 密码 ------------------------------ */

test('密码哈希：能校验、不能反推、格式带参数', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(hash.startsWith('scrypt$'), true);
  assert.equal(hash.split('$').length, 6);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse battery ', hash), false);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('同一个密码两次哈希结果不同（盐不同）', async () => {
  const a = await hashPassword('same-password-123');
  const b = await hashPassword('same-password-123');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password-123', a), true);
  assert.equal(await verifyPassword('same-password-123', b), true);
});

test('没有密码的账号校验一定失败', async () => {
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', 'garbage'), false);
});

test('密码强度规则', () => {
  assert.equal(checkPasswordInput('short', 'nobody'), '密码至少 8 位');
  assert.equal(checkPasswordInput('aaaaaaaa', 'nobody'), '密码太简单了，换一个');
  assert.equal(checkPasswordInput('password', 'nobody'), '这个密码太常见了，换一个');
  assert.equal(checkPasswordInput('alice-smoke-2024', 'alice-smoke-2024'), '密码不能和昵称一样');
  assert.equal(checkPasswordInput('alice-smoke-2024', 'alice'), null);
});

/* ------------------------------ 令牌 ------------------------------ */

test('令牌：签发 → 校验，篡改立刻失效', () => {
  const token = signToken({ id: 'u1', name: '爱丽丝' }, { tokenVersion: 3 });
  const payload = verifyToken(token);
  assert.equal(payload?.id, 'u1');
  assert.equal(payload?.name, '爱丽丝');
  assert.equal(payload?.ver, 3);

  const [header, body, sig] = token.split('.');
  const forged = `${header}.${body.slice(0, -2)}xx.${sig}`;
  assert.equal(verifyToken(forged), null);
  assert.equal(verifyToken('not-a-token'), null);
  assert.equal(verifyToken(''), null);
});

test('令牌：ver 不同代表不同会话版本', () => {
  const a = verifyToken(signToken({ id: 'u1', name: 'x' }, { tokenVersion: 0 }));
  const b = verifyToken(signToken({ id: 'u1', name: 'x' }, { tokenVersion: 1 }));
  assert.equal(a?.ver, 0);
  assert.equal(b?.ver, 1);
});

test('令牌：过期的验证不过', () => {
  // 手工造一个 exp 已经过去的令牌：签名是对的，但时间不对
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub: 'u1', name: 'x', ver: 0, iat: 1, exp: Date.now() - 1000 }),
  ).toString('base64url');
  const sig = createHmac('sha256', process.env.JWT_SECRET ?? 'dev-secret-change-me')
    .update(`${header}.${body}`)
    .digest('base64url');
  assert.equal(verifyToken(`${header}.${body}.${sig}`), null);
});

/* --------------------------- 前端令牌同步 --------------------------- */
test('前端：保存会话后请求立刻带上 Authorization（不等 React 副作用）', async () => {
  // 回归测试。曾经令牌只在 App 的 useEffect 里设置，而 React 的子组件副作用先于父组件，
  // 登录后 Lobby 的挂载请求会先一步发出去、没带令牌，被 401 踢回登录页。
  const memory = new Map<string, string>();
  const globals = globalThis as unknown as Record<string, unknown>;

  globals.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  };

  const seen: Record<string, string>[] = [];
  globals.fetch = async (_url: string, init: { headers?: Record<string, string> } = {}) => {
    seen.push(init.headers ?? {});
    return { ok: true, status: 200, text: async () => JSON.stringify({ tables: [] }) };
  };

  const { saveSession, setAuthToken, api } = await import('../apps/web/src/api.ts');
  const last = () => seen[seen.length - 1] ?? {};
  try {
    saveSession({ token: 'tok-abc', user: { id: 'u1' } as never });
    await api.myTables();
    assert.equal(last().authorization, 'Bearer tok-abc');

    saveSession(null);
    await api.myTables();
    assert.equal(last().authorization, undefined);

    setAuthToken('tok-xyz');
    await api.myTables();
    assert.equal(last().authorization, 'Bearer tok-xyz');
  } finally {
    setAuthToken(null);
    delete globals.localStorage;
    delete globals.fetch;
  }
});

/* ------------------------------ 短码 ------------------------------ */

test('邀请码/房间码：长度对、字符集不含看错的 0 O 1 I L', () => {
  for (let index = 0; index < 200; index += 1) {
    assert.match(randomCode(INVITE_CODE_LENGTH), /^[A-HJ-NP-Z2-9]{8}$/);
    assert.match(randomCode(ROOM_CODE_LENGTH), /^[A-HJ-NP-Z2-9]{6}$/);
  }
});

/* ------------------------------ 曼荼罗规则 ------------------------------ */

/** 造一个"轮到 p1、手里是这手牌"的局面，直接调插件的 validate */
function mandalaProbe(hand: number[]) {
  const created = createInitialState(mandala, {
    players: ['p1', 'p2'],
    options: {},
    seed: 7,
    now: 1_700_000_000_000,
  } as never) as { state: Record<string, unknown> };

  const state = created.state as {
    players: string[];
    hands: Record<string, number[]>;
    turn: number;
    mandalas: { fields: Record<number, number>[]; mountain: Record<number, number> }[];
  };
  const me = state.players[0]!;
  state.hands[me] = [...hand];
  state.turn = 0;

  const validate = (type: 'playMountain' | 'playField' | 'discard', payload: unknown) =>
    mandala.actions[type]!.validate!(state as never, { type, payload } as never, {
      playerId: me,
    } as never);

  return { state, me, validate };
}

test('曼荼罗：打高山也要避开两个原野里已有的颜色', () => {
  // 曾经把这条规则写进介绍时写成了"任何颜色都能进高山"——代码一直是对的，
  // 但那条错误描述说明这个点值得钉死：高山的合法性取决于两个原野。
  const probe = (fields: Record<number, number>[], card: number) => {
    const { state, validate } = mandalaProbe([1, 2]);
    state.mandalas[0] = { fields: [fields[0] ?? {}, fields[1] ?? {}], mountain: {} };
    return validate('playMountain', { card, mandala: 0 });
  };

  assert.deepEqual(probe([{}, {}], 0), { ok: true }, '两个原野都空时，颜色可以进高山');
  assert.deepEqual(
    probe([{ 1: 1 }, {}], 0),
    { ok: false, reason: 'color.conflict' },
    '自己的原野已经有这个颜色，就不能再打高山',
  );
  assert.deepEqual(
    probe([{}, { 1: 1 }], 0),
    { ok: false, reason: 'color.conflict' },
    '对方原野有这个颜色，同样不能打高山',
  );
  assert.deepEqual(probe([{ 1: 1 }, {}], 1), { ok: true }, '换成别的颜色照样能打');
});

test('曼荼罗：弃牌只能弃同一种颜色', () => {
  const probe = (hand: number[], cards: number[]) => mandalaProbe(hand).validate('discard', { cards });

  assert.deepEqual(probe([1, 1, 2], [0, 1]), { ok: true }, '同色两张可以一起弃');
  assert.deepEqual(probe([1, 1, 2], [0]), { ok: true }, '单张当然可以');
  assert.deepEqual(
    probe([1, 1, 2], [0, 2]),
    { ok: false, reason: 'discard.same.color' },
    '一红一黄混着弃不行',
  );
  assert.deepEqual(
    probe([1, 1, 2], [0, 1, 2]),
    { ok: false, reason: 'discard.same.color' },
    '混色即使张数对也不行',
  );
});

test('曼荼罗：抽过牌的动作不能撤销', () => {
  // 不限时的房间里换手不会发生，撤销栈只有靠动作自己清——这里就测这个
  const play = (type: 'playField' | 'playMountain' | 'discard', payload: unknown) => {
    const { state, me } = mandalaProbe([1, 2, 3]);
    (state as unknown as { untimed: boolean }).untimed = true;
    state.mandalas[0] = { fields: [{}, {}], mountain: {} };
    mandala.actions[type]!.reduce!(state as never, { type, payload } as never, {
      playerId: me,
      emit: () => undefined,
      goTo: () => undefined,
    } as never);
    return (state as unknown as { undo: string[] }).undo;
  };

  assert.equal(play('playField', { card: 0, mandala: 0 }).length, 1, '打原野不抽牌，可以撤销');
  assert.equal(
    play('playMountain', { card: 0, mandala: 0 }).length,
    0,
    '打高山抽了牌，撤销栈必须清空',
  );
  assert.equal(play('discard', { cards: [0] }).length, 0, '弃牌抽了牌，撤销栈必须清空');
});

