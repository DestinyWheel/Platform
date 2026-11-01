/**
 * 纸牌帮自定义模式：配置、卡堆、胜负条件。
 *
 * 这些逻辑全在 reducer 里，单测能直接跑。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import theGang from '../games/the-gang/src/server.ts';
import { effectsOf } from '../games/the-gang/src/cards.ts';
import { applyAction, createInitialState } from '../packages/engine/src/index.ts';

const SETUP = {
  players: ['p1', 'p2', 'p3'],
  options: { mode: 'custom' },
  seed: 2024,
  now: 1_700_000_000_000,
};

const custom = () => createInitialState(theGang, SETUP).state;

/** 直接发牌（默认配置） */
const dealt = (patch: Record<string, unknown> = {}) => {
  let state = custom();
  if (Object.keys(patch).length > 0) {
    state = applyAction(theGang, state, 'p1', { type: 'configure', payload: patch }, 1).state;
  }
  state = applyAction(theGang, state, 'p1', { type: 'deal', payload: {} }, 1).state;
  return state;
};

/** 把一次抢劫判成功 / 失败，然后走完 heistEnd */
const finishHeist = (state: ReturnType<typeof custom>, ok: boolean) => {
  state.last = {
    heist: state.heist,
    ok,
    seats: [],
    community: [],
    badAt: null,
    guess: null,
    challenge: [...state.challenge],
    specialist: state.specialist,
  };
  theGang.states.heistEnd.onEnter!(state, {
    playerId: 'p1',
    players: state.players,
    now: 0,
    rng: () => 0.5,
    emit: () => undefined,
    goTo: () => undefined,
    state,
  } as never);
  return state;
};

test('自定义模式：开局停在设置阶段，发牌才开始', () => {
  const state = custom();
  assert.equal(state.phase, 'setup');
  assert.equal(state.challenge.length, 0);
  assert.equal(state.config.vaultsToWin, 3);
  assert.equal(state.config.alarmsToLose, 3);

  const after = applyAction(theGang, state, 'p2', { type: 'deal', payload: {} }, 1).state;
  assert.equal(after.phase, 'draft');
  assert.equal(after.hand ?? after.hands['p1']!.length, 2, '每人 2 张底牌');
});

test('自定义模式：金库数 / 警报数可以改', () => {
  const state = applyAction(theGang, custom(), 'p1', {
    type: 'configure',
    payload: { vaultsToWin: 1, alarmsToLose: 5 },
  }, 1).state;
  assert.equal(state.config.vaultsToWin, 1);
  assert.equal(state.config.alarmsToLose, 5);
  assert.equal(state.alarmsToLose, 5, '老的 alarmsToLose 字段要跟着同步');
});

test('自定义模式：关掉专家卡之后，失败也不发', () => {
  const state = dealt({ specialist: false, challenge: false });
  finishHeist(state, false);
  assert.equal(state.specialist, null);
  assert.deepEqual(state.challenge, []);
});

test('自定义模式：挑战卡叠加开 = 多张并存，关 = 新的替换旧的', () => {
  const stacked = dealt({ specialist: false, challenge: true, stack: true });
  finishHeist(stacked, true);
  assert.equal(stacked.challenge.length, 1);
  finishHeist(stacked, true);
  assert.equal(stacked.challenge.length, 2, '叠加开：两次成功就有两张');

  const replaced = dealt({ specialist: false, challenge: true, stack: false });
  finishHeist(replaced, true);
  finishHeist(replaced, true);
  assert.equal(replaced.challenge.length, 1, '叠加关：永远只有一张');
});

test('自定义模式：常驻挑战卡从第一次抢劫就生效', () => {
  const state = dealt({ permanent: [1, 10] });
  assert.deepEqual(state.challenge, [1, 10]);
  assert.equal(state.effects.skipFirst, true, '快速通道生效');
  assert.equal(state.effects.pocketSize, 3, '安全摄像头生效');
});

test('自定义模式：金库只要一个就算赢', () => {
  const state = dealt({ vaultsToWin: 1, alarmsToLose: 3 });
  finishHeist(state, true);
  assert.equal(state.finished, true);
  assert.equal(state.vaults, 1);
});

test('自定义模式：一次警报就输', () => {
  const state = dealt({ vaultsToWin: 3, alarmsToLose: 1 });
  finishHeist(state, false);
  assert.equal(state.finished, true);
  assert.equal(state.alarms, 1);
});

test('匆忙撤离：跳过第三轮时要翻出第 5 张公共牌', () => {
  const state = dealt({ challenge: true, stack: false });
  state.challenge = [5];
  state.effects = effectsOf([5]);
  state.round = 2;
  state.community = ['AS', 'KS', 'QS'];
  theGang.states.nextRound.onEnter!(state, {
    playerId: 'p1',
    players: state.players,
    now: 0,
    rng: () => 0.5,
    emit: () => undefined,
    goTo: () => undefined,
    state,
  } as never);

  assert.equal(state.round, 4);
  assert.equal(state.community.length, 5, '转牌 + 河牌都要发出来');
});

test('专业模式：失败之后会发专家卡（原来只有进阶发）', () => {
  const { state } = createInitialState(theGang, { ...SETUP, options: { mode: 'professional' } });
  assert.equal(state.challenge.length, 1, '开局那张常驻挑战卡');
  finishHeist(state, false);
  assert.ok(state.specialist != null, '专业模式失败也应发专家卡');
  assert.equal(state.challenge.length, 1, '常驻卡还在');
});
