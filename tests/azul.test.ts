import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createInitialState, enumerateLegalMoves, RuleError } from '../packages/engine/src/index.ts';
import azul from '../games/azul/src/server.ts';
import {
  EXPANSION,
  PROFILES,
  countTiles,
  finalBonusFor,
  legalColumns,
  printedColor,
  type AzulState,
} from '../games/azul/src/shared.ts';

const NOW = 1_700_000_000_000;

function setup(players = 2, expansions: string[] = [], seed = 20261103): AzulState {
  const ids = ['a', 'b', 'c', 'd'].slice(0, players);
  return createInitialState(azul, {
    players: ids,
    options: {},
    expansions,
    seed,
    now: NOW,
  }).state;
}

function take(
  state: AzulState,
  payload: Record<string, unknown>,
  player = state.players[state.turn]!,
) {
  return applyAction(azul, state, player, { type: 'takeTiles', payload }, NOW).state;
}

function place(state: AzulState, payload: Record<string, unknown>, player = state.players[state.turn]!) {
  return applyAction(azul, state, player, { type: 'placeWall', payload }, NOW).state;
}

function setFactory(state: AzulState, index: number, tiles: AzulState['factories'][number]['tiles']): void {
  state.factories[index]!.tiles = tiles;
}

test('开局：2/3/4 人的工厂数与 100 块砖，先手随机但只落在座位上', () => {
  for (const [players, factories] of [
    [2, 5],
    [3, 7],
    [4, 9],
  ] as const) {
    const state = setup(players);
    assert.equal(state.factories.length, factories);
    assert.equal(state.factories.every((factory) => factory.tiles.length === 4), true);
    assert.equal(state.center.length, 0);
    assert.equal(state.markerInCenter, true);
    assert.equal(state.round, 1);
    assert.equal(state.phase, 'playing');
    assert.ok(state.players.includes(state.players[state.starter]!));
    assert.equal(state.turn, state.starter);
    assert.equal(countTiles(state), 100);
  }
});

test('拿工厂砖：同色全部拿走，余砖进中央，超出图案行进地面线', () => {
  const state = setup(2);
  const player = state.players[state.turn]!;
  setFactory(state, 0, ['red', 'red', 'red', 'blue']);

  const next = take(state, { factory: 0, color: 'red', line: 1 });
  const board = next.boards[player]!;
  assert.equal(board.patterns[1]!.length, 2, '第 2 行容量 2');
  assert.deepEqual(board.floor, ['red'], '多余一块进地面线');
  assert.equal(next.factories[0]!.tiles.length, 0);
  assert.deepEqual(next.center, ['blue'], '工厂余砖进中央');
  assert.notEqual(next.turn, state.turn, '行动后轮到下一位');
  assert.equal(countTiles(next), 100);
});

test('中央首拿：先手标记进地面线并成为下轮先手，第二次不再给', () => {
  const state = setup(2);
  state.turn = 1;
  state.center = ['blue', 'blue'];
  state.markerInCenter = true;
  const first = state.players[1]!;
  const next = take(state, { factory: null, color: 'blue', line: 0 });
  assert.deepEqual(next.boards[first]!.floor, ['marker', 'blue']);
  assert.equal(next.markerInCenter, false);
  assert.equal(next.firstPlayer, 1);

  // 另一位玩家再从中央拿，不会重复拿标记
  next.center = ['red'];
  next.turn = 0;
  const other = next.players[0]!;
  const second = take(next, { factory: null, color: 'red', line: 1 });
  assert.equal(second.boards[other]!.floor.filter((tile) => tile === 'marker').length, 0);
});

test('图案行限制：异色、墙格已占、行满都不合法；地面线永远合法', () => {
  const state = setup(2);
  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.wall[0]![0] = 'blue';
  state.center = ['blue'];
  assert.throws(() => take(state, { factory: null, color: 'blue', line: 0 }), RuleError);

  board.patterns[1] = ['red'];
  state.center = ['blue'];
  assert.throws(() => take(state, { factory: null, color: 'blue', line: 1 }), RuleError);

  board.patterns[2] = ['red', 'red', 'red'];
  state.center = ['blue'];
  assert.throws(() => take(state, { factory: null, color: 'blue', line: 2 }), RuleError);

  const floor = take(state, { factory: null, color: 'blue', line: -1 });
  assert.deepEqual(floor.boards[player]!.floor, ['marker', 'blue']);
});

test('回合结算：完成行上墙、即时计分、地面扣分、补工厂与先手轮转', () => {
  const state = setup(2);
  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.patterns[0] = ['blue'];
  board.score = 10;
  board.floor = ['yellow'];
  state.factories.forEach((factory, index) => {
    factory.tiles = index === 0 ? ['red'] : [];
  });
  state.center = [];
  const firstPlayer = state.firstPlayer;

  const next = take(state, { factory: 0, color: 'red', line: -1 });
  assert.equal(next.boards[player]!.wall[0]![0], 'blue');
  assert.equal(next.boards[player]!.score, 9, '上墙 1 分，地面 -2');
  assert.equal(next.boards[player]!.floor.length, 0);
  assert.equal(next.boards[player]!.patterns[0]!.length, 0);
  assert.equal(next.round, 2);
  assert.equal(next.turn, firstPlayer);
  assert.equal(next.markerInCenter, true);
  assert.equal(next.factories.filter((factory) => factory.tiles.length === 4).length, 5);
});

test('终局：完成横排后算横/竖/同色奖励并排名', () => {
  const state = setup(2);
  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.wall[0] = ['blue', 'yellow', 'red', 'black', null];
  board.patterns[0] = ['white'];
  board.score = 10;
  state.factories.forEach((factory, index) => {
    factory.tiles = index === 0 ? ['red'] : [];
  });
  state.center = [];

  const next = take(state, { factory: 0, color: 'red', line: -1 });
  assert.equal(next.finished, true);
  assert.equal(next.phase, 'finished');
  assert.equal(next.endReason, 'row');
  assert.equal(next.boards[player]!.wall[0]![4], 'white');
  // 10 + 横 5 + 地面 -1 + 横排奖励 2
  assert.equal(next.boards[player]!.score, 16);
  assert.equal(next.ranking?.[0]?.[0], player);
  assert.ok(next.finalBonuses?.[player]!.rows === 1);
  assert.equal(azul.view(next, player).turn, null);
});

test('legalMoves 全部可执行，随机跑一段不抛错且砖数守恒', () => {
  let state = setup(4, [], 99);
  for (let step = 0; step < 240 && !state.finished; step += 1) {
    const player = state.players[state.turn]!;
    const moves = enumerateLegalMoves(azul, state, player);
    assert.ok(moves.length > 0, `第 ${step} 步没有合法动作`);
    const move = moves[(step * 7) % moves.length]!;
    state = applyAction(azul, state, player, move, NOW).state;
    assert.equal(countTiles(state), 100, `第 ${step} 步砖数不守恒`);
  }
});

/* ------------------------------ 百搭砖 ------------------------------ */

test('百搭砖：2 人 5 个、3–4 人 10 个，总数仍是 100', () => {
  const two = setup(2, [EXPANSION.joker]);
  const four = setup(4, [EXPANSION.joker]);
  const jokers = (state: AzulState): number =>
    state.bag.filter((tile) => tile === 'joker').length +
    state.factories.reduce(
      (sum, factory) => sum + factory.tiles.filter((tile) => tile === 'joker').length,
      0,
    );
  assert.equal(jokers(two), 5);
  assert.equal(jokers(four), 10);
  assert.equal(countTiles(two), 100);
  assert.equal(countTiles(four), 100);
});

test('百搭砖上墙：混合行把百搭放到另一颜色的墙格，终局不计颜色奖励', () => {
  const state = setup(2, [EXPANSION.joker]);
  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.patterns[1] = ['blue', 'joker'];
  state.factories.forEach((factory, index) => {
    factory.tiles = index === 0 ? ['red'] : [];
  });
  state.center = [];

  const next = take(state, { factory: 0, color: 'red', line: -1 });
  assert.equal(next.boards[player]!.wall[1]![1], 'joker');

  const wall = next.boards[player]!.wall;
  wall[0] = ['blue', 'joker', 'red', 'black', 'white'];
  wall[1] = ['white', 'joker', 'yellow', 'red', 'black'];
  const bonus = finalBonusFor(PROFILES.base, wall);
  assert.equal(bonus.colors, 0, '百搭不算同色 5 块');
});

test('全百搭行：上墙进入 tiling，可选择任意空格', () => {
  const state = setup(2, [EXPANSION.joker]);
  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.patterns[0] = ['joker'];
  state.factories.forEach((factory, index) => {
    factory.tiles = index === 0 ? ['red'] : [];
  });
  state.center = [];

  const tiling = take(state, { factory: 0, color: 'red', line: -1 });
  assert.equal(tiling.phase, 'tiling');
  assert.ok(tiling.tiling);
  const options = (tiling as unknown as { tiling: unknown }).tiling;
  assert.ok(tiling.tiling);
  const next = place(
    tiling,
    { line: 0, col: 2 },
    tiling.players[tiling.tiling!.player]!,
  );
  assert.equal(next.boards[player]!.wall[0]![2], 'joker');
  assert.notEqual(next.phase, 'tiling');
  void options;
});

/* ------------------------------ 马赛克水晶 ------------------------------ */

test('马赛克水晶板面：×2 格与新图案预印格位置正确，配置分数不同', () => {
  assert.equal(printedColor(PROFILES['cm-x2'], 0, 3), 'black');
  assert.equal(PROFILES['cm-x2'].x2[0]![3], true);
  assert.equal(printedColor(PROFILES['cm-mosaic'], 2, 2), 'white');
  assert.equal(PROFILES['cm-mosaic'].x2[2]![2], false);
  assert.deepEqual(PROFILES['cm-mosaic'].final, { row: 3, column: 10, color: 12 });
  assert.deepEqual(PROFILES['cm-x2'].floor, [-1, 0, -1, -2, -1, -2, -3]);
});

test('马赛克水晶：灰墙自由放置，落到 ×2 格时该次得分翻倍', () => {
  const state = setup(2, [EXPANSION.crystalX2]);
  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.patterns[3] = ['blue', 'blue', 'blue', 'blue'];
  state.factories.forEach((factory, index) => {
    factory.tiles = index === 0 ? ['red'] : [];
  });
  state.center = [];

  const tiling = take(state, { factory: 0, color: 'red', line: 4 });
  assert.equal(tiling.phase, 'tiling');
  const actor = tiling.players[tiling.tiling!.player]!;
  const next = place(tiling, { line: 3, col: 4 }, actor);
  assert.equal(next.boards[player]!.wall[3]![4], 'blue');
  assert.equal(next.boards[player]!.score, 2, '孤立 1 分 × 2');

  // 灰墙：一行里同色只能出现一次
  const wall = next.boards[player]!.wall;
  assert.deepEqual(legalColumns(PROFILES['cm-x2'], wall, 3, 'blue'), []);
});

/* ------------------------------ 特殊工厂 ------------------------------ */

test('特殊工厂：留盘工厂余砖不移动，分拣工厂要求并执行左右分配', () => {
  const state = setup(2, [EXPANSION.specialFactories]);
  assert.equal(state.factories[0]!.type, 'stay');
  assert.equal(state.factories[1]!.type, 'shift');

  state.factories[0]!.tiles = ['red', 'blue'];
  const stay = take(state, { factory: 0, color: 'red', line: -1 });
  assert.deepEqual(stay.factories[0]!.tiles, ['blue'], '留盘工厂余砖留在原厂');

  stay.factories[0]!.tiles = [];
  stay.factories[1]!.tiles = ['red', 'blue', 'blue'];
  assert.throws(
    () => take(stay, { factory: 1, color: 'red', line: -1 }),
    RuleError,
    '分拣工厂必须选择余砖方向',
  );
  const shifted = take(stay, {
    factory: 1,
    color: 'red',
    line: -1,
    shift: { blue: 'left' },
  });
  assert.deepEqual(shifted.factories[0]!.tiles, ['blue', 'blue']);
  assert.equal(shifted.factories[1]!.tiles.length, 0);
});

test('双倍标记：上墙时可选 ×2，每人一次，取走颜色标记', () => {
  const state = setup(2, [EXPANSION.doubleMarkers]);
  const player = state.players[state.turn]!;
  state.boards[player]!.patterns[0] = ['blue'];
  state.factories.forEach((factory, index) => {
    factory.tiles = index === 0 ? ['red'] : [];
  });
  state.center = [];

  const tiling = take(state, { factory: 0, color: 'red', line: 1 });
  assert.equal(tiling.phase, 'tiling');
  const actor = tiling.players[tiling.tiling!.player]!;
  const next = place(tiling, { line: 0, col: 0, useDouble: true }, actor);
  assert.equal(next.boards[player]!.score, 2);
  assert.equal(next.boards[player]!.usedDouble, true);
  assert.equal(next.doubleMarkers.includes('blue'), false);
});

/* ------------------------------ 组合规则 ------------------------------ */

test('百搭 + 马赛克：百搭上墙不触发 ×2，也不计颜色奖励', () => {
  const state = setup(2, [EXPANSION.joker, EXPANSION.crystalX2]);
  const player = state.players[state.turn]!;
  const board = state.boards[player]!;
  board.patterns[0] = ['joker'];
  state.factories.forEach((factory, index) => {
    factory.tiles = index === 0 ? ['red'] : [];
  });
  state.center = [];

  const tiling = take(state, { factory: 0, color: 'red', line: 1 });
  assert.equal(tiling.phase, 'tiling');
  const actor = tiling.players[tiling.tiling!.player]!;
  // 放在 ×2 黑格上也不会翻倍
  const next = place(tiling, { line: 0, col: 3 }, actor);
  assert.equal(next.boards[player]!.wall[0]![3], 'joker');
  assert.equal(next.boards[player]!.score, 1);
});

test('扩展组合随机对局：百搭 + 特殊工厂 + 双倍 + 水晶两面板都能推进', () => {
  const combos: string[][] = [
    [EXPANSION.crystalX2, EXPANSION.joker, EXPANSION.specialFactories, EXPANSION.doubleMarkers],
    [EXPANSION.crystalMosaic, EXPANSION.joker],
    [EXPANSION.specialFactories, EXPANSION.doubleMarkers],
  ];
  for (const expansions of combos) {
    let state = setup(4, expansions, 77);
    for (let step = 0; step < 320 && !state.finished; step += 1) {
      const player = state.players[state.turn]!;
      const moves = enumerateLegalMoves(azul, state, player);
      assert.ok(moves.length > 0, `${expansions.join('+')} 第 ${step} 步没有动作`);
      state = applyAction(azul, state, player, moves[(step * 11) % moves.length]!, NOW).state;
      assert.equal(countTiles(state), 100, `${expansions.join('+')} 第 ${step} 步砖数不守恒`);
    }
  }
});

test('马赛克水晶新图案面：终局奖励 3/10/12，预印格只接受对应颜色', () => {
  const state = setup(2, [EXPANSION.crystalMosaic]);
  const player = state.players[state.turn]!;
  const profile = PROFILES['cm-mosaic'];
  const wall = state.boards[player]!.wall;
  assert.deepEqual(profile.final, { row: 3, column: 10, color: 12 });
  assert.deepEqual(legalColumns(profile, wall, 2, 'red'), [0, 1, 3, 4]);
  assert.equal(legalColumns(profile, wall, 2, 'black').includes(2), false);
});

test('view 不暴露袋/弃砖堆顺序', () => {
  const state = setup(2);
  const publicView = azul.view(state, state.players[0]!);
  const data = publicView.data as Record<string, unknown>;
  assert.equal('bag' in data, false);
  assert.equal('lid' in data, false);
  assert.equal(data.bagCount, state.bag.length);
  assert.equal(data.lidCount, state.lid.length);
});
