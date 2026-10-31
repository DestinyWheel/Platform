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
import { CHALLENGE, effectsOf, MODE_NAME, type ChallengeEffects, type GangMode } from './cards';

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
  /** 专业模式整局有效的那张挑战卡 */
  permanent: number | null;
  stacks: { challenge: number[]; specialist: number[] };
  /** 从 challenge 算出来的规则开关 */
  effects: ChallengeEffects;
  /** 断电清掉过筹码的轮次，只为界面提示 */
  blackoutRounds: number[];
  /** 动作感应器 / 激光绊网 这次让谁换了底牌（公开信息） */
  redrawPlayer: PlayerId | null;
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
  state.guess = null;
  state.guessOk = null;

  state.round = state.effects.skipFirst ? 2 : 1;
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

/** 这一轮哪些星数被锁死了（噪音感应器 / 通风管道只管前三轮） */
function lockedStar(state: GangState): number | null {
  if (state.round > 3) return null;
  if (state.effects.lockLow) return 1;
  if (state.effects.lockHigh) return state.players.length;
  return null;
}

const takeChip: ActionDef<GangState> = {
  allowedIn: ['draft'],
  schema: z.object({ star: z.number().int().min(1).max(6) }),
  validate(state, action, ctx) {
    const { star } = action.payload as { star: number };
    if (star > state.players.length) return { ok: false, reason: 'chip.outOfRange' };
    if (!state.players.includes(ctx.playerId)) return { ok: false, reason: 'not.in.table' };

    const roundIndex = state.round - 1;
    const locked = lockedStar(state);
    const mine = state.chips[ctx.playerId]?.[roundIndex] ?? null;

    // 锁死的筹码：已经在自己手上就不能换掉，在别人手上就不能抢
    if (locked != null) {
      if (mine === locked && star !== locked) return { ok: false, reason: 'chip.locked' };
      const holder = state.players.find((player) => state.chips[player]?.[roundIndex] === locked);
      if (star === locked && holder != null && holder !== ctx.playerId) {
        return { ok: false, reason: 'chip.locked' };
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
        const locked = lockedStar(state);
        for (let star = 1; star <= state.players.length; star += 1) {
          if (taken.has(star)) continue;
          if (locked === star) continue;
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
        // 匆忙撤离：不发橙色筹码，翻第 4 张直接进河牌轮
        const card = state.deck.pop();
        if (card) state.community.push(card);
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
    },
  },

  heistEnd: {
    type: 'global',
    next: (state) => (state.finished ? 'finished' : 'heistResult'),
    onEnter(state, ctx) {
      if (state.last?.ok) state.vaults += 1;
      else state.alarms += 1;

      const over = state.vaults >= 3 || state.alarms >= state.alarmsToLose;
      if (over) {
        state.finished = true;
        // 合作局：不排名 → 平台不会记 Elo、也不会写战绩
        state.ranking = null;
        ctx.emit({
          type: 'log',
          key: 'thegang.gameEnd',
          args: {
            win: state.vaults >= 3,
            vaults: state.vaults,
            alarms: state.alarms,
            limit: state.alarmsToLose,
          },
        });
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

  if (state.mode !== 'advanced' && state.mode !== 'professional') return;

  // 专家卡只生效一次，用完回底部
  if (state.specialist != null) {
    state.stacks.specialist.push(state.specialist);
    state.specialist = null;
  }
  // 挑战卡同理；专业模式那张常驻的不退
  const perHeist = state.challenge.filter((id) => id !== state.permanent);
  for (const id of perHeist) state.stacks.challenge.push(id);
  state.challenge = state.permanent != null ? [state.permanent] : [];

  if (state.last?.ok) {
    const next = state.stacks.challenge.shift();
    if (next != null) state.challenge = [...state.challenge, next];
  } else if (state.mode === 'advanced') {
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
      rawMode === 'basic' || rawMode === 'professional' || rawMode === 'master'
        ? rawMode
        : 'advanced';

    const rng = seededRandom(seed);
    const fullChallenge = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
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
      alarmsToLose: mode === 'master' ? 2 : 3,
      mode,
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
      permanent: null,
      stacks: { challenge: [], specialist: [] },
      effects: effectsOf([]),
      blackoutRounds: [],
      redrawPlayer: null,
      guess: null,
      guessOk: null,
    };

    if (mode !== 'basic') {
      // 专业 / 大师模式把「快速通道」抽掉
      const pool = mode === 'advanced' ? [...fullChallenge] : fullChallenge.filter((id) => id !== 1);
      state.stacks.challenge = pool;
      state.stacks.specialist = mode === 'master' ? [] : [...fullChallenge];

      if (mode === 'professional') {
        state.permanent = pickRandom(pool, rng) ?? null;
        state.stacks.challenge = pool.filter((id) => id !== state.permanent);
        state.challenge = state.permanent != null ? [state.permanent] : [];
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
        alarmsToLose: state.alarmsToLose,
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
        permanent: state.permanent,
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
