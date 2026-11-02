/**
 * 土耳其麻将 / 101 Okey —— 服务端规则。
 *
 * 基础规则来自 101 Okey（okey.gg / Pagat）。
 * 用户房规：开牌后可以拆场上牌型重组，拆完每个普通牌型仍 ≥3 张；
 * 本实现按“提交完整桌上分组”的方式校验。
 */
import { z } from 'zod';
import type {
  ActionContext,
  ActionDef,
  AnyAction,
  BaseState,
  GamePlugin,
  PlayerId,
  PublicView,
  SetupContext,
  StateDef,
} from '@platform/sdk';
import {
  TILE_BY_ID,
  TILES,
  okeyFor,
  sortHand,
  tileOf,
  tileValue,
  type OkeyDef,
  type Tile,
} from './tiles';
import {
  checkMeld,
  handPoints,
  validateOpening,
  validateTable,
  type MeldKind,
} from './meld';

interface TableMeld {
  id: string;
  kind: MeldKind;
  tiles: string[];
  owner: PlayerId;
}

interface RoundSummary {
  round: number;
  winner: PlayerId | null;
  reason: 'win' | 'wall';
  roundScores: Record<PlayerId, number>;
  totals: Record<PlayerId, number>;
}

export interface OkeyState extends BaseState {
  deck: string[];
  indicator: string;
  okey: OkeyDef;
  hands: Record<PlayerId, string[]>;
  melds: TableMeld[];
  discard: string[];
  opened: Record<PlayerId, 'score' | 'pairs' | null>;
  openingValue: Record<PlayerId, number>;
  scores: Record<PlayerId, number>;
  roundsTotal: number;
  dealer: number;
  tookDiscard: string | null;
  lastRound: RoundSummary | null;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

function zeroed<T>(players: PlayerId[], make: () => T): Record<PlayerId, T> {
  return Object.fromEntries(players.map((player) => [player, make()]));
}

function currentPlayer(state: OkeyState): PlayerId {
  return state.players[state.turn]!;
}

function otherPlayers(state: OkeyState, player: PlayerId): PlayerId[] {
  return state.players.filter((item) => item !== player);
}

function handTiles(state: OkeyState, player: PlayerId): Tile[] {
  return (state.hands[player] ?? [])
    .map((id) => TILE_BY_ID[id])
    .filter((tile): tile is Tile => tile != null);
}

function tableTileIds(state: OkeyState): string[] {
  return state.melds.flatMap((meld) => meld.tiles);
}

function tileIdsToTiles(ids: string[]): Tile[] | null {
  const tiles = ids.map((id) => TILE_BY_ID[id]);
  if (tiles.some((tile) => tile == null)) return null;
  return tiles as Tile[];
}

function removeFromHand(state: OkeyState, player: PlayerId, ids: string[]): boolean {
  const hand = state.hands[player] ?? [];
  const next = [...hand];
  for (const id of ids) {
    const index = next.indexOf(id);
    if (index < 0) return false;
    next.splice(index, 1);
  }
  state.hands[player] = next;
  return true;
}

function topDiscard(state: OkeyState): string | null {
  return state.discard.length > 0 ? state.discard[state.discard.length - 1]! : null;
}

function combinations<T>(items: T[], choose: number): T[][] {
  const result: T[][] = [];
  const walk = (start: number, current: T[]): void => {
    if (current.length === choose) {
      result.push([...current]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      current.push(items[index]!);
      walk(index + 1, current);
      current.pop();
    }
  };
  walk(0, []);
  return result;
}

function canUseDiscard(state: OkeyState, player: PlayerId): boolean {
  const topId = topDiscard(state);
  if (!topId) return false;
  const top = TILE_BY_ID[topId];
  if (!top) return false;
  const hand = handTiles(state, player);
  const route = state.opened[player];

  for (let size = 2; size <= 4; size += 1) {
    if (hand.length + 1 < size) continue;
    for (const combo of combinations(hand, size - 1)) {
      const check = checkMeld([...combo, top], state.okey);
      if (!check) continue;
      if (route === 'pairs') {
        if (check.kind === 'pair' && size === 2) return true;
        continue;
      }
      if (route === 'score') {
        if ((check.kind === 'set' || check.kind === 'run') && size >= 3) return true;
        continue;
      }
      // 还没开牌：对子/组/顺子都可能是开牌的一部分
      return true;
    }
  }
  return false;
}

function drawOne(state: OkeyState): string | null {
  return state.deck.pop() ?? null;
}

function finishGame(state: OkeyState, ctx: ActionContext<OkeyState>): void {
  const sorted = [...state.players].sort(
    (left, right) => (state.scores[left] ?? 0) - (state.scores[right] ?? 0),
  );
  const groups: PlayerId[][] = [];
  let last: number | null = null;
  for (const player of sorted) {
    const score = state.scores[player] ?? 0;
    if (last != null && score === last) groups[groups.length - 1]!.push(player);
    else {
      groups.push([player]);
      last = score;
    }
  }
  state.finished = true;
  state.ranking = groups;
  const winners = groups[0] ?? [];
  ctx.emit({ type: 'log', key: 'okey.gameEnd', args: { winners, scores: state.scores } });
  for (const player of winners) {
    ctx.emit({ type: 'achievement', player, key: 'first-win' });
  }
  ctx.goTo('finished');
}

function addScores(
  state: OkeyState,
  winner: PlayerId | null,
  reason: 'win' | 'wall',
  ctx: ActionContext<OkeyState>,
): void {
  const roundScores = zeroed(state.players, () => 0);
  const anyOpened = state.players.some((player) => state.opened[player] != null);
  for (const player of state.players) {
    if (winner === player) {
      roundScores[player] = -101;
    } else if (state.opened[player] == null) {
      roundScores[player] = winner != null || anyOpened ? 202 : 0;
    } else {
      roundScores[player] = handPoints(handTiles(state, player), state.okey);
    }
    state.scores[player] = (state.scores[player] ?? 0) + roundScores[player]!;
  }
  state.lastRound = {
    round: state.round,
    winner,
    reason,
    roundScores,
    totals: { ...state.scores },
  };
  ctx.emit({
    type: 'log',
    key: 'okey.roundEnd',
    args: { round: state.round, winner, reason, scores: roundScores },
  });
  if (winner && state.opened[winner] === 'pairs') {
    ctx.emit({ type: 'achievement', player: winner, key: 'pair-master' });
  }
}

function dealRound(
  state: OkeyState,
  rng: () => number,
  dealerIndex: number,
): void {
  const deck = shuffle(TILES.map((tile) => tile.id), rng);
  let indicator: Tile | null = null;
  while (deck.length > 0) {
    const id = deck.pop()!;
    const tile = TILE_BY_ID[id]!;
    if (tile.fake) {
      deck.unshift(id);
      continue;
    }
    indicator = tile;
    break;
  }
  if (!indicator) return;
  const okey = okeyFor(indicator);
  if (!okey) return;

  state.deck = deck;
  state.indicator = indicator.id;
  state.okey = okey;
  state.discard = [];
  state.melds = [];
  state.opened = zeroed(state.players, () => null);
  state.openingValue = zeroed(state.players, () => 0);
  state.tookDiscard = null;
  state.dealer = dealerIndex;
  state.turn = dealerIndex;
  state.phase = 'play';
  state.hands = zeroed(state.players, () => []);

  state.players.forEach((player, index) => {
    const count = index === dealerIndex ? 22 : 21;
    const hand: string[] = [];
    for (let draw = 0; draw < count; draw += 1) {
      const id = drawOne(state);
      if (id) hand.push(id);
    }
    state.hands[player] = sortHand(hand, okey);
  });
}

function endRound(
  state: OkeyState,
  ctx: ActionContext<OkeyState>,
  winner: PlayerId | null,
  reason: 'win' | 'wall',
): void {
  addScores(state, winner, reason, ctx);
  if (state.round >= state.roundsTotal) {
    finishGame(state, ctx);
    return;
  }
  state.round += 1;
  dealRound(state, ctx.rng, (state.dealer + 1) % state.players.length);
}

function advanceToDraw(state: OkeyState, ctx: ActionContext<OkeyState>): void {
  state.turn = (state.turn + 1) % state.players.length;
  state.phase = 'draw';
  state.tookDiscard = null;
  if (state.deck.length === 0) {
    endRound(state, ctx, null, 'wall');
  }
}

function parsedGroups(ids: string[][]): Tile[][] | null {
  const groups: Tile[][] = [];
  for (const group of ids) {
    const tiles = tileIdsToTiles(group);
    if (!tiles) return null;
    groups.push(tiles);
  }
  return groups;
}

function openAction(state: OkeyState, player: PlayerId, groups: Tile[][]): string | null {
  if (state.opened[player] != null) return '你已经开过牌了';
  const result = validateOpening(groups, state.okey);
  if (!result) return '开牌不合法：需要至少 101 分，或至少 5 个对子';
  const ids = groups.flatMap((group) => group.map((tile) => tile.id));
  if (new Set(ids).size !== ids.length) return '同一张牌不能重复使用';
  const hand = state.hands[player] ?? [];
  if (!ids.every((id) => hand.includes(id))) return '有些牌不在你的手里';
  if (state.tookDiscard != null && !ids.includes(state.tookDiscard)) {
    return '拿到的弃牌必须在本回合用掉';
  }
  if (hand.length - ids.length < 1) return '开牌后还要留一张牌弃掉';
  return null;
}

function rearrangeAction(
  state: OkeyState,
  player: PlayerId,
  groups: Tile[][],
  route: 'score' | 'pairs',
): string | null {
  const current = tableTileIds(state);
  const ids = groups.flatMap((group) => group.map((tile) => tile.id));
  if (new Set(ids).size !== ids.length) return '同一张牌不能重复使用';
  const tableSet = new Set(current);
  const idsSet = new Set(ids);
  if (current.some((id) => !idsSet.has(id))) return '桌上的牌必须全部保留，不能拿走';
  const hand = state.hands[player] ?? [];
  const added = ids.filter((id) => !tableSet.has(id));
  if (!added.every((id) => hand.includes(id))) return '只能把手里有的牌加到桌上';
  if (hand.length - added.length < 1) return '整理后还要留一张牌弃掉';
  if (!validateTable(groups, state.okey, route)) {
    return route === 'pairs'
      ? '对子路线只能摆对子，每个对子 2 张'
      : '普通路线每组必须是 3 张以上的组或顺子';
  }
  if (state.tookDiscard != null && !ids.includes(state.tookDiscard)) {
    return '拿到的弃牌必须在本回合用掉';
  }
  return null;
}

function buildMelds(
  groups: Tile[][],
  okey: OkeyDef,
  owner: PlayerId,
  round: number,
): TableMeld[] {
  return groups.map((group, index) => {
    const check = checkMeld(group, okey);
    return {
      id: `m${round}-${index}`,
      kind: check?.kind ?? 'set',
      tiles: group.map((tile) => tile.id),
      owner,
    };
  });
}

const drawAction: ActionDef<OkeyState> = {
  allowedIn: ['draw'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.deck.length === 0) return { ok: false, reason: '牌堆已经空了' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    const id = drawOne(state);
    if (!id) return;
    state.hands[ctx.playerId] = sortHand([...(state.hands[ctx.playerId] ?? []), id], state.okey);
    state.phase = 'play';
    ctx.emit({ type: 'log', key: 'okey.draw', args: { player: ctx.playerId } });
  },
};

const takeDiscard: ActionDef<OkeyState> = {
  allowedIn: ['draw'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const id = topDiscard(state);
    if (!id) return { ok: false, reason: '弃牌堆是空的' };
    if (!canUseDiscard(state, ctx.playerId)) {
      return { ok: false, reason: '这张弃牌现在没法用来开牌或成组' };
    }
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    const id = state.discard.pop();
    if (!id) return;
    state.hands[ctx.playerId] = sortHand([...(state.hands[ctx.playerId] ?? []), id], state.okey);
    state.tookDiscard = id;
    state.phase = 'play';
    ctx.emit({ type: 'log', key: 'okey.takeDiscard', args: { player: ctx.playerId } });
  },
};

const returnDiscard: ActionDef<OkeyState> = {
  allowedIn: ['play'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (!state.tookDiscard) return { ok: false, reason: '你没有拿弃牌' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    const id = state.tookDiscard;
    if (!id) return;
    removeFromHand(state, ctx.playerId, [id]);
    state.discard.push(id);
    state.tookDiscard = null;
    const drawn = drawOne(state);
    if (drawn) {
      state.hands[ctx.playerId] = sortHand([...(state.hands[ctx.playerId] ?? []), drawn], state.okey);
    }
    ctx.emit({ type: 'log', key: 'okey.returnDiscard', args: { player: ctx.playerId } });
    if (!drawn) endRound(state, ctx, null, 'wall');
  },
};

const open: ActionDef<OkeyState> = {
  allowedIn: ['play'],
  schema: z.object({ melds: z.array(z.array(z.string().min(1)).min(2).max(13)).min(1).max(12) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.opened[ctx.playerId] != null) return { ok: false, reason: '你已经开过牌了' };
    const groups = parsedGroups((action.payload as { melds: string[][] }).melds);
    if (!groups) return { ok: false, reason: '有牌不存在' };
    const error = openAction(state, ctx.playerId, groups);
    return error ? { ok: false, reason: error } : { ok: true };
  },
  reduce(state, action, ctx) {
    const groups = parsedGroups((action.payload as { melds: string[][] }).melds);
    if (!groups) return;
    const result = validateOpening(groups, state.okey);
    if (!result) return;
    const ids = groups.flatMap((group) => group.map((tile) => tile.id));
    removeFromHand(state, ctx.playerId, ids);
    state.opened[ctx.playerId] = result.route;
    state.openingValue[ctx.playerId] = result.value;
    state.melds.push(...buildMelds(groups, state.okey, ctx.playerId, state.round));
    if (state.tookDiscard && ids.includes(state.tookDiscard)) state.tookDiscard = null;
    ctx.emit({
      type: 'log',
      key: 'okey.open',
      args: { player: ctx.playerId, route: result.route, value: result.value },
    });
    if (result.value >= 150) {
      ctx.emit({ type: 'achievement', player: ctx.playerId, key: 'big-open' });
    }
  },
};

const rearrange: ActionDef<OkeyState> = {
  allowedIn: ['play'],
  schema: z.object({ melds: z.array(z.array(z.string().min(1)).min(2).max(13)).min(1).max(30) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const route = state.opened[ctx.playerId];
    if (!route) return { ok: false, reason: '你还没开牌' };
    const groups = parsedGroups((action.payload as { melds: string[][] }).melds);
    if (!groups) return { ok: false, reason: '有牌不存在' };
    const error = rearrangeAction(state, ctx.playerId, groups, route);
    return error ? { ok: false, reason: error } : { ok: true };
  },
  reduce(state, action, ctx) {
    const route = state.opened[ctx.playerId];
    if (!route) return;
    const groups = parsedGroups((action.payload as { melds: string[][] }).melds);
    if (!groups) return;
    const current = new Set(tableTileIds(state));
    const ids = groups.flatMap((group) => group.map((tile) => tile.id));
    const added = ids.filter((id) => !current.has(id));
    removeFromHand(state, ctx.playerId, added);
    state.melds = buildMelds(groups, state.okey, ctx.playerId, state.round);
    if (state.tookDiscard && ids.includes(state.tookDiscard)) state.tookDiscard = null;
    ctx.emit({ type: 'log', key: 'okey.rearrange', args: { player: ctx.playerId } });
  },
};

const discard: ActionDef<OkeyState> = {
  allowedIn: ['play'],
  schema: z.object({ tile: z.string().min(1) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.tookDiscard) return { ok: false, reason: '拿到的弃牌还没用掉：先用于牌型，或选择“放回弃牌堆并摸牌”' };
    const { tile } = action.payload as { tile: string };
    if (!(state.hands[ctx.playerId] ?? []).includes(tile)) {
      return { ok: false, reason: '这张牌不在你手里' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { tile } = action.payload as { tile: string };
    if (!removeFromHand(state, ctx.playerId, [tile])) return;
    if ((state.hands[ctx.playerId] ?? []).length === 0) {
      ctx.emit({ type: 'log', key: 'okey.win', args: { player: ctx.playerId } });
      endRound(state, ctx, ctx.playerId, 'win');
      return;
    }
    state.discard.push(tile);
    state.tookDiscard = null;
    ctx.emit({ type: 'log', key: 'okey.discard', args: { player: ctx.playerId } });
    advanceToDraw(state, ctx);
  },
};

const states: Record<string, StateDef<OkeyState>> = {
  draw: {
    type: 'activePlayer',
    onTimeout() {
      return { type: 'draw', payload: {} };
    },
  },
  play: {
    type: 'activePlayer',
    onTimeout(state) {
      const player = currentPlayer(state);
      if (state.tookDiscard) return { type: 'returnDiscard', payload: {} };
      const hand = state.hands[player] ?? [];
      if (hand.length === 0) return null;
      const lowest = [...hand].sort((left, right) => {
        const leftTile = tileOf(left);
        const rightTile = tileOf(right);
        if (!leftTile || !rightTile) return 0;
        return tileValue(leftTile, state.okey) - tileValue(rightTile, state.okey);
      })[0]!;
      return { type: 'discard', payload: { tile: lowest } };
    },
  },
  finished: { type: 'global' },
};

function playerView(state: OkeyState, player: PlayerId, viewer: PlayerId | null) {
  const revealed = state.finished || viewer === player;
  return {
    id: player,
    handCount: (state.hands[player] ?? []).length,
    hand: revealed ? state.hands[player] ?? [] : null,
    opened: state.opened[player],
    openingValue: state.openingValue[player] ?? 0,
    score: state.scores[player] ?? 0,
  };
}

const okey: GamePlugin<OkeyState> = {
  manifest: {
    id: 'okey-101',
    name: '土耳其麻将 · Okey 101',
    version: '0.1.0',
    apiVersion: '^1.0.0',
    players: { min: 2, max: 4 },
    modes: ['realtime', 'turnbased'],
    tags: ['麻将', '牌组', '策略'],
    estimatedMinutes: 35,
    realtime: { fast: 40, normal: 90, slow: 180 },
    description:
      '土耳其麻将 101 Okey：先破冰凑出 101 分或 5 个对子，再把牌全部打出去，分数最低的人赢。',
    intro:
      '土耳其麻将（101 Okey），2–4 人。\n\n## 破冰\n\n第一次把牌摆到桌上，必须凑出至少 101 分的牌型，或者至少 5 个对子。\n\n## 开牌后\n\n可以往场上牌型加牌，也可以拆开场上牌型和手里刚拿到的牌重新组合；拆完后每个普通牌型仍然要 ≥3 张。每回合摸一张或吃上家弃牌，然后必须弃一张。\n\n## 计分\n\n胡牌的人 -101；没开牌的人 +202；开了牌的人按手里剩牌点数。默认 3 轮，累计分最低的人赢。',
    options: [
      {
        key: 'rounds',
        label: '轮数',
        default: '3',
        choices: [
          { value: '1', label: '1 轮', hint: '短局' },
          { value: '3', label: '3 轮', hint: '标准' },
          { value: '5', label: '5 轮', hint: '长局' },
        ],
      },
    ],
    achievements: [
      { id: 'first-win', name: '首胜', description: '赢得一局 Okey 101', icon: '🏆', color: '#5a2f2f' },
      { id: 'big-open', name: '大破冰', description: '用 150 分以上的牌型开牌', icon: '🔥', color: '#7a3a1f' },
      { id: 'pair-master', name: '对子大师', description: '用 5 个对子开牌并赢下该轮', icon: '🃏', color: '#3a4a7a' },
    ],
  },

  createState({ players, options, seed }: SetupContext): OkeyState {
    const rng = mulberry32(seed);
    const roundsTotal = options.rounds === '1' ? 1 : options.rounds === '5' ? 5 : 3;
    const dealer = Math.floor(rng() * players.length);
    const state: OkeyState = {
      players: [...players],
      turn: dealer,
      round: 1,
      phase: 'play',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      deck: [],
      indicator: '',
      okey: { color: 'red', number: 1 },
      hands: zeroed(players, () => []),
      melds: [],
      discard: [],
      opened: zeroed(players, () => null),
      openingValue: zeroed(players, () => 0),
      scores: zeroed(players, () => 0),
      roundsTotal,
      dealer,
      tookDiscard: null,
      lastRound: null,
    };
    dealRound(state, rng, dealer);
    return state;
  },

  states,
  actions: {
    draw: drawAction,
    takeDiscard,
    returnDiscard,
    open,
    rearrange,
    discard,
  },

  view(state, viewer): PublicView {
    const me = viewer === 'spectator' ? null : viewer;
    return {
      phase: state.phase,
      players: state.players,
      turn: state.finished ? null : currentPlayer(state),
      round: state.round,
      finished: state.finished,
      ranking: state.ranking,
      data: {
        deckCount: state.deck.length,
        indicator: state.indicator,
        okey: state.okey,
        discardTop: topDiscard(state),
        discardCount: state.discard.length,
        melds: state.melds,
        players: state.players.map((player) => playerView(state, player, me)),
        scores: state.scores,
        opened: state.opened,
        openingValue: state.openingValue,
        roundsTotal: state.roundsTotal,
        dealer: state.dealer,
        tookDiscard: state.tookDiscard,
        lastRound: state.lastRound,
        you: me,
      },
    };
  },

  legalMoves(state, playerId) {
    if (state.finished) return [];
    if (currentPlayer(state) !== playerId) return [];
    if (state.phase === 'draw') {
      const moves: AnyAction[] = [{ type: 'draw', payload: {} }];
      if (canUseDiscard(state, playerId)) moves.push({ type: 'takeDiscard', payload: {} });
      return moves;
    }
    if (state.phase === 'play') {
      if (state.tookDiscard) return [{ type: 'returnDiscard', payload: {} }];
      return (state.hands[playerId] ?? []).map((tile) => ({
        type: 'discard',
        payload: { tile },
      }));
    }
    return [];
  },
};

export default okey;
export { okey };
