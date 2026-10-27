/**
 * 示例插件：骰子对决
 *
 * 规则：2–4 人，共 N 轮，每轮每人掷一次 d6，累计点数最高者胜。
 * 用途：把「状态机 + 纯 reducer + 超时兜底 + 终局排名」这条链路跑通，
 * 后续真游戏的写法与之完全一致。
 */
import { z } from 'zod';
import type {
  ActionDef,
  BaseState,
  GamePlugin,
  PlayerId,
  PublicView,
  StateDef,
} from '@platform/sdk';

export interface DiceState extends BaseState {
  /** 累计点数 */
  scores: Record<PlayerId, number>;
  /** 本轮每人掷出的点数，null 表示还没掷 */
  roundRolls: Record<PlayerId, number | null>;
  rounds: number;
  last: { player: PlayerId; value: number } | null;
}

function zeroed<T>(players: PlayerId[], value: T): Record<PlayerId, T> {
  return Object.fromEntries(players.map((p) => [p, value])) as Record<PlayerId, T>;
}

/** 按累计点数从高到低分组，同分并列 */
function computeRanking(scores: Record<PlayerId, number>, players: PlayerId[]): PlayerId[][] {
  const sorted = [...players].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const groups: PlayerId[][] = [];
  let lastScore: number | null = null;

  for (const player of sorted) {
    const score = scores[player] ?? 0;
    if (lastScore !== null && score === lastScore) {
      groups[groups.length - 1]!.push(player);
    } else {
      groups.push([player]);
      lastScore = score;
    }
  }
  return groups;
}

const roll: ActionDef<DiceState> = {
  allowedIn: ['roll'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (state.players[state.turn] !== ctx.playerId) {
      return { ok: false, reason: 'not.your.turn' };
    }
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    const who = state.players[state.turn]!;
    const value = 1 + Math.floor(ctx.rng() * 6);

    state.scores[who] = (state.scores[who] ?? 0) + value;
    state.roundRolls[who] = value;
    state.last = { player: who, value };

    ctx.emit({ type: 'log', key: 'dice.roll', args: { player: who, value } });
    ctx.emit({ type: 'sound', key: 'dice.roll' });

    const allRolled = state.players.every((p) => state.roundRolls[p] !== null);
    if (allRolled) {
      ctx.goTo('roundEnd');
      return;
    }
    state.turn += 1;
  },
};

const states: Record<string, StateDef<DiceState>> = {
  roll: {
    type: 'activePlayer',
    onTimeout(state, ctx) {
      // 超时自动替当前玩家掷一次
      return { type: 'roll', payload: {} };
    },
  },

  roundEnd: {
    type: 'global',
    next: (state) => (state.finished ? 'finished' : 'roll'),
    onEnter(state, ctx) {
      ctx.emit({
        type: 'log',
        key: 'dice.roundEnd',
        args: { round: state.round, rolls: { ...state.roundRolls }, scores: { ...state.scores } },
      });

      state.round += 1;
      state.roundRolls = zeroed(state.players, null);
      state.turn = 0;

      if (state.round > state.rounds) {
        state.finished = true;
        state.ranking = computeRanking(state.scores, state.players);
        ctx.emit({
          type: 'log',
          key: 'dice.gameEnd',
          args: { ranking: state.ranking, scores: { ...state.scores } },
        });
      }
    },
  },

  finished: {
    type: 'global',
  },
};

const dice: GamePlugin<DiceState> = {
  manifest: {
    id: 'dice',
    name: '骰子对决',
    version: '0.1.0',
    apiVersion: '^1.0.0',
    players: { min: 2, max: 4 },
    modes: ['turnbased'],
    tags: ['示例', '运气'],
    estimatedMinutes: 3,
  },

  createState({ players, options, seed }) {
    const rawRounds = options.rounds;
    const rounds = typeof rawRounds === 'number' && rawRounds >= 1 && rawRounds <= 10 ? rawRounds : 3;

    return {
      players: [...players],
      turn: 0,
      round: 1,
      phase: 'roll',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      scores: zeroed(players, 0),
      roundRolls: zeroed(players, null),
      rounds,
      last: null,
    };
  },

  states,
  actions: { roll },

  view(state, _viewer): PublicView {
    return {
      phase: state.phase,
      players: state.players,
      turn: state.finished ? null : (state.players[state.turn] ?? null),
      round: Math.min(state.round, state.rounds),
      finished: state.finished,
      ranking: state.ranking,
      data: {
        scores: state.scores,
        roundRolls: state.roundRolls,
        rounds: state.rounds,
        last: state.last,
      },
    };
  },
};

export default dice;
export { dice };
