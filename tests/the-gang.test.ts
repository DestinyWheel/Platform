/**
 * 纸牌帮：牌力评估 + 一次完整抢劫的状态机。
 *
 * 单独一个文件，跑法：node --import tsx --test tests/the-gang.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createInitialState } from '../packages/engine/src/index.ts';
import theGang from '../games/the-gang/src/server.ts';
import { categoryName, compareScores, evaluate } from '../games/the-gang/src/poker.ts';

const SETUP = {
  players: ['a', 'b', 'c'],
  options: {},
  seed: 20240101,
  now: 1_700_000_000_000,
};

test('纸牌帮：牌型评估', () => {
  const royal = evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts']);
  assert.equal(royal[0], 8);
  assert.equal(categoryName(royal), '皇家同花顺');

  // A 当小的轮子顺
  const wheel = evaluate(['Ah', '2c', '3d', '4s', '5h']);
  assert.equal(wheel[0], 4);
  assert.equal(wheel[1], 5, 'A-2-3-4-5 是 5 高的顺子');

  // K-A-2-3-4 不算顺子
  const illegal = evaluate(['Kh', 'Ac', '2d', '3s', '4h']);
  assert.equal(illegal[0], 0, 'K-A-2-3-4 不合法，只能当高牌');

  // 7 选 5：底牌对 A + 公共牌 K K 7 3 2 → 两对 A/K
  const twoPair = evaluate(['Ah', 'Ad', 'Kh', 'Kd', '7c', '3s', '2h']);
  assert.equal(twoPair[0], 2);
  assert.equal(twoPair[1], 14);
  assert.equal(twoPair[2], 13);

  // 葫芦赢同花
  const fullHouse = evaluate(['Ah', 'Ad', 'Kc', 'Kd', 'Kh', '7c', '3s']);
  const flush = evaluate(['Ah', 'Kh', 'Qh', 'Jh', '2h', '3s', '4c']);
  assert.equal(compareScores(fullHouse, flush), 1);

  // 真平局：公共牌就是最好的五张
  const board = ['As', 'Ks', 'Qs', 'Js', 'Ts'];
  const left = evaluate([...board, '2h', '3h']);
  const right = evaluate([...board, '4c', '5c']);
  assert.equal(compareScores(left, right), 0, '五张公共牌摊开时两家应完全打平');
});

test('纸牌帮：抢筹码与四轮推进', () => {
  const created = createInitialState(theGang, SETUP);
  let state = created.state;
  assert.equal(state.players.length, 3);
  assert.equal(state.hands.a!.length, 2, '每人两张底牌');
  assert.equal(state.community.length, 0, '第一轮没有公共牌');

  const play = (player: string, type: string, payload: unknown) => {
    state = applyAction(theGang, state, player, { type, payload }, 1).state;
  };

  play('a', 'takeChip', { star: 2 });
  assert.equal(state.chips.a![0], 2);

  // b 把 a 的筹码抢走：a 的筹码作废、确认也失效
  play('a', 'confirm', {});
  play('b', 'takeChip', { star: 2 });
  assert.equal(state.chips.a![0], null, '被抢走的筹码要清空');
  assert.equal(state.ready.a, false, '被抢以后要重新确认');

  play('a', 'takeChip', { star: 1 });
  play('b', 'confirm', {});
  play('c', 'takeChip', { star: 3 });
  play('a', 'confirm', {});
  play('c', 'confirm', {});

  state = state as never;
  const afterRound = state as typeof created.state;
  assert.equal(afterRound.round, 2, '三个人都确认后进第二轮');
  assert.equal(afterRound.community.length, 3, '翻牌轮翻开三张公共牌');
  assert.equal(afterRound.phase, 'draft');
});

test('纸牌帮：摊牌顺序错了就是一次警报', () => {
  const created = createInitialState(theGang, SETUP);
  const state = created.state;

  // 手搭一个局面：1 星拿了对 A，2 星只有高牌 → 必须判失败
  state.community = ['2c', '7d', '9s', 'Jh', '4d'];
  state.hands = { a: ['Ah', 'Ad'], b: ['Kh', 'Qc'], c: ['9d', '9h'] };
  state.chips = { a: [null, null, null, 1], b: [null, null, null, 2], c: [null, null, null, 3] };
  state.round = 5;

  theGang.states.showdown!.onEnter!(state, {
    playerId: 'a',
    players: state.players,
    now: 1,
    rng: () => 0.5,
    emit: () => undefined,
    goTo: () => undefined,
    state,
  } as never);

  assert.equal(state.last?.ok, false);
  assert.equal(state.last?.badAt, 1, '第二个亮牌的人比第一个弱');
  assert.equal(state.revealed, true);

  theGang.states.heistEnd!.onEnter!(state, {
    playerId: 'a',
    players: state.players,
    now: 1,
    rng: () => 0.5,
    emit: () => undefined,
    goTo: () => undefined,
    state,
  } as never);

  assert.equal(state.alarms, 1);
  assert.equal(state.vaults, 0);
});
