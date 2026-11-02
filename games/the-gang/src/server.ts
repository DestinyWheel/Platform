/**
 * 纸牌帮（The Gang）—— 服务端规则。
 *
 * 合作德州扑克：四轮筹码表态 + 摊牌按顺序亮牌，全队连续排对才算抢下一个金库。
 * 规则细节全部对照官方手册（KOSMOS，2024）实现；界面文案是中文。
 *
 * 四档难度：
 *   basic        基础局，不带卡
 *   advanced     进阶，第 1 次抢劫不带卡，之后成功抽挑战卡 / 失败抽专家卡
 *   professional 专业，开局先抽一张挑战卡整局有效，且牌堆里没有「快速通道」
 *   master       大师，2 次警报就输、没有专家卡、永远 2 张挑战卡
 */
import { z } from 'zod';
import type {
  ActionContext,
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
import { CHALLENGE, effectsOf, MODE_NAME, SPECIALIST, configForMode, DEFAULT_CUSTOM_CONFIG, type ChallengeEffects, type GangConfig, type GangMode } from './cards';

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
  /** 这个人的底牌（2 或 3 张），摊牌时和 best 并排展示 */
  pocket: string[];
  hand: string[];
  /** 打手：同牌型压别人 */
  muscle?: boolean;
}

export interface HeistResult {
  heist: number;
  ok: boolean;
  seats: HeistSeat[];
  community: string[];
  /** 第一个排错的人在 seats 里的下标；没错就是 null */
  badAt: number | null;
  /** 视网膜 / 指纹扫描的猜测结果 */
  guess: { kind: 'value' | 'rank'; value: string; ok: boolean } | null;
  /** 这次生效的卡 */
  challenge: number[];
  specialist: number | null;
}

export interface GuessState {
  kind: 'value' | 'rank';
  /** 被猜的那个人：红筹码最高的 */
  target: PlayerId;
  /** 每人的猜测；还没投就没有这个 key */
  picks: Record<PlayerId, string>;
}

export interface GangState extends BaseState {
  heist: number;
  vaults: number;
  alarms: number;
  alarmsToLose: number;
  mode: GangMode;
  /** 这一局的规则配置：四档官方难度是它的预设，自定义模式直接改它 */
  config: GangConfig;
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
  /** 本次抢劫生效的挑战卡（0~2 张） */
  challenge: number[];
  specialist: number | null;
  stacks: { challenge: number[]; specialist: number[] };
  /** 从 challenge 算出来的规则开关 */
  effects: ChallengeEffects;
  /** 断电清掉过筹码的轮次，只为界面提示 */
  blackoutRounds: number[];
  /** 动作感应器 / 激光绊网 这次让谁换了底牌（公开信息） */
  redrawPlayer: PlayerId | null;
  /** 专家卡用没用、归谁（打手 / 老千这类要认领的） */
  specialistUsed: boolean;
  specialistOwner: PlayerId | null;
  /** 公开信息：投资人 / 数学老师 / 老司机 / 主谋 报出来的东西 */
  notes: { kind: string; player?: PlayerId; value?: number | string }[];
  /** 只给某个人看的信息：线人看到的牌 */
  secrets: Record<PlayerId, string[]>;
  /** 黑客 / 老千：手上多了一张，等着弃 */
  pending: { player: PlayerId; kind: 'hacker' | 'jack' } | null;
  /** 打手：摊牌时同牌型压别人 */
  muscle: PlayerId | null;
  guess: GuessState | null;
  guessOk: boolean | null;
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

function pickRandom<T>(items: T[], rng: () => number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

/** 当前该催谁：优先没拿筹码的，其次没确认的 */
function nextActor(state: GangState): number {
  const roundIndex = state.round - 1;
  const noChip = state.players.findIndex((player) => state.chips[player]?.[roundIndex] == null);
  if (noChip >= 0) return noChip;
  const notReady = state.players.findIndex((player) => !state.ready[player]);
  return notReady >= 0 ? notReady : 0;
}

/** 牌面点数：J/Q/K 算 10，A 算 11，万能 J 也算 10 */
function cardValue(card: Card): number {
  const rank = card.slice(0, -1).replace('10', 'T');
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

/** 发完底牌就生效的专家卡（投资人 / 数学老师 / 女骗子 / 协调者） */
function applyDealSpecialists(state: GangState, rng: () => number): void {
  const card = state.specialist;
  if (card == null) return;

  if (card === 3) {
    for (const player of state.players) {
      const count = (state.hands[player] ?? []).filter((item) =>
        ['J', 'Q', 'K'].includes(item.slice(0, -1)),
      ).length;
      state.notes.push({ kind: 'investor', player, value: count });
    }
    return;
  }

  if (card === 8) {
    for (const player of state.players) {
      const sum = (state.hands[player] ?? []).reduce((acc, item) => acc + cardValue(item), 0);
      state.notes.push({ kind: 'math', player, value: sum });
    }
    return;
  }

  if (card === 9) {
    const size = state.effects.pocketSize;
    const pool = state.players.flatMap((player) => state.hands[player] ?? []);
    const mixed = shuffle(pool, rng);
    state.players.forEach((player, index) => {
      state.hands[player] = mixed.slice(index * size, (index + 1) * size);
    });
    state.notes.push({ kind: 'conartist' });
    return;
  }

  if (card === 6) {
    // 简化：每人传出去的是点数最小的那张（手册里由本人决定）
    const gifts = new Map<PlayerId, Card>();
    for (const player of state.players) {
      const hand = state.hands[player] ?? [];
      if (hand.length === 0) continue;
      let lowest = 0;
      hand.forEach((item, index) => {
        if (cardValue(item) < cardValue(hand[lowest]!)) lowest = index;
      });
      gifts.set(player, hand[lowest]!);
      state.hands[player] = hand.filter((_, index) => index !== lowest);
    }
    state.players.forEach((player, index) => {
      const left = state.players[(index + 1) % state.players.length]!;
      const gift = gifts.get(left);
      if (gift) state.hands[player] = [...(state.hands[player] ?? []), gift];
    });
    state.notes.push({ kind: 'coordinator' });
  }
}

/** 发一次新的抢劫：洗牌、发底牌、清空公共牌和筹码 */
export function dealHeist(state: GangState, rng: () => number): void {
  state.effects = effectsOf(state.challenge);
  state.deck = shuffle(makeDeck(), rng);
  const size = state.effects.pocketSize;

  state.hands = zeroed(state.players, []);
  for (const player of state.players) {
    state.hands[player] = Array.from({ length: size }, () => state.deck.pop()!);
  }

  state.community = [];
  state.chips = emptyChips(state.players);
  state.ready = zeroed(state.players, false);
  state.revealed = false;
  state.last = null;
  state.blackoutRounds = [];
  state.redrawPlayer = null;
  state.specialistUsed = false;
  state.specialistOwner = null;
  state.notes = [];
  state.secrets = zeroed(state.players, []);
  state.pending = null;
  state.muscle = null;
  state.guess = null;
  state.guessOk = null;

  state.round = state.effects.skipFirst ? 2 : 1;
  applyDealSpecialists(state, rng);
  if (state.effects.skipFirst) {
    for (let index = 0; index < 3; index += 1) {
      const card = state.deck.pop();
      if (card) state.community.push(card);
    }
    applyRedraw(state, rng);
  }
  state.turn = 0;
}

/** 动作感应器 / 激光绊网：翻牌轮可能让某个人换底牌 */
function applyRedraw(state: GangState, rng: () => number): void {
  if (!state.effects.redraw || state.community.length < 3) return;

  const face = state.community
    .slice(0, 3)
    .some((card) => ['J', 'Q', 'K'].includes(card.slice(0, -1).replace('10', 'T')));
  if (state.effects.redraw === 'face' && !face) return;
  if (state.effects.redraw === 'noFace' && face) return;

  const star = state.effects.redraw === 'face' ? 1 : state.players.length;
  const holder = state.players.find((player) => state.chips[player]?.[0] === star);
  if (!holder) return;

  state.hands[holder] = Array.from({ length: state.effects.pocketSize }, () => state.deck.pop()!);
  state.redrawPlayer = holder;
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

/**
 * 这一轮哪些星数被锁死了（噪音感应器 / 通风管道只管前三轮）。
 *
 * 两张挑战卡可以同时生效（自定义/大师叠加），所以返回数组而不是单个星。
 */
function lockedStars(state: GangState): number[] {
  if (state.round > 3) return [];
  const stars: number[] = [];
  if (state.effects.lockLow) stars.push(1);
  if (state.effects.lockHigh) stars.push(state.players.length);
  return [...new Set(stars)];
}

/** 某一轮某个星数现在在谁手里 */
function chipHolder(state: GangState, roundIndex: number, star: number): string | null {
  return state.players.find((player) => state.chips[player]?.[roundIndex] === star) ?? null;
}

const takeChip: ActionDef<GangState> = {
  allowedIn: ['draft'],
  schema: z.object({ star: z.number().int().min(1).max(6) }),
  validate(state, action, ctx) {
    const { star } = action.payload as { star: number };
    if (star > state.players.length) return { ok: false, reason: 'chip.outOfRange' };
    if (!state.players.includes(ctx.playerId)) return { ok: false, reason: 'not.in.table' };

    const roundIndex = state.round - 1;
    const locked = lockedStars(state);
    const mine = state.chips[ctx.playerId]?.[roundIndex] ?? null;

    // 锁死的筹码：已经在自己手上就不能换掉，在别人手上就不能抢
    if (mine != null && locked.includes(mine) && star !== mine) {
      return {
        ok: false,
        reason: `本轮 ${mine} 星筹码是锁定筹码，拿了就不能换。要换只能等下一轮。`,
      };
    }
    if (locked.includes(star)) {
      const holder = chipHolder(state, roundIndex, star);
      if (holder != null && holder !== ctx.playerId) {
        return {
          ok: false,
          reason: `本轮 ${star} 星筹码已经被锁定，不能从别人手里抢。换一个吧。`,
        };
      }
    }
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
    // 锁定筹码拿起来就定死，直接算确认，不给再换的机会
    const autoReady = lockedStars(state).includes(star);
    state.ready[ctx.playerId] = autoReady;
    ctx.emit({
      type: 'log',
      key: 'thegang.take',
      args: { player: ctx.playerId, star, round: state.round },
    });
    if (autoReady) {
      ctx.emit({
        type: 'log',
        key: 'thegang.autoReady',
        args: { player: ctx.playerId, star, round: state.round },
      });
    }

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

/** 摊牌前的全队猜测（视网膜 / 指纹扫描） */
const submitGuess: ActionDef<GangState> = {
  allowedIn: ['guess'],
  schema: z.object({ value: z.string().min(1).max(12) }),
  validate(state, action, ctx) {
    const guess = state.guess;
    if (!guess) return { ok: false, reason: 'guess.none' };
    if (ctx.playerId === guess.target) return { ok: false, reason: 'guess.spectator' };
    const { value } = action.payload as { value: string };
    const ok =
      guess.kind === 'value'
        ? /^(2|3|4|5|6|7|8|9|10|J|Q|K|A)$/.test(value)
        : /^(highcard|pair|twopair|trips|straight|flush|fullhouse|quads|straightflush|royalflush)$/.test(
            value,
          );
    return ok ? { ok: true } : { ok: false, reason: 'guess.invalid' };
  },
  reduce(state, action, ctx) {
    const { value } = action.payload as { value: string };
    state.guess!.picks[ctx.playerId] = value;

    const others = state.players.filter((player) => player !== state.guess!.target);
    const voted = others.filter((player) => state.guess!.picks[player] != null);
    const unanimous = voted.length === others.length && new Set(voted.map((p) => state.guess!.picks[p])).size === 1;

    if (unanimous) {
      resolveGuess(state, ctx);
      ctx.goTo('showdown');
      return;
    }

    const pending = state.players.findIndex(
      (player) => player !== state.guess!.target && state.guess!.picks[player] == null,
    );
    const fallback = state.players.findIndex((player) => player !== state.guess!.target);
    state.turn = pending >= 0 ? pending : Math.max(0, fallback);
  },
};

/** 专家卡：一次性使用，效果按卡面来 */
const useSpecialist: ActionDef<GangState> = {
  allowedIn: ['draft'],
  schema: z.object({
    target: z.string().min(1).max(64).optional(),
    card: z.number().int().min(0).max(5).optional(),
    value: z.string().min(1).max(2).optional(),
  }),
  validate(state, action, ctx) {
    if (state.specialist == null) return { ok: false, reason: 'specialist.none' };
    if (state.specialistUsed) return { ok: false, reason: 'specialist.used' };
    if (state.pending) return { ok: false, reason: 'specialist.busy' };
    if (!state.players.includes(ctx.playerId)) return { ok: false, reason: 'not.in.table' };

    const payload = action.payload as { target?: string; card?: number; value?: string };
    const hand = state.hands[ctx.playerId] ?? [];

    if (state.specialist === 1) {
      if (!payload.target || !state.players.includes(payload.target)) {
        return { ok: false, reason: 'specialist.target' };
      }
      if (payload.target === ctx.playerId) return { ok: false, reason: 'specialist.target' };
      if (payload.card == null || payload.card >= hand.length) {
        return { ok: false, reason: 'specialist.card' };
      }
    }
    if (state.specialist === 4) {
      if (!payload.value || !/^(2|3|4|5|6|7|8|9|10|J|Q|K|A)$/.test(payload.value)) {
        return { ok: false, reason: 'specialist.value' };
      }
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as { target?: string; card?: number; value?: string };
    const card = state.specialist!;
    state.specialistUsed = true;
    state.specialistOwner = ctx.playerId;

    if (card === 1) {
      const hand = state.hands[ctx.playerId] ?? [];
      const shown = cardLabel(hand[payload.card!]!);
      state.secrets[payload.target!] = [...(state.secrets[payload.target!] ?? []), shown];
      state.notes.push({ kind: 'informant', player: ctx.playerId, value: payload.target });
    } else if (card === 2) {
      const { score } = evaluateWithBest([...(state.hands[ctx.playerId] ?? []), ...state.community]);
      state.notes.push({ kind: 'driver', player: ctx.playerId, value: categoryName(score) });
    } else if (card === 4) {
      const want = String(payload.value).replace('10', 'T');
      const count = (state.hands[ctx.playerId] ?? []).filter(
        (item) => item.slice(0, -1).replace('10', 'T') === want,
      ).length;
      state.notes.push({ kind: 'mastermind', player: ctx.playerId, value: `${payload.value} × ${count}` });
    } else if (card === 5 || card === 7) {
      const drawn = card === 7 ? 'J*' : state.deck.pop()!;
      state.hands[ctx.playerId] = [...(state.hands[ctx.playerId] ?? []), drawn];
      state.pending = { player: ctx.playerId, kind: card === 7 ? 'jack' : 'hacker' };
    } else if (card === 10) {
      state.muscle = ctx.playerId;
      state.notes.push({ kind: 'muscle', player: ctx.playerId });
    }

    ctx.emit({ type: 'log', key: 'thegang.specialist', args: { player: ctx.playerId, card } });
  },
};

/** 黑客 / 老千多出来的那张牌，选一张弃掉 */
const discardCard: ActionDef<GangState> = {
  allowedIn: ['draft'],
  schema: z.object({ index: z.number().int().min(0).max(6) }),
  validate(state, action, ctx) {
    if (!state.pending || state.pending.player !== ctx.playerId) {
      return { ok: false, reason: 'specialist.pending' };
    }
    const { index } = action.payload as { index: number };
    const hand = state.hands[ctx.playerId] ?? [];
    if (index < 0 || index >= hand.length) return { ok: false, reason: 'specialist.card' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { index } = action.payload as { index: number };
    const hand = state.hands[ctx.playerId] ?? [];
    state.hands[ctx.playerId] = hand.filter((_, position) => position !== index);
    state.pending = null;
    ctx.emit({ type: 'log', key: 'thegang.discard', args: { player: ctx.playerId } });
  },
};

/* ------------------------------------------------------------------ */
/* 自定义模式：开桌之后在牌桌里配                                       */
/* ------------------------------------------------------------------ */

const configSchema = z.object({
  /** 失败之后发不发专家卡 */
  specialist: z.boolean().optional(),
  /** 成功之后抽不抽挑战卡 */
  challenge: z.boolean().optional(),
  /** 常驻挑战卡（1–10，可以多张） */
  permanent: z.array(z.number().int().min(1).max(10)).max(10).optional(),
  /** 挑战卡是否叠加 */
  stack: z.boolean().optional(),
  /** 抢下几个金库算赢 */
  vaultsToWin: z.number().int().min(1).max(5).optional(),
  /** 几次警报算输 */
  alarmsToLose: z.number().int().min(1).max(5).optional(),
});

/** 改配置：任何在座的人都能改（合作局，谁改都一样），只在设置阶段有用 */
const configure: ActionDef<GangState> = {
  allowedIn: ['setup'],
  schema: configSchema,
  validate(state, action, ctx) {
    if (!state.players.includes(ctx.playerId)) return { ok: false, reason: 'not.in.table' };
    const patch = action.payload as Partial<GangConfig>;
    if (patch.permanent && new Set(patch.permanent).size !== patch.permanent.length) {
      return { ok: false, reason: 'setup.duplicate' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const patch = action.payload as Partial<GangConfig>;
    state.config = { ...state.config, ...patch };
    // 常驻挑战卡排序一下，界面和日志都好读
    state.config.permanent = [...new Set(state.config.permanent)].sort((left, right) => left - right);
    state.alarmsToLose = state.config.alarmsToLose;
    ctx.emit({ type: 'log', key: 'thegang.configure', args: { ...state.config } });
  },
};

/** 配好了，发牌开打 */
const deal: ActionDef<GangState> = {
  allowedIn: ['setup'],
  schema: z.object({}),
  validate(state, action, ctx) {
    if (!state.players.includes(ctx.playerId)) return { ok: false, reason: 'not.in.table' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    // 建两个牌堆：常驻的挑出来，剩下的按 1–10 顺序当抽牌堆
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const permanents = state.config.permanent;
    state.challenge = [...permanents];
    state.stacks.challenge = all.filter((id) => !permanents.includes(id));
    state.stacks.specialist = state.config.specialist ? [...all] : [];
    state.specialist = null;
    dealHeist(state, ctx.rng);
    ctx.emit({ type: 'log', key: 'thegang.deal', args: { ...state.config } });
    ctx.goTo('draft');
  },
};

const states: Record<string, StateDef<GangState>> = {
  /**
   * 自定义模式的设置阶段：任何在座的人都能改配置，改完点「发牌」。
   *
   * 用 global 而不是 activePlayer：这一阶段不该吃平台的回合超时
   * （人还在看设置面板，不该被自动替走一手）。
   */
  setup: {
    type: 'global',
  },

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
        const locked = new Set(lockedStars(state));
        for (let star = 1; star <= state.players.length; star += 1) {
          if (taken.has(star)) continue;
          if (locked.has(star)) continue;
          return { type: 'takeChip', payload: { star } };
        }
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
    next: (state) => (state.round > 4 ? (state.effects.guess ? 'guess' : 'showdown') : 'draft'),
    onEnter(state, ctx) {
      if (state.round >= 4) {
        state.round = 5;
        return;
      }

      if (state.effects.skipThird && state.round === 2) {
        // 匆忙撤离：第三轮不发橙色筹码，但转牌和河牌都要翻出来，
        // 否则河牌轮手里只有 4 张公共牌，摊牌就错了
        for (let index = 0; index < 2; index += 1) {
          const card = state.deck.pop();
          if (card) state.community.push(card);
        }
        state.round = 4;
        ctx.emit({
          type: 'log',
          key: 'thegang.round',
          args: { round: 4, community: state.community.map(cardLabel), skipped: 3 },
        });
      } else {
        state.round += 1;
        const reveal = state.round === 2 ? 3 : 1;
        for (let index = 0; index < reveal; index += 1) {
          const card = state.deck.pop();
          if (card) state.community.push(card);
        }
        if (state.round === 2) applyRedraw(state, ctx.rng);
        ctx.emit({
          type: 'log',
          key: 'thegang.round',
          args: { round: state.round, community: state.community.map(cardLabel) },
        });
      }

      // 断电：上一轮的筹码丢掉，只能靠记性
      if (state.effects.blackout && state.round > 1) {
        const previous = state.round - 2;
        if (previous >= 0) {
          for (const player of state.players) state.chips[player]![previous] = null;
          state.blackoutRounds = [...state.blackoutRounds, previous + 1];
          ctx.emit({ type: 'log', key: 'thegang.blackout', args: { round: previous + 1 } });
        }
      }

      state.ready = zeroed(state.players, false);
      state.turn = 0;
    },
  },

  /** 视网膜 / 指纹扫描：除红筹码最高的人之外，全队先统一口径 */
  guess: {
    type: 'activePlayer',
    onEnter(state) {
      const target = [...state.players].sort(
        (left, right) => (state.chips[right]?.[3] ?? 0) - (state.chips[left]?.[3] ?? 0),
      )[0]!;
      state.guess = { kind: state.effects.guess!, target, picks: {} };
      state.turn = Math.max(0, state.players.findIndex((player) => player !== target));
    },
    onTimeout(state, ctx) {
      const guess = state.guess;
      const me = state.players[state.turn];
      if (!guess || !me || me === guess.target) return null;
      // 超时的人跟已经投出来的多数，避免卡死
      const votes = Object.values(guess.picks);
      const value =
        votes.length > 0
          ? votes.sort(
              (left, right) =>
                votes.filter((item) => item === right).length -
                votes.filter((item) => item === left).length,
            )[0]!
          : guess.kind === 'value'
            ? 'A'
            : 'highcard';
      return { type: 'guess', payload: { value } };
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
      let previous: HeistSeat | null = null;

      /** 打手：同牌型时他更大，其余照常比 */
      const stronger = (left: HeistSeat, right: HeistSeat): number => {
        const sameRank = (left.score[0] ?? 0) === (right.score[0] ?? 0);
        if (sameRank && Boolean(left.muscle) !== Boolean(right.muscle)) return left.muscle ? 1 : -1;
        return compareScores(left.score, right.score);
      };

      for (const [index, player] of order.entries()) {
        const cards = [...(state.hands[player] ?? []), ...state.community];
        const { score, best } = evaluateWithBest(cards);
        const seat: HeistSeat = {
          player,
          chip: state.chips[player]?.[3] ?? 0,
          score,
          name: categoryName(score),
          hand: cards.map(cardLabel),
          best: best.map(cardLabel),
          pocket: (state.hands[player] ?? []).map(cardLabel),
          muscle: state.muscle === player,
        };
        if (previous && stronger(seat, previous) < 0 && badAt === null) badAt = index;
        seats.push(seat);
        previous = seat;
      }

      // 猜错了，就算顺序全对也算这次抢劫失败
      if (state.guessOk === false) badAt = 0;

      state.revealed = true;
      state.last = {
        heist: state.heist,
        ok: badAt === null,
        seats,
        community: state.community.map(cardLabel),
        badAt,
        guess: state.guess
          ? {
              kind: state.guess.kind,
              value: Object.values(state.guess.picks)[0] ?? '',
              ok: state.guessOk === true,
            }
          : null,
        challenge: [...state.challenge],
        specialist: state.specialist,
      };
      state.history = [...state.history, state.last];

      ctx.emit({
        type: 'log',
        key: badAt === null ? 'thegang.heistWin' : 'thegang.heistFail',
        args: {
          heist: state.heist,
          seats: seats.map((seat) => ({ player: seat.player, chip: seat.chip })),
        },
      });

      // 成就：抢下第一个金库的人人有份（合作局，功劳是大家的）
      if (badAt === null) {
        for (const player of state.players) {
          ctx.emit({ type: 'achievement', player, key: 'first-heist' });
        }
      }
    },
  },

  heistEnd: {
    type: 'global',
    next: (state) => (state.finished ? 'finished' : 'heistResult'),
    onEnter(state, ctx) {
      if (state.last?.ok) state.vaults += 1;
      else state.alarms += 1;

      const over = state.vaults >= state.config.vaultsToWin || state.alarms >= state.config.alarmsToLose;
      if (over) {
        state.finished = true;
        // 合作局：不排名 → 平台不会记 Elo、也不会写战绩
        state.ranking = null;
        ctx.emit({
          type: 'log',
          key: 'thegang.gameEnd',
          args: {
            win: state.vaults >= state.config.vaultsToWin,
            vaults: state.vaults,
            alarms: state.alarms,
            limit: state.config.alarmsToLose,
            target: state.config.vaultsToWin,
          },
        });

        // 成就：赢下来才叫「全身而退」
        if (state.vaults >= state.config.vaultsToWin) {
          for (const player of state.players) {
            ctx.emit({ type: 'achievement', player, key: 'clean-getaway' });
            if (state.alarms === 0) {
              ctx.emit({ type: 'achievement', player, key: 'no-alarm' });
            }
          }
        }
        return;
      }

      prepareNextHeist(state, ctx);
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

/** 结算后决定下一次抢劫生效的卡，并把本轮的卡退回牌堆底部 */
function prepareNextHeist(state: GangState, ctx: ActionContext<GangState>): void {
  if (state.mode === 'master') {
    // 丢掉编号最小的一张，再抽一张新的，永远保持 2 张
    const sorted = [...state.challenge].sort((left, right) => left - right);
    const dropped = sorted[0];
    state.challenge = state.challenge.filter((id) => id !== dropped);
    const next = state.stacks.challenge.shift();
    if (next != null) state.challenge = [...state.challenge, next];
    return;
  }

  if (state.mode === 'basic') return;

  // 专家卡只生效一次，用完回底部
  if (state.specialist != null) {
    state.stacks.specialist.push(state.specialist);
    state.specialist = null;
  }

  const permanents = state.config.permanent;
  const perHeist = state.challenge.filter((id) => !permanents.includes(id));

  if (!state.config.stack) {
    // 不叠加：这一抢的挑战卡退回牌堆底部，只留常驻的
    for (const id of perHeist) state.stacks.challenge.push(id);
    state.challenge = [...permanents];
  }
  // 叠加打开什么都不用做：已经抽到的卡继续生效，下一抢再往上加

  if (state.last?.ok) {
    if (state.config.challenge) {
      const next = state.stacks.challenge.shift();
      if (next != null) state.challenge = [...state.challenge, next];
    }
  } else if (state.config.specialist) {
    // 进阶 / 专业 / 自定义：失败给专家卡
    const next = state.stacks.specialist.shift();
    if (next != null) state.specialist = next;
  }
}

/** 猜完之后判定：视网膜看点数，指纹看待牌型 */
function resolveGuess(state: GangState, ctx: ActionContext<GangState>): void {
  const guess = state.guess;
  if (!guess) return;
  const value = Object.values(guess.picks)[0] ?? '';
  const cards = state.hands[guess.target] ?? [];

  if (guess.kind === 'value') {
    state.guessOk = cards.some((card) => {
      const label = card.slice(0, -1).replace('T', '10');
      return label === value;
    });
  } else {
    const { score } = evaluateWithBest([...cards, ...state.community]);
    const names = [
      'highcard',
      'pair',
      'twopair',
      'trips',
      'straight',
      'flush',
      'fullhouse',
      'quads',
      'straightflush',
    ];
    const actual = score[0] === 8 && score[1] === 14 ? 'royalflush' : names[score[0] ?? 0];
    state.guessOk = actual === value;
  }

  ctx.emit({
    type: 'log',
    key: 'thegang.guess',
    args: { kind: guess.kind, value, ok: state.guessOk },
  });
}

const theGang: GamePlugin<GangState> = {
  manifest,

  createState({ players, options, seed }) {
    const rawMode = String(options.mode ?? 'advanced');
    const mode: GangMode =
      rawMode === 'basic' || rawMode === 'professional' || rawMode === 'master' || rawMode === 'custom'
        ? rawMode
        : 'advanced';

    const rng = seededRandom(seed);
    const fullChallenge = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    /** 自定义：开局停在「设置」阶段，配好再发牌 */
    const custom = mode === 'custom';
    const config: GangConfig = custom ? { ...DEFAULT_CUSTOM_CONFIG } : configForMode(mode);

    const state: GangState = {
      players: [...players],
      turn: 0,
      round: 1,
      phase: custom ? 'setup' : 'draft',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      heist: 1,
      vaults: 0,
      alarms: 0,
      alarmsToLose: config.alarmsToLose,
      mode,
      config,
      deck: [],
      community: [],
      hands: zeroed(players, []),
      chips: emptyChips(players),
      ready: zeroed(players, false),
      revealed: false,
      last: null,
      history: [],
      challenge: [],
      specialist: null,
      stacks: { challenge: [], specialist: [] },
      effects: effectsOf([]),
      blackoutRounds: [],
      redrawPlayer: null,
      specialistUsed: false,
      specialistOwner: null,
      notes: [],
      secrets: zeroed(players, []),
      pending: null,
      muscle: null,
      guess: null,
      guessOk: null,
    };

    if (custom) return state;

    if (mode !== 'basic') {
      // 专业 / 大师模式把「快速通道」抽掉
      const pool = mode === 'advanced' ? [...fullChallenge] : fullChallenge.filter((id) => id !== 1);
      state.stacks.challenge = pool;
      state.stacks.specialist = mode === 'master' ? [] : [...fullChallenge];

      if (mode === 'professional') {
        const permanent = pickRandom(pool, rng) ?? null;
        state.config.permanent = permanent != null ? [permanent] : [];
        state.stacks.challenge = pool.filter((id) => id !== permanent);
        state.challenge = permanent != null ? [permanent] : [];
      }

      if (mode === 'master') {
        // 开局就抽 2 张
        for (let index = 0; index < 2; index += 1) {
          const next = state.stacks.challenge.shift();
          if (next != null) state.challenge.push(next);
        }
      }
    }

    dealHeist(state, rng);
    return state;
  },

  states,
  actions: {
    takeChip,
    confirm: confirmChip,
    advance,
    guess: submitGuess,
    useSpecialist,
    discard: discardCard,
    configure,
    deal,
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
        alarmsToLose: state.config.alarmsToLose,
        vaultsToWin: state.config.vaultsToWin,
        config: state.config,
        setup: state.phase === 'setup',
        /** 设置阶段要给所有人看完整的卡表（含未启用的） */
        catalog: {
          challenge: Object.entries(CHALLENGE).map(([id, info]) => ({ id: Number(id), ...info })),
          specialist: Object.entries(SPECIALIST).map(([id, info]) => ({ id: Number(id), ...info })),
        },
        mode: state.mode,
        modeName: MODE_NAME[state.mode],
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
        challenge: state.challenge,
        challengeInfo: state.challenge.map((id) => ({ id, ...CHALLENGE[id]! })),
        specialist: state.specialist,
        specialistInfo: state.specialist != null ? { id: state.specialist, ...SPECIALIST[state.specialist]! } : null,
        specialistUsed: state.specialistUsed,
        specialistOwner: state.specialistOwner,
        notes: state.notes,
        secrets: state.secrets[viewer as string] ?? [],
        pending: state.pending ? { player: state.pending.player, kind: state.pending.kind } : null,
        muscle: state.muscle,
        blackoutRounds: state.blackoutRounds,
        guess: state.guess
          ? {
              kind: state.guess.kind,
              target: state.guess.target,
              // 只告诉"谁投了"，不告诉投的什么
              voted: Object.keys(state.guess.picks),
              mine: state.guess.picks[viewer as string] ?? null,
            }
          : null,
        guessOk: state.guessOk,
        lockedStars: lockedStars(state),
      },
    };
  },

  legalMoves(state, playerId) {
    if (state.phase === 'guess') {
      const guess = state.guess;
      if (!guess || playerId === guess.target) return [];
      if (guess.kind === 'value') {
        return ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map((value) => ({
          type: 'guess',
          payload: { value },
        }));
      }
      return [
        'highcard',
        'pair',
        'twopair',
        'trips',
        'straight',
        'flush',
        'fullhouse',
        'quads',
        'straightflush',
        'royalflush',
      ].map((value) => ({ type: 'guess', payload: { value } }));
    }

    if (state.phase !== 'draft') return [];
    const roundIndex = state.round - 1;
    const mine = state.chips[playerId]?.[roundIndex] ?? null;
    // 已经确认（包括拿锁定筹码后的自动确认）就不能再选
    if (state.ready[playerId]) return [];
    // 手里已经是锁定筹码，不能再换别的
    const locked = lockedStars(state);
    if (mine != null && locked.includes(mine)) return [];

    const moves: { type: string; payload: unknown }[] = [];
    for (let star = 1; star <= state.players.length; star += 1) {
      // 锁定筹码在别人手里时，这个选择必然失败，不要给出来
      if (locked.includes(star)) {
        const holder = chipHolder(state, roundIndex, star);
        if (holder != null && holder !== playerId) continue;
      }
      moves.push({ type: 'takeChip', payload: { star } });
    }
    if (mine != null) {
      moves.push({ type: 'confirm', payload: {} });
    }
    return moves;
  },
};

export default theGang;
export { theGang };
