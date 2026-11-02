/**
 * 101 Okey —— 牌、百搭、牌型、开牌、拆牌重组、轮结算。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, createInitialState } from '../packages/engine/src/index.ts';
import okey from '../games/okey-101/src/server.ts';
import { TILES, TILE_BY_ID, okeyFor, type OkeyDef, type Tile } from '../games/okey-101/src/tiles.ts';
import { checkMeld, validateOpening } from '../games/okey-101/src/meld.ts';

const SETUP = { players: ['a', 'b'], options: { rounds: '1' }, seed: 20261102, now: 1_700_000_000_000 };
const OKEY: OkeyDef = { color: 'red', number: 8 };

function tiles(...ids: string[]): Tile[] {
  return ids.map((id) => TILE_BY_ID[id]!);
}

test('Okey 101：106 张牌与 Okey 判定', () => {
  assert.equal(TILES.length, 106);
  assert.equal(TILES.filter((tile) => tile.fake).length, 2);
  assert.equal(TILES.filter((tile) => !tile.fake).length, 104);
  assert.deepEqual(okeyFor(TILE_BY_ID['r7a']!), { color: 'red', number: 8 });
  assert.deepEqual(okeyFor(TILE_BY_ID['b13a']!), { color: 'blue', number: 1 });
});

test('Okey 101：set / run / pair / 百搭', () => {
  assert.equal(checkMeld(tiles('r5a', 'y5a', 'b5a'), OKEY)?.kind, 'set');
  assert.equal(checkMeld(tiles('r5a', 'r5b', 'y5a'), OKEY), null, '花色不能重复');
  assert.equal(checkMeld(tiles('r5a', 'r6a', 'r7a'), OKEY)?.value, 18);
  assert.equal(checkMeld(tiles('r12a', 'r13a', 'r1a'), OKEY), null, '12-13-1 不合法');
  assert.equal(checkMeld(tiles('r5a', 'r7a', 'r8a'), OKEY)?.kind, 'run', '真 Okey 补洞');
  assert.equal(checkMeld(tiles('r5a', 'r5b'), OKEY)?.kind, 'pair');
  assert.equal(checkMeld(tiles('r5a', 'y5a'), OKEY), null, '对子必须同色同点');
  assert.equal(checkMeld(tiles('fake-a', 'r8a'), OKEY)?.kind, 'pair', '假百搭当 Okey 本身');
  assert.equal(checkMeld(tiles('fake-a', 'y8a', 'b8a'), OKEY)?.kind, 'set');
});

test('Okey 101：101 分或 5 对开牌，路线不能混', () => {
  const score = validateOpening(
    [
      tiles('r9a', 'r10a', 'r11a', 'r12a', 'r13a'),
      tiles('b9a', 'b10a', 'b11a', 'b12a', 'b13a'),
    ],
    OKEY,
  );
  assert.deepEqual(score, { route: 'score', value: 110 });

  const low = validateOpening([tiles('r1a', 'r2a', 'r3a', 'r4a', 'r5a')], OKEY);
  assert.equal(low, null, '不够 101');

  const pairs = validateOpening(
    [
      tiles('r5a', 'r5b'),
      tiles('y6a', 'y6b'),
      tiles('b7a', 'b7b'),
      tiles('k8a', 'k8b'),
      tiles('r9a', 'r9b'),
    ],
    OKEY,
  );
  assert.equal(pairs?.route, 'pairs');

  assert.equal(
    validateOpening([tiles('r5a', 'r5b'), tiles('r9a', 'r10a', 'r11a')], OKEY),
    null,
    '对子和普通牌型不能混',
  );
});

test('Okey 101：发牌、开牌、拆牌重组', () => {
  let state = createInitialState(okey, SETUP).state;
  assert.equal(state.phase, 'play');
  assert.equal(state.hands[state.players[state.dealer]!]!.length, 22);
  assert.equal(state.hands.a!.length + state.hands.b!.length, 43);
  assert.equal(state.deck.length, 106 - 1 - 43);

  const opening = [
    'r9a', 'r10a', 'r11a', 'r12a', 'r13a',
    'b9a', 'b10a', 'b11a', 'b12a', 'b13a',
  ];
  state.turn = 0;
  state.phase = 'play';
  state.hands.a = [...opening, 'k1a'];
  state.tookDiscard = null;
  state.opened.a = null;
  state.melds = [];
  state = applyAction(okey, state, 'a', {
    type: 'open',
    payload: { melds: [opening.slice(0, 5), opening.slice(5)] },
  }, 1).state;
  assert.equal(state.opened.a, 'score');
  assert.equal(state.openingValue.a, 110);
  assert.equal(state.melds.length, 2);
  assert.deepEqual(state.hands.a, ['k1a']);

  // 把手里 r8a 加到红色顺子，完整提交桌上分组
  state.hands.a = ['r8a', 'k1a'];
  state = applyAction(okey, state, 'a', {
    type: 'rearrange',
    payload: {
      melds: [
        ['r8a', 'r9a', 'r10a', 'r11a', 'r12a', 'r13a'],
        ['b9a', 'b10a', 'b11a', 'b12a', 'b13a'],
      ],
    },
  }, 1).state;
  assert.equal(state.melds[0]!.tiles.length, 6);
  assert.deepEqual(state.hands.a, ['k1a']);

  // 不能把桌上的牌拿走丢掉
  assert.throws(() =>
    applyAction(okey, state, 'a', {
      type: 'rearrange',
      payload: {
        melds: [
          ['r8a', 'r9a', 'r10a', 'r11a', 'r12a'],
          ['b9a', 'b10a', 'b11a', 'b12a', 'b13a'],
        ],
      },
    }, 1),
  );
});

test('Okey 101：胡牌 -101，未开牌 +202', () => {
  let state = createInitialState(okey, SETUP).state;
  state.turn = 0;
  state.phase = 'play';
  state.tookDiscard = null;
  state.opened.a = 'score';
  state.hands.a = ['r5a'];
  state.scores.a = 0;
  state.scores.b = 0;
  state = applyAction(okey, state, 'a', { type: 'discard', payload: { tile: 'r5a' } }, 1).state;
  assert.equal(state.finished, true);
  assert.deepEqual(state.ranking, [['a'], ['b']]);
  assert.equal(state.scores.a, -101);
  assert.equal(state.scores.b, 202);
});
