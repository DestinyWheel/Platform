/**
 * 花砖物语：对决 —— 组件、取砖、铺砖、特殊板。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createInitialState } from '../packages/engine/src/index.ts';
import azulDuel from '../games/azul-duel/src/server.ts';
import { CHIPS, PLATES } from '../games/azul-duel/src/plates.ts';

const SETUP = { players: ['a', 'b'], options: {}, seed: 20261102, now: 1_700_000_000_000 };

function setupGame() {
  let state = createInitialState(azulDuel, SETUP).state;
  let guard = 0;
  while (state.phase === 'setup' && guard < 5) {
    guard += 1;
    const player = state.players[state.turn]!;
    const plateId = state.plateDisplay[0]!;
    const slot = state.boards[player]!.plates.findIndex((item) => item == null);
    state = applyAction(azulDuel, state, player, {
      type: 'placeSetupPlate',
      payload: { plateId, rotation: 0, slot },
    }, 1).state;
  }
  return state;
}

test('花砖物语：18 块板、20 个奖励片、5 色平衡', () => {
  assert.equal(PLATES.length, 18);
  assert.equal(PLATES.filter((plate) => plate.kind === 'special').length, 9);
  assert.equal(PLATES.filter((plate) => plate.kind === 'joker').length, 9);
  assert.equal(CHIPS.length, 20);
  const halves: Record<string, number> = {};
  for (const chip of CHIPS) {
    halves[chip.a] = (halves[chip.a] ?? 0) + 1;
    halves[chip.b] = (halves[chip.b] ?? 0) + 1;
  }
  for (const count of Object.values(halves)) assert.equal(count, 8);
});

test('花砖物语：开局补满工厂、两块板后进入抢砖', () => {
  const created = createInitialState(azulDuel, SETUP).state;
  assert.equal(created.phase, 'setup');
  assert.equal(created.factories.small.every((factory) => factory.sun.length === 4), true);
  assert.equal(created.factories.large.sun.length, 5);
  assert.equal(created.plateDisplay.length, 3);
  assert.equal(created.specialTiles, 9);
  assert.equal(created.bag.length + 21, 65, '袋 + 工厂 = 65 普通砖');
  assert.equal(created.chipSupply.length, 16, '20 个奖励片，4 个在工厂');

  const state = setupGame();
  assert.equal(state.phase, 'playing');
  assert.equal(state.players.every((player) => state.boards[player]!.plates.filter(Boolean).length === 1), true);
  assert.equal(state.turn, state.players.indexOf(state.startingPlayer));
});

test('花砖物语：拿太阳某色全部，多余进破损', () => {
  const state = setupGame();
  const player = state.players[state.turn]!;
  const factory = state.factories.small[0]!;
  const color = factory.sun[0]!;
  const count = factory.sun.filter((tile) => tile === color).length;
  const after = applyAction(azulDuel, state, player, {
    type: 'takeTiles',
    payload: { factory: 0, mode: 'sun', color, line: 0 },
  }, 1).state;
  const board = after.boards[player]!;
  assert.equal(board.patterns[0]!.length, Math.min(1, count));
  assert.equal(board.broken.length, Math.max(0, count - 1));
});

test('花砖物语：工厂清空且两人用完棋子 → 铺砖阶段', () => {
  let state = setupGame();
  for (const factory of state.factories.small) {
    factory.sun = [];
    factory.moon = [];
    factory.chipId = null;
    factory.chipRevealed = false;
  }
  state.factories.large.sun = [];
  state.factories.large.moon = Array.from({ length: 5 }, () => null);
  for (const player of state.players) state.boards[player]!.tokensUsed = 2;
  state.phase = 'playing';
  state.turn = 0;
  const after = applyAction(azulDuel, state, state.players[0]!, { type: 'pass', payload: {} }, 1).state;
  assert.equal(after.phase, 'tiling');
  assert.equal(after.turn, after.players.indexOf(after.startingPlayer));
});

test('花砖物语：完整图案行铺到穹顶，立即计分', () => {
  let state = setupGame();
  for (const factory of state.factories.small) {
    factory.sun = [];
    factory.moon = [];
    factory.chipId = null;
    factory.chipRevealed = false;
  }
  state.factories.large.sun = [];
  state.factories.large.moon = Array.from({ length: 5 }, () => null);
  for (const player of state.players) state.boards[player]!.tokensUsed = 2;
  state.phase = 'playing';
  state.turn = 0;
  state = applyAction(azulDuel, state, state.players[0]!, { type: 'pass', payload: {} }, 1).state;

  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.plates = Array.from({ length: 9 }, () => null);
  board.dome = Array.from({ length: 36 }, () => null);
  board.plates[0] = { plateId: 'joker-1', rotation: 0 };
  board.patterns[0] = ['navy'];
  const after = applyAction(azulDuel, state, player, {
    type: 'placeDomeTile',
    payload: { line: 0, row: 0, col: 0 },
  }, 1).state;
  const afterBoard = after.boards[player]!;
  assert.equal(afterBoard.dome[0], 'navy');
  assert.equal(afterBoard.patterns[0]!.length, 0);
  assert.equal(afterBoard.score, 1, '孤立一格 1 分');
});

test('花砖物语：特殊板填满 3 个颜色格后自动放特殊砖', () => {
  let state = setupGame();
  for (const factory of state.factories.small) {
    factory.sun = [];
    factory.moon = [];
    factory.chipId = null;
    factory.chipRevealed = false;
  }
  state.factories.large.sun = [];
  state.factories.large.moon = Array.from({ length: 5 }, () => null);
  for (const player of state.players) state.boards[player]!.tokensUsed = 2;
  state.phase = 'playing';
  state.turn = 0;
  state = applyAction(azulDuel, state, state.players[0]!, { type: 'pass', payload: {} }, 1).state;

  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.plates = Array.from({ length: 9 }, () => null);
  board.dome = Array.from({ length: 36 }, () => null);
  board.plates[0] = { plateId: 'special-1', rotation: 0 };
  // special-1：local0 特殊、local1 navy(0,1)、local2 turquoise(1,0)、local3 yellow(1,1)
  board.dome[1] = 'navy';
  board.dome[6] = 'turquoise';
  board.patterns[1] = ['yellow', 'yellow'];
  const after = applyAction(azulDuel, state, player, {
    type: 'placeDomeTile',
    payload: { line: 1, row: 1, col: 1 },
  }, 1).state;
  const afterBoard = after.boards[player]!;
  assert.equal(afterBoard.dome[0], 'special', '特殊砖放到 local0');
  assert.equal(after.specialTiles, 8);
  assert.equal(afterBoard.score, 5, '铺砖 4 分 + 特殊砖 1 分');
});
