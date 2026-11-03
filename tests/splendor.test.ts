/**
 * 璀璨宝石 —— 卡表、回合动作、贵族、终局、两个扩展模块。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createInitialState } from '../packages/engine/src/index.ts';
import splendor, { type SplendorState } from '../games/splendor/src/server.ts';
import { CARDS, CARD_BY_ID, CITY_TILES, GEMS, NOBLES } from '../games/splendor/src/data.ts';
import { emptyTokens } from '../games/splendor/src/rules.ts';

const SETUP = (players: string[], expansions: string[] = []) => ({
  players,
  options: {},
  expansions,
  seed: 20261103,
  now: 1_700_000_000_000,
});

function fresh(players: string[] = ['a', 'b'], expansions: string[] = []): SplendorState {
  return createInitialState(splendor, SETUP(players, expansions)).state as SplendorState;
}

function run(
  state: SplendorState,
  player: string,
  action: { type: string; payload?: unknown },
): SplendorState {
  return applyAction(splendor, state, player, action, 1).state as SplendorState;
}

test('璀璨宝石：90 张卡与 10 张贵族', () => {
  assert.equal(CARDS.length, 90);
  assert.equal(CARDS.filter((card) => card.level === 1).length, 40);
  assert.equal(CARDS.filter((card) => card.level === 2).length, 30);
  assert.equal(CARDS.filter((card) => card.level === 3).length, 20);

  for (const [level, perColor] of [
    [1, 8],
    [2, 6],
    [3, 4],
  ] as const) {
    for (const gem of GEMS) {
      const count = CARDS.filter((card) => card.level === level && card.bonus === gem).length;
      assert.equal(count, perColor, `${level} 级 ${gem} 应该有 ${perColor} 张`);
    }
  }

  // 每张卡的价格总和落在官方区间内
  for (const card of CARDS) {
    const total = GEMS.reduce((sum, gem) => sum + card.cost[gem], 0);
    assert.ok(total >= 3 && total <= 14, `${card.id} 的价格 ${total} 不合理`);
  }

  assert.equal(NOBLES.length, 10);
  for (const noble of NOBLES) {
    assert.equal(noble.prestige, 3);
    const need = Object.values(noble.need).filter((value) => value !== undefined);
    assert.deepEqual(need.sort(), [4, 4]);
  }
});

test('璀璨宝石：7 张城市板块的数值', () => {
  assert.equal(CITY_TILES.length, 7);
  const ids = new Set(CITY_TILES.map((tile) => tile.id));
  assert.equal(ids.size, 7, '城市 id 不能重复');

  for (const tile of CITY_TILES) {
    assert.equal(tile.sides.length, 2, `${tile.name} 应该有两面`);
    for (const side of tile.sides) {
      assert.ok(side.prestige >= 12 && side.prestige <= 17, `${tile.name} 的分数 ${side.prestige} 不合理`);
    }
    // 每一面至少要有一条可判断的要求
    for (const side of tile.sides) {
      if (side.requirement.kind === 'fixed') {
        const total = Object.values(side.requirement.need).reduce((sum, value) => sum + (value ?? 0), 0);
        assert.ok(total > 0, `${tile.name} 的固定要求不能为空`);
      }
      if (side.requirement.kind === 'any') {
        assert.ok(side.requirement.count >= 1 && side.requirement.count <= 6);
      }
    }
  }

  // 文档里给的三个示例要能对上
  const florida = CITY_TILES.find((tile) => tile.id === 'city-venice')!;
  assert.deepEqual(florida.sides[1].requirement, { kind: 'fixed', need: { red: 4, black: 3 } });
  const lisbon = CITY_TILES.find((tile) => tile.id === 'city-lisbon')!;
  assert.deepEqual(lisbon.sides[0].requirement, { kind: 'any', count: 5 });
});

test('璀璨宝石：2 / 4 人开局的宝石与贵族数量', () => {
  const two = fresh();
  for (const gem of GEMS) assert.equal(two.supply[gem], 4);
  assert.equal(two.supply.gold, 5);
  assert.equal(two.nobles.length, 3);
  for (const level of ['1', '2', '3'] as const) {
    assert.equal(two.board[level].length, 4);
    assert.ok(two.board[level].every((id) => id !== null));
  }
  assert.equal(two.decks['1'].length, 36);
  assert.equal(two.decks['2'].length, 26);
  assert.equal(two.decks['3'].length, 16);

  const four = fresh(['a', 'b', 'c', 'd']);
  for (const gem of GEMS) assert.equal(four.supply[gem], 7);
  assert.equal(four.nobles.length, 5);
});

test('璀璨宝石：拿 3 个异色 / 2 个同色', () => {
  const state = fresh();
  const after = run(state, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(after.data.a.tokens.white, 1);
  assert.equal(after.data.a.tokens.blue, 1);
  assert.equal(after.data.a.tokens.green, 1);
  assert.equal(after.supply.white, 3);
  assert.equal(after.turn, 1, '拿完换人');
  assert.equal(after.round, 1);

  assert.throws(
    () => run(state, 'a', { type: 'take3', payload: { colors: ['white', 'white', 'blue'] } }),
    /三种不同颜色/,
  );

  const two = fresh();
  const taken = run(two, 'a', { type: 'take2', payload: { color: 'red' } });
  assert.equal(taken.data.a.tokens.red, 2);
  assert.equal(taken.supply.red, 2);

  const scarce = fresh();
  scarce.supply.red = 3;
  assert.throws(() => run(scarce, 'a', { type: 'take2', payload: { color: 'red' } }), /少于 4/);
});

test('璀璨宝石：预留拿黄金、补牌、上限 3 张', () => {
  const state = fresh();
  const cardId = state.board['1'][0]!;
  const after = run(state, 'a', { type: 'reserve', payload: { from: 'board', level: '1', index: 0 } });
  assert.deepEqual(after.data.a.reserved, [cardId]);
  assert.equal(after.data.a.tokens.gold, 1);
  assert.equal(after.supply.gold, 4);
  assert.ok(after.board['1'][0], '空位要立刻补一张');
  assert.equal(after.turn, 1);

  const full = fresh();
  full.data.a.reserved = [full.board['1'][0]!, full.board['1'][1]!, full.board['1'][2]!];
  assert.throws(
    () => run(full, 'a', { type: 'reserve', payload: { from: 'deck', level: '1' } }),
    /最多只能预留 3 张/,
  );
});

test('璀璨宝石：买卡抵扣红利、黄金补缺口', () => {
  // L1-08：4 蓝，1 分
  const card = CARD_BY_ID['L1-08']!;
  assert.deepEqual(card.cost, { white: 0, blue: 4, green: 0, red: 0, black: 0 });
  assert.equal(card.prestige, 1);

  const plain = fresh();
  plain.board['1'][0] = card.id;
  plain.data.a.tokens = { ...emptyTokens(), blue: 2, gold: 2 };
  const bought = run(plain, 'a', { type: 'buy', payload: { cardId: card.id } });
  assert.deepEqual(bought.data.a.cards, [card.id]);
  assert.equal(bought.data.a.tokens.blue, 0);
  assert.equal(bought.data.a.tokens.gold, 0);
  assert.equal(bought.supply.blue, 6, '付掉的蓝宝石回到场上');
  assert.equal(bought.supply.gold, 7, '付掉的黄金回到场上');
  assert.ok(bought.board['1'][0], '买走的位置要补牌');

  const discounted = fresh();
  discounted.board['1'][0] = card.id;
  discounted.data.a.cards = CARDS.filter((item) => item.bonus === 'blue').slice(0, 2).map((item) => item.id);
  discounted.data.a.tokens = { ...emptyTokens(), blue: 2 };
  const cheap = run(discounted, 'a', { type: 'buy', payload: { cardId: card.id } });
  assert.equal(cheap.data.a.tokens.blue, 0, '两个蓝红利抵掉两颗');
  assert.equal(cheap.data.a.tokens.gold, 0);

  const broke = fresh();
  broke.board['1'][0] = card.id;
  broke.data.a.tokens = { ...emptyTokens(), blue: 1 };
  assert.throws(() => run(broke, 'a', { type: 'buy', payload: { cardId: card.id } }), /宝石不够/);
});

test('璀璨宝石：超过 10 个指示物要弃回', () => {
  const state = fresh();
  state.data.a.tokens = { ...emptyTokens(), white: 5, blue: 5 };
  const over = run(state, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(over.phase, 'discard');
  assert.equal(over.turn, 0, '还没弃完');

  const one = run(over, 'a', { type: 'discardToken', payload: { color: 'white' } });
  assert.equal(one.phase, 'discard');
  const two = run(one, 'a', { type: 'discardToken', payload: { color: 'white' } });
  const three = run(two, 'a', { type: 'discardToken', payload: { color: 'white' } });
  assert.equal(three.phase, 'turn');
  assert.equal(three.turn, 1);
  assert.equal(three.data.a.tokens.white, 3);
});

test('璀璨宝石：贵族在回合结束自动拜访', () => {
  const state = fresh();
  state.nobles = ['N-white-blue'];
  state.data.a.cards = [
    ...CARDS.filter((card) => card.bonus === 'white').slice(0, 4),
    ...CARDS.filter((card) => card.bonus === 'blue').slice(0, 4),
  ].map((card) => card.id);

  const after = run(state, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.deepEqual(after.data.a.nobles, ['N-white-blue']);
  assert.equal(after.nobles.length, 0);
  assert.equal(after.turn, 1);
});

test('璀璨宝石：15 分后打完本轮才结束，平局比买卡数', () => {
  const state = fresh();
  state.bonusPoints.a = 15;
  state.bonusPoints.b = 15;
  state.data.a.cards = CARDS.slice(0, 3).map((card) => card.id);
  state.data.b.cards = CARDS.slice(0, 1).map((card) => card.id);

  const first = run(state, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(first.endTriggered, true);
  assert.equal(first.turn, 1, '触发 15 分后对手还有一回合');

  const last = run(first, 'b', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(last.finished, true);
  assert.equal(last.phase, 'finished');
  assert.deepEqual(last.ranking?.[0], ['b'], '同分时买卡少的赢');
});

test('璀璨宝石：买卡后必须处理要塞，占领的牌对手买不了', () => {
  const state = fresh(['a', 'b'], ['strongholds']);
  assert.equal(state.expansion, 'strongholds');

  const card = CARD_BY_ID['L1-08']!;
  state.board['1'][0] = card.id;
  state.data.a.tokens = { ...emptyTokens(), blue: 8, gold: 0 };
  const bought = run(state, 'a', { type: 'buy', payload: { cardId: card.id } });
  assert.equal(bought.phase, 'stronghold', '买完必须放/移要塞');

  const target = bought.board['2'].find((id) => id)!;
  const placed = run(bought, 'a', { type: 'placeStronghold', payload: { cardId: target } });
  assert.deepEqual(placed.strongholds[target], { owner: 'a', count: 1 });

  // 轮到 b，b 买不了 a 占了要塞的牌
  placed.turn = 1;
  placed.data.b.tokens = { ...emptyTokens(), white: 9, blue: 9, green: 9, red: 9, black: 9 };
  assert.throws(
    () => run(placed, 'b', { type: 'buy', payload: { cardId: target } }),
    /被别的公会占了/,
  );
});

test('璀璨宝石：三个要塞压同一张卡可以立刻再买一次', () => {
  const state = fresh(['a', 'b'], ['strongholds']);
  const controlled = 'L1-01';
  state.board['1'][0] = controlled;
  // 已经有 2 个在目标卡上，手上还剩 1 个
  state.strongholds[controlled] = { owner: 'a', count: 2 };

  const card = CARD_BY_ID['L1-08']!;
  state.board['1'][1] = card.id;
  state.data.a.tokens = { ...emptyTokens(), white: 12, blue: 12, green: 12, red: 12, black: 12 };
  const bought = run(state, 'a', { type: 'buy', payload: { cardId: card.id } });
  assert.equal(bought.phase, 'stronghold');

  const placed = run(bought, 'a', { type: 'placeStronghold', payload: { cardId: controlled } });
  assert.deepEqual(placed.strongholds[controlled], { owner: 'a', count: 3 });
  assert.equal(placed.phase, 'conquest', '三堡压顶后可以立刻买下那张卡');
  assert.equal(placed.conquestUsed, false);

  const after = run(placed, 'a', { type: 'buyConquest', payload: { cardId: controlled } });
  assert.ok(after.data.a.cards.includes(controlled));
  assert.equal(after.strongholds[controlled], undefined, '买完要塞收回');
});

test('璀璨宝石：贸易之路占下能力，黄金顶两颗', () => {
  const state = fresh(['a', 'b'], ['trading-posts']);
  assert.equal(state.expansion, 'trading-posts');
  state.data.a.cards = CARDS.filter((card) => card.bonus === 'white').slice(0, 2).map((card) => card.id);

  const after = run(state, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.deepEqual(after.seals.a, ['extra-gem'], '两个白红利自动占下第二条能力');

  // 黄金当双倍：4 蓝的卡，2 个黄金就够
  const gold = fresh(['a', 'b'], ['trading-posts']);
  gold.seals.a = ['gold-double'];
  const card = CARD_BY_ID['L1-08']!;
  gold.board['1'][0] = card.id;
  gold.data.a.tokens = { ...emptyTokens(), gold: 2 };
  const bought = run(gold, 'a', { type: 'buy', payload: { cardId: card.id } });
  assert.deepEqual(bought.data.a.cards, [card.id]);
  assert.equal(bought.data.a.tokens.gold, 0);
});

test('璀璨宝石：繁华之城开局不摆贵族，摆 3 张城市板块', () => {
  const state = fresh(['a', 'b'], ['cities']);
  assert.equal(state.expansion, 'cities');
  assert.equal(state.nobles.length, 0, '城市模式不用贵族');
  assert.equal(state.cities.length, 3);
  for (const city of state.cities) {
    assert.equal(city.owner, null);
    assert.ok(city.side === 0 || city.side === 1);
  }
  assert.equal(new Set(state.cities.map((city) => city.key)).size, 3, '城市 key 不能重复');
});

test('璀璨宝石：满足城市要求时回合结束自动拿城，本轮走完即结束', () => {
  const state = fresh(['a', 'b'], ['cities']);
  state.cities = [{ key: 'city-venice-1', tileId: 'city-venice', side: 1, owner: null }];
  // 威尼斯反面：13 分 + 红 4 + 黑 3
  state.data.a.cards = [
    ...CARDS.filter((card) => card.bonus === 'red').slice(0, 4),
    ...CARDS.filter((card) => card.bonus === 'black').slice(0, 3),
  ].map((card) => card.id);
  state.bonusPoints.a = 13;

  const took = run(state, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(took.cities[0]!.owner, 'a');
  assert.equal(took.endTriggered, true);
  assert.equal(took.turn, 1, '拿城后对手还有一回合');

  const end = run(took, 'b', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(end.finished, true);
  assert.deepEqual(end.ranking?.[0], ['a'], '唯一拿到城市板块的人获胜');
});

test('璀璨宝石：多人拿到城市板块时比声望；城市模式没有 15 分终局', () => {
  const state = fresh(['a', 'b'], ['cities']);
  state.cities = [
    { key: 'city-pisa-0', tileId: 'city-pisa', side: 0, owner: null },
    { key: 'city-venice-1', tileId: 'city-venice', side: 1, owner: null },
  ];
  state.bonusPoints.a = 17; // 比萨正面：只要 17 分
  state.data.b.cards = [
    ...CARDS.filter((card) => card.bonus === 'red').slice(0, 4),
    ...CARDS.filter((card) => card.bonus === 'black').slice(0, 3),
  ].map((card) => card.id);
  state.bonusPoints.b = 13;

  const first = run(state, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(first.cities[0]!.owner, 'a');

  const second = run(first, 'b', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(second.finished, true);
  assert.equal(second.cities[1]!.owner, 'b');
  assert.deepEqual(second.ranking?.[0], ['a'], '两人都有城市时比声望');

  // 城市模式没有「15 分结束」：给 20 分但拿不到城市就继续打
  const noCity = fresh(['a', 'b'], ['cities']);
  noCity.cities = [{ key: 'city-venice-1', tileId: 'city-venice', side: 1, owner: null }];
  noCity.bonusPoints.a = 20;
  const continued = run(noCity, 'a', { type: 'take3', payload: { colors: ['white', 'blue', 'green'] } });
  assert.equal(continued.finished, false);
  assert.equal(continued.endTriggered, false);
  assert.equal(continued.turn, 1);
});

test('璀璨宝石：任意局面都能走完（随机 300 步）', () => {
  for (const expansions of [[], ['cities'], ['strongholds'], ['trading-posts']]) {
    let state = fresh(['a', 'b', 'c'], expansions);
    const players = state.players;
    let steps = 0;

    while (steps < 300 && !state.finished) {
      const player = players[state.turn]!;
      const moves = splendor.legalMoves?.(state, player) ?? [];
      if (moves.length === 0) break;

      let advanced = false;
      for (let offset = 0; offset < moves.length; offset += 1) {
        const move = moves[(steps + offset) % moves.length]!;
        try {
          state = run(state, player, move);
          advanced = true;
          break;
        } catch {
          continue;
        }
      }
      if (!advanced) break;
      steps += 1;
    }

    assert.ok(steps > 0, `扩展 ${expansions.join('+') || '本体'} 一步都没走成`);
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(state))), JSON.stringify(state));
  }
});
