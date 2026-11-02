/**
 * 璀璨宝石：对决 —— 卡表、拿 token、购买、Royal、预购可见窗口。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createInitialState } from '../packages/engine/src/index.ts';
import splendorDuel from '../games/splendor-duel/src/server.ts';
import { DECKS, JEWEL_CARDS } from '../games/splendor-duel/src/cards.ts';

const SETUP = { players: ['a', 'b'], options: {}, seed: 20261102, now: 1_700_000_000_000 };

function fresh() {
  const state = createInitialState(splendorDuel, SETUP).state;
  state.turn = 0;
  state.turnSeq = 0;
  state.phase = 'playing';
  state.mandatoryDone = false;
  state.privilegesUsed = false;
  state.replenished = false;
  state.extraTurn = false;
  state.pending = [];
  return state;
}

test('璀璨宝石：67 张卡和开局版图', () => {
  assert.equal(JEWEL_CARDS.length, 67);
  assert.equal(JEWEL_CARDS.filter((card) => card.level === 1).length, 30);
  assert.equal(JEWEL_CARDS.filter((card) => card.level === 2).length, 24);
  assert.equal(JEWEL_CARDS.filter((card) => card.level === 3).length, 13);
  assert.equal(Object.keys(DECKS).length, 3);

  const state = fresh();
  assert.equal(state.board.filter((token) => token != null).length, 25);
  assert.equal(state.pyramid.filter((card) => card != null).length, 12);
  assert.equal(state.decks['1'].length, 25);
  assert.equal(state.decks['2'].length, 20);
  assert.equal(state.decks['3'].length, 10);
  assert.equal(state.privilegeSupply + Object.values(state.privileges).reduce((a, b) => a + b, 0), 3);
});

test('璀璨宝石：拿 3 个同色或 2 个珍珠给对手特权', () => {
  const state = fresh();
  state.board[0] = 'blue';
  state.board[1] = 'blue';
  state.board[2] = 'blue';
  const before = state.privileges.b;
  const after = applyAction(splendorDuel, state, 'a', { type: 'takeTokens', payload: { cells: [0, 1, 2] } }, 1).state;
  assert.equal(after.board[0], null);
  assert.equal(after.tokens.a.blue, 3);
  assert.equal(after.privileges.b, before + 1, '3 同色给对手特权');

  const pearls = fresh();
  pearls.board[0] = 'pearl';
  pearls.board[1] = 'pearl';
  const pearlBefore = pearls.privileges.b;
  const pearlAfter = applyAction(splendorDuel, pearls, 'a', {
    type: 'takeTokens',
    payload: { cells: [0, 1] },
  }, 1).state;
  assert.equal(pearlAfter.tokens.a.pearl, 2);
  assert.equal(pearlAfter.privileges.b, pearlBefore + 1, '2 珍珠给对手特权');
});

test('璀璨宝石：第 3 个皇冠触发 Royal，Royal 分数计入总分', () => {
  const state = fresh();
  // 两张各 1 皇冠的卡已经在手，再买一张 1 皇冠卡就会触发第 3 个皇冠
  state.cards.a = [
    { cardId: 'L1-19', copyColor: null },
    { cardId: 'L1-22', copyColor: null },
  ];
  state.pyramid[7] = 'L1-24';
  state.tokens.a = { white: 0, blue: 0, green: 3, red: 0, black: 0, pearl: 0, gold: 0 };

  const afterBuy = applyAction(splendorDuel, state, 'a', { type: 'buy', payload: { cardId: 'L1-24' } }, 1).state;
  assert.equal(afterBuy.cards.a.length, 3);
  assert.equal(afterBuy.phase, 'royal');
  assert.deepEqual(afterBuy.pending, ['royal']);

  const afterRoyal = applyAction(splendorDuel, afterBuy, 'a', {
    type: 'takeRoyal',
    payload: { royalId: 'royal-none' },
  }, 1).state;
  assert.ok(afterRoyal.royalsOwned.a.includes('royal-none'));
  assert.equal(afterRoyal.royals.length, 3);
  assert.equal(afterRoyal.phase, 'playing');
  assert.equal(afterRoyal.turn, 1);
});

test('璀璨宝石：预购当回合可见，预购者下一次回合开始翻面', () => {
  const state = fresh();
  const cardId = state.pyramid[0]!;
  const afterReserve = applyAction(splendorDuel, state, 'a', {
    type: 'reserve',
    payload: { from: 'pyramid', cell: 0 },
  }, 1).state;
  assert.equal(afterReserve.reserved.a.length, 1);
  assert.equal(afterReserve.turnSeq, 1, '预购结束轮到对手');

  const opponentView = splendorDuel.view(afterReserve, 'b').data as {
    players: { id: string; reserved: { cardId: string | null; public: boolean }[] }[];
  };
  const seenByOpponent = opponentView.players.find((player) => player.id === 'a')!.reserved[0]!;
  assert.equal(seenByOpponent.cardId, cardId, '对手在预购后的回合能看见');
  assert.equal(seenByOpponent.public, true);

  // 模拟再过一个回合：预购者再次开始，翻面
  afterReserve.turnSeq = 2;
  const hiddenView = splendorDuel.view(afterReserve, 'b').data as {
    players: { id: string; reserved: { cardId: string | null; public: boolean }[] }[];
  };
  const hidden = hiddenView.players.find((player) => player.id === 'a')!.reserved[0]!;
  assert.equal(hidden.cardId, null);
  assert.equal(hidden.public, false);

  const ownView = splendorDuel.view(afterReserve, 'a').data as {
    players: { id: string; reserved: { cardId: string | null }[] }[];
  };
  assert.equal(
    ownView.players.find((player) => player.id === 'a')!.reserved[0]!.cardId,
    cardId,
    '预购者自己始终能看到',
  );
});

test('璀璨宝石：预留时可以选择拿哪一块金', () => {
  const state = fresh();
  const goldCells = state.board
    .map((token, index) => (token === 'gold' ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(goldCells.length >= 2, '开局有 3 块金');
  const keep = goldCells[0]!;
  const chosen = goldCells[goldCells.length - 1]!;

  const after = applyAction(splendorDuel, state, 'a', {
    type: 'reserve',
    payload: { from: 'pyramid', cell: 0, goldCell: chosen },
  }, 1).state;

  assert.equal(after.board[chosen], null, '选中的金被拿走');
  assert.equal(after.board[keep], 'gold', '其他金留在原位');
  assert.equal(after.tokens.a.gold, 1);
  assert.equal(after.reserved.a.length, 1);
});
