import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createInitialState } from '../packages/engine/src/index.ts';
import theGang, { dealHeist } from '../games/the-gang/src/server.ts';
import { effectsOf } from '../games/the-gang/src/cards.ts';

const SETUP = { players: ['a', 'b', 'c'], options: {}, seed: 99, now: 1_700_000_000_000 };

/** 自动把一局打完（所有人按座位顺序拿筹码、确认、继续），返回终局状态 */
function playOut(state, players) {
  let guard = 0;
  while (!state.finished) {
    guard += 1;
    if (guard > 5000) throw new Error('卡住了');
    if (state.phase === 'heistResult') {
      state = applyAction(theGang, state, players[0], { type: 'advance', payload: {} }, 1).state;
      continue;
    }
    if (state.phase === 'guess') {
      const guess = state.guess;
      for (const player of players) {
        if (player === guess.target) continue;
        state = applyAction(
          theGang,
          state,
          player,
          { type: 'guess', payload: { value: guess.kind === 'value' ? 'A' : 'highcard' } },
          1,
        ).state;
        if (state.phase !== 'guess') break;
      }
      continue;
    }
    const roundIndex = state.round - 1;
    let acted = false;
    for (const player of players) {
      if (state.chips[player][roundIndex] == null) {
        const taken = new Set(players.map((p) => state.chips[p][roundIndex]));
        const star = [1, 2, 3].find((value) => !taken.has(value));
        state = applyAction(theGang, state, player, { type: 'takeChip', payload: { star } }, 1).state;
        acted = true;
        break;
      }
    }
    if (acted) continue;
    const notReady = players.find((p) => !state.ready[p]);
    if (notReady) {
      state = applyAction(theGang, state, notReady, { type: 'confirm', payload: {} }, 1).state;
      continue;
    }
    throw new Error(`阶段 ${state.phase} 没人能动了`);
  }
  return state;
}

test('纸牌帮：四档难度的开局形态', () => {
  const basic = createInitialState(theGang, { ...SETUP, options: { mode: 'basic' } }).state;
  assert.equal(basic.mode, 'basic');
  assert.equal(basic.challenge.length, 0, '基础局不带卡');
  assert.equal(basic.alarmsToLose, 3);

  const advanced = createInitialState(theGang, { ...SETUP, options: { mode: 'advanced' } }).state;
  assert.equal(advanced.challenge.length, 0, '进阶第一次抢劫也不带卡');
  assert.equal(advanced.stacks.challenge.length, 10);
  assert.equal(advanced.stacks.specialist.length, 10);

  const pro = createInitialState(theGang, { ...SETUP, options: { mode: 'professional' } }).state;
  assert.ok(pro.permanent != null, '专业模式有一张整局有效的挑战卡');
  assert.equal(pro.challenge.length, 1);
  assert.ok(pro.permanent !== 1 && !pro.stacks.challenge.includes(1), '专业模式没有快速通道');

  const master = createInitialState(theGang, { ...SETUP, options: { mode: 'master' } }).state;
  assert.equal(master.alarmsToLose, 2, '大师模式两次警报就输');
  assert.equal(master.challenge.length, 2, '大师模式永远两张挑战卡');
  assert.equal(master.stacks.specialist.length, 0, '大师模式没有专家卡');
});

test('纸牌帮：挑战卡的开关', () => {
  assert.equal(effectsOf([1]).skipFirst, true);
  assert.equal(effectsOf([5]).skipThird, true);
  assert.equal(effectsOf([2]).lockLow, true);
  assert.equal(effectsOf([6]).lockHigh, true);
  assert.equal(effectsOf([8]).blackout, true);
  assert.equal(effectsOf([10]).pocketSize, 3);
  assert.equal(effectsOf([3]).redraw, 'face');
  assert.equal(effectsOf([7]).redraw, 'noFace');
  assert.equal(effectsOf([4]).guess, 'value');
  assert.equal(effectsOf([9]).guess, 'rank');
  assert.equal(effectsOf([]).pocketSize, 2);
});

test('纸牌帮：挑战卡真的改了规则', () => {
  const make = () => createInitialState(theGang, { ...SETUP, options: { mode: 'basic' } }).state;

  // 快速通道：没有第一轮，直接翻 3 张进翻牌轮
  const quick = make();
  quick.challenge = [1];
  dealHeist(quick, () => 0.5);
  assert.equal(quick.round, 2, '跳过翻牌前');
  assert.equal(quick.community.length, 3);

  // 安全摄像头：每人 3 张底牌
  const cameras = make();
  cameras.challenge = [10];
  dealHeist(cameras, () => 0.5);
  assert.equal(cameras.hands.a.length, 3);
  assert.equal(cameras.effects.pocketSize, 3);

  // 断电：第二轮开始时丢掉第一轮的筹码
  const blackout = make();
  blackout.challenge = [8];
  dealHeist(blackout, () => 0.5);
  blackout.chips.a[0] = 1;
  blackout.chips.b[0] = 2;
  blackout.chips.c[0] = 3;
  theGang.states.nextRound.onEnter!(blackout, {
    playerId: 'a',
    players: blackout.players,
    now: 1,
    rng: () => 0.5,
    emit: () => undefined,
    goTo: () => undefined,
    state: blackout,
  } as never);
  assert.equal(blackout.chips.a[0], null, '上一轮筹码被清空');
  assert.deepEqual(blackout.blackoutRounds, [1]);
});

test('纸牌帮：大师模式能打完，且两张挑战卡会轮换', () => {
  const start = createInitialState(theGang, { ...SETUP, options: { mode: 'master' } }).state;
  const first = [...start.challenge].sort((left, right) => left - right);

  const state = playOut(start, SETUP.players);
  assert.equal(state.finished, true);
  assert.ok(state.alarms <= 2);
  assert.equal(state.alarms <= 2, true, '两次警报就结束');
  assert.equal(state.challenge.length, 2, '结束时仍然两张卡');

  if (state.heist > 1) {
    assert.notDeepEqual([...state.challenge].sort((l, r) => l - r), first, '换过抢劫就会换卡');
  }
});
