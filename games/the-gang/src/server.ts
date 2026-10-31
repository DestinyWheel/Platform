/**
 * 纸牌帮（The Gang）—— 服务端规则。
 *
 * 合作德州扑克：四轮筹码表态 + 摊牌按顺序亮牌，全队连续排对才算抢下一个金库。
 * 规则细节全部对照官方手册（KOSMOS，2024）实现；界面文案是中文。
 *
 * 这一版是基础局；挑战卡 / 专家卡在 `cards.ts` 里预留了位置。
 */
import { z } from 'zod';
import type {
  ActionDef,
  BaseState,
  GameManifest,
  GamePlugin,
  PlayerId,
  PublicView,
  StateDef,
} from '@platform/sdk';
import rawManifest from '../manifest.json';
import { type Card, cardLabel, categoryName, compareScores, evaluateWithBest, makeDeck, shuffle } from './poker';

const manifest = rawManifest as GameManifest;

/** 四轮对应德州扑克的四个阶段，也对应四种颜色的筹码 */
export const ROUND_NAME = ['翻牌前', '翻牌', '转牌', '河牌'];
export const CHIP_NAME = ['白', '黄', '橙', '红'];

export interface HeistSeat {
  player: PlayerId;
  /** 最后一轮（红）筹码的星数，摊牌顺序就按它来 */
  chip: number;
  /** 牌力打分，前端不显示，只用来判顺序 */
  score: number[];
  /** 该玩家这手牌的名字，比如「两对」 */
  name: string;
  /** 摊牌时展示用的 5 张（7 选 5 里真正凑成牌型的那 5 张） */
  best: string[];
  hand: string[];
}

export interface HeistResult {
  heist: number;
  ok: boolean;
  seats: HeistSeat[];
  community: string[];
  /** 第一个排错的人在 seats 里的下标；没错就是 null */
  badAt: number | null;
}

export interface GangState extends BaseState {
  /** 第几次抢劫，从 1 开始 */
  heist: number;
  vaults: number;
  alarms: number;
  deck: Card[];
  community: Card[];
  hands: Record<PlayerId, Card[]>;
  /** chips[player][round] = 星数；round 是 0..3，对应四轮 */
  chips: Record<PlayerId, (number | null)[]>;
  /** 本轮是否已确认 */
  ready: Record<PlayerId, boolean>;
  /** 摊牌后底牌全部公开 */
  revealed: boolean;
  last: HeistResult | null;
  history: HeistResult[];
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function zeroed<T>(players: PlayerId[], value: T): Record<PlayerId, T> {
  return Object.fromEntries(players.map((player) => [player, value])) as Record<PlayerId, T>;
}

function emptyChips(players: PlayerId[]): Record<PlayerId, (number | null)[]> {
  return Object.fromEntries(players.map((player) => [player, [null, null, null, null]])) as Record<
    PlayerId,
    (number | null)[]
  >;
}

/** 与引擎里同一个 32 位确定性随机，只用于开局洗牌（那时还没有 ctx） */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 当前该催谁：优先没拿筹码的，其次没确认的 */
function nextActor(state: GangState): number {
  const roundIndex = state.round - 1;
  const noChip = state.players.findIndex((player) => state.chips[player]?.[roundIndex] == null);
  if (noChip >= 0) return noChip;
  const notReady = state.players.findIndex((player) => !state.ready[player]);
  return notReady >= 0 ? notReady : 0;
}

/** 发一次新的抢劫：洗牌、发底牌、清空公共牌和筹码 */
function dealHeist(state: GangState, rng: () => number): void {
  const deck = shuffle(makeDeck(), rng);
  state.deck = deck;
  state.hands = zeroed(state.players, []);
  for (const player of state.players) {
    state.hands[player] = [state.deck.pop()!, state.deck.pop()!];
  }
  state.community = [];
  state.chips = emptyChips(state.players);
  state.ready = zeroed(state.players, false);
  state.revealed = false;
  state.last = null;
  state.round = 1;
  state.turn = 0;
}

/** 全员「有筹码 + 已确认」就推进到下一轮 */
function settleRound(state: GangState, ctx: { goTo(phase: string): void }): void {
  const roundIndex = state.round - 1;
  const done = state.players.every(
    (player) => state.chips[player]?.[roundIndex] != null && state.ready[player],
  );
  if (done) {
    ctx.goTo('nextRound');
    return;
  }
  state.turn = nextActor(state);
}

const takeChip: ActionDef<GangState> = {
  allowedIn: ['draft'],
  schema: z.object({ star: z.number().int().min(1).max(6) }),
  validate(state, action, ctx) {
    const { star } = action.payload as { star: number };
    if (star > state.players.length) return { ok: false, reason: 'chip.outOfRange' };
    if (!state.players.includes(ctx.playerId)) return { ok: false, reason: 'not.in.table' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { star } = action.payload as { star: number };
    const roundIndex = state.round - 1;

    // 从别人面前抢走：对方筹码作废，而且他的确认也一并失效
    for (const other of state.players) {
      if (other === ctx.playerId) continue;
      if (state.chips[other]?.[roundIndex] === star) {
        state.chips[other]![roundIndex] = null;
        state.ready[other] = false;
        ctx.emit({
          type: 'log',
          key: 'thegang.steal',
          args: { from: other, by: ctx.playerId, star, round: state.round },
        });
      }
    }

    state.chips[ctx.playerId]![roundIndex] = star;
    state.ready[ctx.playerId] = false;
    ctx.emit({
      type: 'log',
      key: 'thegang.take',
      args: { player: ctx.playerId, star, round: state.round },
    });

    settleRound(state, ctx);
  },
};

const confirmChip: ActionDef<GangState> = {
  allowedIn: ['draft'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    const roundIndex = state.round - 1;
    if (state.chips[ctx.playerId]?.[roundIndex] == null) {
      return { ok: false, reason: 'chip.missing' };
    }
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    state.ready[ctx.playerId] = true;
    ctx.emit({ type: 'log', key: 'thegang.ready', args: { player: ctx.playerId } });
    settleRound(state, ctx);
  },
};

const advance: ActionDef<GangState> = {
  allowedIn: ['heistResult'],
  schema: z.object({}),
  reduce(state, _action, ctx) {
    state.heist += 1;
    dealHeist(state, ctx.rng);
    ctx.emit({ type: 'log', key: 'thegang.heist', args: { heist: state.heist } });
    ctx.goTo('draft');
  },
};

const states: Record<string, StateDef<GangState>> = {
  /** 每轮同时抢筹码。activePlayer 只是用来复用平台的超时兜底，任何人都能随时动。 */
  draft: {
    type: 'activePlayer',
    onEnter(state) {
      state.turn = nextActor(state);
    },
    onTimeout(state) {
      const me = state.players[state.turn];
      if (!me) return null;
      const roundIndex = state.round - 1;

      if (state.chips[me]?.[roundIndex] == null) {
        const taken = new Set(state.players.map((player) => state.chips[player]?.[roundIndex]));
        for (let star = 1; star <= state.players.length; star += 1) {
          if (!taken.has(star)) return { type: 'takeChip', payload: { star } };
        }
      }
      return { type: 'confirm', payload: {} };
    },
  },

  /** 一轮结束 → 翻公共牌 → 下一轮；第四轮之后进摊牌 */
  nextRound: {
    type: 'global',
    next: (state) => (state.round > 4 ? 'showdown' : 'draft'),
    onEnter(state, ctx) {
      if (state.round >= 4) {
        state.round = 5;
        return;
      }

      state.round += 1;
      const reveal = state.round === 2 ? 3 : 1;
      for (let index = 0; index < reveal; index += 1) {
        const card = state.deck.pop();
        if (card) state.community.push(card);
      }
      state.ready = zeroed(state.players, false);
      state.turn = 0;

      ctx.emit({
        type: 'log',
        key: 'thegang.round',
        args: {
          round: state.round,
          community: state.community.map(cardLabel),
        },
      });
    },
  },

  showdown: {
    type: 'global',
    next: 'heistEnd',
    onEnter(state, ctx) {
      const order = [...state.players].sort(
        (left, right) => (state.chips[left]?.[3] ?? 99) - (state.chips[right]?.[3] ?? 99),
      );

      const seats: HeistSeat[] = [];
      let badAt: number | null = null;
      let previous: number[] | null = null;

      for (const [index, player] of order.entries()) {
        const cards = [...(state.hands[player] ?? []), ...state.community];
        const { score, best } = evaluateWithBest(cards);
        if (previous && compareScores(score, previous) < 0 && badAt === null) badAt = index;
        seats.push({
          player,
          chip: state.chips[player]?.[3] ?? 0,
          score,
          name: categoryName(score),
          hand: cards.map(cardLabel),
          best: best.map(cardLabel),
        });
        previous = score;
      }

      state.revealed = true;
      state.last = {
        heist: state.heist,
        ok: badAt === null,
        seats,
        community: state.community.map(cardLabel),
        badAt,
      };
      state.history = [...state.history, state.last];

      ctx.emit({
        type: 'log',
        key: badAt === null ? 'thegang.heistWin' : 'thegang.heistFail',
        args: { heist: state.heist, seats: seats.map((seat) => ({ player: seat.player, chip: seat.chip })) },
      });
    },
  },

  heistEnd: {
    type: 'global',
    next: (state) => (state.finished ? 'finished' : 'heistResult'),
    onEnter(state, ctx) {
      if (state.last?.ok) state.vaults += 1;
      else state.alarms += 1;

      const over = state.vaults >= 3 || state.alarms >= 3;
      if (over) {
        state.finished = true;
        // 合作局：不排名 → 平台不会记 Elo、也不会写战绩
        state.ranking = null;
        ctx.emit({
          type: 'log',
          key: 'thegang.gameEnd',
          args: { win: state.vaults >= 3, vaults: state.vaults, alarms: state.alarms },
        });
      }
    },
  },

  /** 摊牌结果留一屏：谁想继续就点一下，超时自动继续，不会卡住 */
  heistResult: {
    type: 'activePlayer',
    onEnter(state) {
      state.turn = 0;
    },
    onTimeout() {
      return { type: 'advance', payload: {} };
    },
  },

  finished: {
    type: 'global',
  },
};

const theGang: GamePlugin<GangState> = {
  manifest,

  createState({ players, seed }) {
    const state: GangState = {
      players: [...players],
      turn: 0,
      round: 1,
      phase: 'draft',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      heist: 1,
      vaults: 0,
      alarms: 0,
      deck: [],
      community: [],
      hands: zeroed(players, []),
      chips: emptyChips(players),
      ready: zeroed(players, false),
      revealed: false,
      last: null,
      history: [],
    };

    dealHeist(state, seededRandom(seed));
    return state;
  },

  states,
  actions: {
    takeChip,
    confirm: confirmChip,
    advance,
  },

  view(state, viewer): PublicView {
    const revealed = state.revealed || state.finished;
    const hands: Record<string, string[]> = {};
    for (const player of state.players) {
      // 隐藏信息只在这里裁剪：没摊牌之前只能看到自己的底牌
      if (revealed || player === viewer) {
        hands[player] = (state.hands[player] ?? []).map(cardLabel);
      }
    }

    return {
      phase: state.phase,
      players: state.players,
      turn: state.finished ? null : (state.players[state.turn] ?? null),
      round: Math.min(state.round, 4),
      finished: state.finished,
      ranking: state.ranking,
      data: {
        heist: state.heist,
        vaults: state.vaults,
        alarms: state.alarms,
        round: Math.min(state.round, 4),
        community: state.community.map(cardLabel),
        chips: state.chips,
        ready: state.ready,
        hands,
        handsCount: Object.fromEntries(
          state.players.map((player) => [player, (state.hands[player] ?? []).length]),
        ),
        you: viewer,
        revealed,
        last: state.last,
        history: state.history,
        win: state.finished ? state.vaults >= 3 : null,
      },
    };
  },

  legalMoves(state, playerId) {
    if (state.phase !== 'draft') return [];
    const roundIndex = state.round - 1;
    const moves: { type: string; payload: unknown }[] = [];
    for (let star = 1; star <= state.players.length; star += 1) {
      moves.push({ type: 'takeChip', payload: { star } });
    }
    if (state.chips[playerId]?.[roundIndex] != null) {
      moves.push({ type: 'confirm', payload: {} });
    }
    return moves;
  },
};

export default theGang;
export { theGang };
