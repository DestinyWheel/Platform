/**
 * 曼荼罗（Mandala）—— 规则移植自 D:\Workspace\gamer\Mandala\scripts\game_core.lua
 *
 * 与参考实现的三处约定（已和作者确认）：
 *   1. 打原野一次出一张，但同一回合可以连续出（等价于"不限张数"）
 *   2. 结算只从高山取色，原野的牌不参与分配，结算结束整幅清空
 *   3. 结算结束后换人；原野牌数相同时，由触发结算的玩家先选
 */
import { z } from 'zod';
import type {
  ActionContext,
  ActionDef,
  AnyAction,
  BaseState,
  BotContext,
  BotPolicy,
  GameManifest,
  GamePlugin,
  PlayerId,
  PublicView,
  StateDef,
} from '@platform/sdk';
import rawManifest from '../manifest.json';

const manifest = rawManifest as GameManifest;

const COLORS = [1, 2, 3, 4, 5, 6];
const COLOR_NAMES: Record<number, string> = {
  1: '红',
  2: '蓝',
  3: '绿',
  4: '黄',
  5: '紫',
  6: '橙',
};

const CARDS_PER_COLOR = 8;
const HAND_LIMIT = 8;
const INITIAL_HAND = 6;
const CUP_INIT = 2;
const MOUNTAIN_INIT = 2;
const RIVER_SLOTS = 6;
const MOUNTAIN_DRAW = 3;

type ColorCounts = Record<number, number>;

interface MandalaBoard {
  /** [玩家0的原野, 玩家1的原野] */
  fields: ColorCounts[];
  mountain: ColorCounts;
}

export interface MandalaState extends BaseState {
  /** 完整牌堆（暗牌，只有张数对外可见） */
  deck: number[];
  drawPos: number;
  deckExhausted: boolean;
  hands: Record<PlayerId, number[]>;
  /** 长河：6 格，每格是一种颜色或空 */
  rivers: Record<PlayerId, (number | null)[]>;
  /** 沙杯：盖着的牌 */
  cups: Record<PlayerId, number[]>;
  mandalas: MandalaBoard[];
  settlement: { mandalaIdx: number; picker: PlayerId } | null;
  /** 本回合内的撤销快照（JSON），换手或进入结算就清空 */
  undo: string[];
  /** 不限时房间：任何动作都不自动换手，只有主动「结束回合」才换 */
  untimed: boolean;
}

const MAX_UNDO = 20;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

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

function emptyBoard(): MandalaBoard {
  return { fields: [{}, {}], mountain: {} };
}

function emptyRiver(): (number | null)[] {
  return Array.from({ length: RIVER_SLOTS }, () => null);
}

function addCard(zone: ColorCounts, color: number, count = 1): void {
  zone[color] = (zone[color] ?? 0) + count;
}

function zoneTotal(zone: ColorCounts): number {
  return Object.values(zone).reduce((sum, count) => sum + count, 0);
}

function colorCount(zone: ColorCounts): number {
  return Object.keys(zone).length;
}

function colorsOf(zone: ColorCounts): number[] {
  return Object.keys(zone).map(Number);
}

/** 颜色规则：同一幅曼荼罗里，一种颜色只能出现在一个区域 */
function canPlay(board: MandalaBoard, color: number, target: 'mountain' | number): boolean {
  const zones: (ColorCounts | undefined)[] = [
    board.fields[0],
    board.fields[1],
    board.mountain,
  ];
  for (const [index, zone] of zones.entries()) {
    if (!zone) continue;
    const isTarget = target === 'mountain' ? index === 2 : index === target;
    if (isTarget) continue;
    if (zone[color]) return false;
  }
  return true;
}

function boardHasAllColors(board: MandalaBoard): boolean {
  const seen = new Set<number>();
  for (const zone of [...board.fields, board.mountain]) {
    for (const color of colorsOf(zone)) seen.add(color);
  }
  return seen.size >= COLORS.length;
}

function draw(state: MandalaState, count: number): number[] {
  const drawn: number[] = [];
  for (let i = 0; i < count && state.drawPos < state.deck.length; i += 1) {
    drawn.push(state.deck[state.drawPos]!);
    state.drawPos += 1;
  }
  if (state.drawPos >= state.deck.length) state.deckExhausted = true;
  return drawn;
}

function swapTurn(state: MandalaState): void {
  state.turn = state.turn === 0 ? 1 : 0;
  if (state.turn === 0) state.round += 1;
  // 换手了就不能再撤销上一位玩家的操作
  state.undo = [];
}

/** 记一份"动手之前"的快照，供本回合内撤销 */
function pushUndo(state: MandalaState): void {
  const { undo: _ignored, ...rest } = state;
  state.undo.push(JSON.stringify(rest));
  if (state.undo.length > MAX_UNDO) state.undo.shift();
}

function scoreOf(state: MandalaState, playerId: PlayerId): number {
  const counts: Record<number, number> = {};
  for (const color of state.cups[playerId] ?? []) {
    counts[color] = (counts[color] ?? 0) + 1;
  }

  let score = 0;
  const river = state.rivers[playerId] ?? [];
  river.forEach((color, index) => {
    if (!color) return;
    // 长河格只是倍率，真正计分的是沙杯里同色的张数
    score += (counts[color] ?? 0) * (index + 1);
  });
  return score;
}

function rankPlayers(
  players: PlayerId[],
  scores: Record<PlayerId, number>,
): PlayerId[][] {
  const sorted = [...players].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const groups: PlayerId[][] = [];
  let last: number | null = null;

  for (const player of sorted) {
    const score = scores[player] ?? 0;
    if (last !== null && score === last) {
      groups[groups.length - 1]!.push(player);
    } else {
      groups.push([player]);
      last = score;
    }
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* 结算流程                                                            */
/* ------------------------------------------------------------------ */

function finishGame(state: MandalaState, ctx: ActionContext<MandalaState>, reason: string): void {
  state.finished = true;
  state.settlement = null;

  const scores: Record<PlayerId, number> = {};
  for (const player of state.players) scores[player] = scoreOf(state, player);

  state.ranking = rankPlayers(state.players, scores);
  ctx.emit({
    type: 'log',
    key: 'mandala.gameEnd',
    args: { ranking: state.ranking, scores, reason },
  });
  ctx.goTo('finished');
}

function finishSettlement(state: MandalaState, ctx: ActionContext<MandalaState>): void {
  const settlement = state.settlement;
  if (!settlement) return;

  state.mandalas[settlement.mandalaIdx] = emptyBoard();
  state.settlement = null;
  ctx.emit({ type: 'log', key: 'mandala.settleEnd', args: { mandala: settlement.mandalaIdx + 1 } });

  // 牌堆抽空之后再完成一次结算 → 结束
  if (state.deckExhausted) {
    finishGame(state, ctx, 'deck');
    return;
  }

  swapTurn(state);
  ctx.goTo('playing');
}

function startSettlement(
  state: MandalaState,
  ctx: ActionContext<MandalaState>,
  mandalaIdx: number,
  triggerIdx: number,
): void {
  const board = state.mandalas[mandalaIdx]!;
  const fieldCounts = board.fields.map((zone) => zoneTotal(zone));
  const [countA, countB] = [fieldCounts[0] ?? 0, fieldCounts[1] ?? 0];

  // 原野牌多者先选；相同则由触发结算的人先选
  const firstIdx = countA > countB ? 0 : countB > countA ? 1 : triggerIdx;

  state.settlement = { mandalaIdx, picker: state.players[firstIdx]! };
  state.turn = firstIdx;
  // 进入结算后，之前的操作不再可撤销
  state.undo = [];

  ctx.emit({
    type: 'log',
    key: 'mandala.settleStart',
    args: {
      mandala: mandalaIdx + 1,
      player: state.players[firstIdx],
      fieldA: countA,
      fieldB: countB,
      tie: countA === countB,
    },
  });

  if (colorsOf(board.mountain).length === 0) {
    // 高山是空的（六色全在原野），没有可拿的，直接收尾
    finishSettlement(state, ctx);
    return;
  }

  ctx.goTo('settling');
}

function findSettlement(state: MandalaState): number | null {
  for (const [index, board] of state.mandalas.entries()) {
    if (boardHasAllColors(board)) return index;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

const playMountain: ActionDef<MandalaState> = {
  allowedIn: ['playing'],
  schema: z.object({ card: z.number().int().min(0), mandala: z.number().int().min(0).max(1) }),
  validate(state, action, ctx) {
    if (state.players[state.turn] !== ctx.playerId) return { ok: false, reason: 'not.your.turn' };
    const { card, mandala } = action.payload as { card: number; mandala: number };
    const hand = state.hands[ctx.playerId] ?? [];
    if (card < 0 || card >= hand.length) return { ok: false, reason: 'card.not.in.hand' };
    if (!canPlay(state.mandalas[mandala]!, hand[card]!, 'mountain')) {
      return { ok: false, reason: 'color.conflict' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { card, mandala } = action.payload as { card: number; mandala: number };
    const playerId = ctx.playerId;
    pushUndo(state);
    const hand = state.hands[playerId]!;
    const color = hand[card]!;

    hand.splice(card, 1);
    addCard(state.mandalas[mandala]!.mountain, color);

    ctx.emit({
      type: 'log',
      key: 'mandala.playMountain',
      args: { player: playerId, color, mandala: mandala + 1 },
    });

    const drawCount = Math.min(MOUNTAIN_DRAW, HAND_LIMIT - hand.length);
    if (drawCount > 0) {
      hand.push(...draw(state, drawCount));
    }

    const triggered = findSettlement(state);
    if (triggered !== null) {
      startSettlement(state, ctx, triggered, state.players.indexOf(playerId));
      return;
    }

    // 不限时房间：不自动换手，等玩家自己点「结束回合」
    if (!state.untimed) swapTurn(state);
  },
};

const playField: ActionDef<MandalaState> = {
  allowedIn: ['playing'],
  schema: z.object({ card: z.number().int().min(0), mandala: z.number().int().min(0).max(1) }),
  validate(state, action, ctx) {
    if (state.players[state.turn] !== ctx.playerId) return { ok: false, reason: 'not.your.turn' };
    const { card, mandala } = action.payload as { card: number; mandala: number };
    const hand = state.hands[ctx.playerId] ?? [];
    if (card < 0 || card >= hand.length) return { ok: false, reason: 'card.not.in.hand' };
    if (hand.length <= 1) return { ok: false, reason: 'hand.keep.one' };
    const fieldIdx = state.players.indexOf(ctx.playerId);
    if (!canPlay(state.mandalas[mandala]!, hand[card]!, fieldIdx)) {
      return { ok: false, reason: 'color.conflict' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { card, mandala } = action.payload as { card: number; mandala: number };
    const playerId = ctx.playerId;
    pushUndo(state);
    const hand = state.hands[playerId]!;
    const color = hand[card]!;
    const fieldIdx = state.players.indexOf(playerId);

    hand.splice(card, 1);
    addCard(state.mandalas[mandala]!.fields[fieldIdx]!, color);

    ctx.emit({
      type: 'log',
      key: 'mandala.playField',
      args: { player: playerId, color, mandala: mandala + 1 },
    });

    const triggered = findSettlement(state);
    if (triggered !== null) {
      startSettlement(state, ctx, triggered, fieldIdx);
    }
    // 注意：不结束回合，可以继续出牌
  },
};

const discard: ActionDef<MandalaState> = {
  allowedIn: ['playing'],
  schema: z.object({ cards: z.array(z.number().int().min(0)).min(1).max(HAND_LIMIT) }),
  validate(state, action, ctx) {
    if (state.players[state.turn] !== ctx.playerId) return { ok: false, reason: 'not.your.turn' };
    const { cards } = action.payload as { cards: number[] };
    const hand = state.hands[ctx.playerId] ?? [];
    const unique = new Set(cards);
    if (unique.size !== cards.length) return { ok: false, reason: 'card.duplicate' };
    if (cards.some((index) => index < 0 || index >= hand.length)) {
      return { ok: false, reason: 'card.not.in.hand' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { cards } = action.payload as { cards: number[] };
    const playerId = ctx.playerId;
    pushUndo(state);
    const hand = state.hands[playerId]!;

    const sorted = [...cards].sort((a, b) => b - a);
    for (const index of sorted) hand.splice(index, 1);

    const drawn = draw(state, sorted.length);
    hand.push(...drawn);

    ctx.emit({
      type: 'log',
      key: 'mandala.discard',
      args: { player: playerId, count: sorted.length, drawn: drawn.length },
    });

    if (!state.untimed) swapTurn(state);
  },
};

const endTurn: ActionDef<MandalaState> = {
  allowedIn: ['playing'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (state.players[state.turn] !== ctx.playerId) return { ok: false, reason: 'not.your.turn' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    ctx.emit({ type: 'log', key: 'mandala.endTurn', args: { player: ctx.playerId } });
    swapTurn(state);
  },
};

/**
 * 撤销上一步。
 *
 * 只在**自己的回合内**有效：快照在换手和进入结算时都会清空，
 * 所以不可能撤到别人的回合去。
 */
const undoLast: ActionDef<MandalaState> = {
  allowedIn: ['playing'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (state.players[state.turn] !== ctx.playerId) return { ok: false, reason: 'not.your.turn' };
    if (state.undo.length === 0) return { ok: false, reason: 'nothing.to.undo' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    const snapshot = state.undo.pop();
    if (!snapshot) return;
    Object.assign(state, JSON.parse(snapshot) as Record<string, unknown>);
    ctx.emit({ type: 'log', key: 'mandala.undo', args: { player: ctx.playerId } });
  },
};

const pickColor: ActionDef<MandalaState> = {
  allowedIn: ['settling'],
  schema: z.object({ color: z.number().int().min(1).max(6) }),
  validate(state, action, ctx) {
    const settlement = state.settlement;
    if (!settlement) return { ok: false, reason: 'not.settling' };
    if (settlement.picker !== ctx.playerId) return { ok: false, reason: 'not.your.pick' };
    const { color } = action.payload as { color: number };
    const board = state.mandalas[settlement.mandalaIdx]!;
    if (!board.mountain[color]) return { ok: false, reason: 'color.not.on.mountain' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { color } = action.payload as { color: number };
    const settlement = state.settlement!;
    const board = state.mandalas[settlement.mandalaIdx]!;
    const playerId = ctx.playerId;
    const count = board.mountain[color] ?? 0;
    delete board.mountain[color];

    const river = state.rivers[playerId]!;
    const cup = state.cups[playerId]!;
    const existingSlot = river.indexOf(color);

    if (existingSlot >= 0) {
      for (let i = 0; i < count; i += 1) cup.push(color);
    } else {
      const emptySlot = river.indexOf(null);
      if (emptySlot >= 0) {
        river[emptySlot] = color;
        for (let i = 0; i < count - 1; i += 1) cup.push(color);
      } else {
        for (let i = 0; i < count; i += 1) cup.push(color);
      }
    }

    ctx.emit({
      type: 'log',
      key: 'mandala.pick',
      args: { player: playerId, color, count, mandala: settlement.mandalaIdx + 1 },
    });

    if (river.every((slot) => slot !== null)) {
      finishGame(state, ctx, `${playerId} 的长河集满六色`);
      return;
    }

    if (colorsOf(board.mountain).length === 0) {
      finishSettlement(state, ctx);
      return;
    }

    swapTurn(state);
    state.settlement = { ...settlement, picker: state.players[state.turn]! };
  },
};

/* ------------------------------------------------------------------ */
/* 状态机                                                              */
/* ------------------------------------------------------------------ */

function enumerateMoves(state: MandalaState, playerId: PlayerId): AnyAction[] {
  if (state.finished) return [];

  const playerIdx = state.players.indexOf(playerId);
  if (playerIdx < 0) return [];

  if (state.phase === 'settling') {
    const settlement = state.settlement;
    if (!settlement || settlement.picker !== playerId) return [];
    const board = state.mandalas[settlement.mandalaIdx]!;
    return colorsOf(board.mountain).map((color) => ({ type: 'pickColor', payload: { color } }));
  }

  if (state.turn !== playerIdx) return [];

  const hand = state.hands[playerId] ?? [];
  const moves: AnyAction[] = [];

  for (let card = 0; card < hand.length; card += 1) {
    const color = hand[card]!;
    for (let mandala = 0; mandala < state.mandalas.length; mandala += 1) {
      const board = state.mandalas[mandala]!;
      if (canPlay(board, color, 'mountain')) {
        moves.push({ type: 'playMountain', payload: { card, mandala } });
      }
      if (hand.length > 1 && canPlay(board, color, playerIdx)) {
        moves.push({ type: 'playField', payload: { card, mandala } });
      }
    }
  }

  if (hand.length > 0) moves.push({ type: 'discard', payload: { cards: [0] } });
  moves.push({ type: 'endTurn', payload: {} });
  return moves;
}

const states: Record<string, StateDef<MandalaState>> = {
  playing: {
    type: 'activePlayer',
    onTimeout(state, ctx) {
      const moves = enumerateMoves(state, ctx.playerId);
      const mountainMove = moves.find((move) => move.type === 'playMountain');
      if (mountainMove) return mountainMove;
      const fieldMove = moves.find((move) => move.type === 'playField');
      return fieldMove ?? { type: 'endTurn', payload: {} };
    },
  },

  settling: {
    type: 'activePlayer',
    onTimeout(state, _ctx) {
      const settlement = state.settlement;
      if (!settlement) return { type: 'pickColor', payload: { color: 1 } };
      const board = state.mandalas[settlement.mandalaIdx]!;
      const colors = colorsOf(board.mountain).sort((a, b) => a - b);
      return { type: 'pickColor', payload: { color: colors[0] ?? 1 } };
    },
  },

  finished: {
    type: 'global',
  },
};

/* ------------------------------------------------------------------ */
/* 人机：按优先级打分的简单策略                                          */
/* ------------------------------------------------------------------ */

interface BotMandalaView {
  fields: ColorCounts[];
  mountain: ColorCounts;
  colorCount: number;
}

interface BotViewData {
  mandalas: BotMandalaView[];
  you: { hand: number[] } | null;
  settlement: { mandalaIdx: number; picker: PlayerId } | null;
}

const greedyBot: BotPolicy = {
  id: 'greedy',
  name: '贪心',
  choose(context: BotContext): AnyAction | null {
    const data = context.view.data as unknown as BotViewData;
    if (!data?.mandalas) return null;

    // 结算优先：拿走高山上张数最多的颜色
    const picks = context.legal.filter((move) => move.type === 'pickColor');
    if (picks.length > 0) {
      const settlement = data.settlement;
      const mountain = settlement ? (data.mandalas[settlement.mandalaIdx]?.mountain ?? {}) : {};
      const score = (move: AnyAction): number => {
        const color = (move.payload as { color: number }).color;
        return (mountain[color] ?? 0) * 10 - color;
      };
      return [...picks].sort((a, b) => score(b) - score(a))[0] ?? null;
    }

    const hand = data.you?.hand ?? [];
    const playScore = (move: AnyAction): number => {
      const { card, mandala } = move.payload as { card: number; mandala: number };
      const board = data.mandalas[mandala];
      const color = hand[card];
      if (!board || color === undefined) return -1;

      const present =
        (board.fields[0]?.[color] ?? 0) +
        (board.fields[1]?.[color] ?? 0) +
        (board.mountain?.[color] ?? 0);

      // 这一幅里还没出现过的颜色最值钱：直接推进"集齐六色"
      return (present === 0 ? 100 : 0) + board.colorCount;
    };

    const pickBest = (type: string): AnyAction | null => {
      const candidates = context.legal.filter((move) => move.type === type);
      if (candidates.length === 0) return null;
      return [...candidates].sort((a, b) => playScore(b) - playScore(a))[0] ?? null;
    };

    return (
      pickBest('playMountain') ??
      pickBest('playField') ??
      context.legal.find((move) => move.type === 'endTurn') ??
      context.legal[0] ??
      null
    );
  },
};

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

const mandala: GamePlugin<MandalaState> = {
  manifest,
  bots: [greedyBot],

  createState({ players, options, seed }) {
    const rng = mulberry32(seed);
    const deck: number[] = [];
    for (const color of COLORS) {
      for (let i = 0; i < CARDS_PER_COLOR; i += 1) deck.push(color);
    }
    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }

    const state: MandalaState = {
      players: [...players],
      turn: 0,
      round: 1,
      phase: 'playing',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      deck,
      drawPos: 0,
      deckExhausted: false,
      hands: Object.fromEntries(players.map((player) => [player, []])),
      rivers: Object.fromEntries(players.map((player) => [player, emptyRiver()])),
      cups: Object.fromEntries(players.map((player) => [player, []])),
      mandalas: [emptyBoard(), emptyBoard()],
      settlement: null,
      undo: [],
      untimed: options.untimed === true,
    };

    const [first, second] = players as [PlayerId, PlayerId];
    state.hands[first] = draw(state, INITIAL_HAND);
    state.hands[second] = draw(state, INITIAL_HAND);
    state.cups[first] = draw(state, CUP_INIT);
    state.cups[second] = draw(state, CUP_INIT);

    // 每人抽 2 张，第 i 张放进第 i 幅曼荼罗的高山
    for (const player of [first, second]) {
      void player;
      const cards = draw(state, MOUNTAIN_INIT);
      cards.forEach((color, index) => {
        const board = state.mandalas[index];
        if (board) addCard(board.mountain, color);
      });
    }

    return state;
  },

  states,
  actions: { playMountain, playField, discard, endTurn, undo: undoLast, pickColor },
  legalMoves: enumerateMoves,
  view: mandalaView,
};

function mandalaView(state: MandalaState, viewer: PlayerId | 'spectator'): PublicView {
  const me = viewer === 'spectator' ? null : viewer;
  const opponentId = me ? (state.players.find((player) => player !== me) ?? null) : null;
  const revealed = state.finished;

  const playerInfo = (playerId: PlayerId) => ({
    id: playerId,
    handCount: state.hands[playerId]?.length ?? 0,
    cupCount: state.cups[playerId]?.length ?? 0,
    river: state.rivers[playerId] ?? [],
    // 沙杯盖着只是**对对手**盖着。规则书原文：
    // "You may look at the cards in your hand and Cup at any time but keep them hidden
    //  from your opponent." —— 所以自己永远读得到，观战者谁都不给，结束后对所有人翻开。
    cup: revealed || playerId === me ? (state.cups[playerId] ?? []) : null,
  });

  return {
    phase: state.phase,
    players: state.players,
    turn: state.finished ? null : (state.players[state.turn] ?? null),
    round: state.round,
    finished: state.finished,
    ranking: state.ranking,
    data: {
      colors: COLORS.map((id) => ({ id, name: COLOR_NAMES[id] })),
      deckRemaining: state.deck.length - state.drawPos,
      deckExhausted: state.deckExhausted,
      mandalas: state.mandalas.map((board) => ({
        fields: board.fields,
        mountain: board.mountain,
        colorCount: colorCount({
          ...board.fields[0],
          ...board.fields[1],
          ...board.mountain,
        }),
      })),
      players: state.players.map(playerInfo),
      you: me ? { ...playerInfo(me), hand: state.hands[me] ?? [] } : null,
      opponent: opponentId ? playerInfo(opponentId) : null,
      settlement: state.settlement
        ? { mandalaIdx: state.settlement.mandalaIdx, picker: state.settlement.picker }
        : null,
      /** 本回合内还能撤销几步 */
      undoCount: state.undo.length,
      untimed: state.untimed,
      revealed,
    },
  };
}

export default mandala;
export { mandala };
