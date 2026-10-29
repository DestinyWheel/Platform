/**
 * 平台插件契约（SDK）
 *
 * 设计要点：
 * 1. 状态是纯 JSON，可序列化、可落库、可回放。
 * 2. reducer 不接触 DB / socket / 时钟 / 随机数，一切外部能力由 ctx 注入。
 * 3. 插件唯一的"对外说话"方式是 emit(effect)，由宿主落实成日志、广播、计时器。
 */
import type { z } from 'zod';

export type PlayerId = string;

/** 所有游戏状态都必须带的基础字段，宿主靠它驱动状态机与计时器。 */
export interface BaseState {
  /** 座位顺序，[0] 先手 */
  players: PlayerId[];
  /** 当前玩家在 players 里的下标 */
  turn: number;
  /** 当前轮次，从 1 开始 */
  round: number;
  /** 当前状态机阶段名 */
  phase: string;
  finished: boolean;
  /** 终局排名，并列玩家放在同一子数组 */
  ranking: PlayerId[][] | null;
  /** 确定性随机的种子，随状态持久化 */
  rngSeed: number;
}

export interface GameManifest {
  /** 全局唯一，不可变 */
  id: string;
  name: string;
  version: string;
  /** 依赖的插件 API 版本范围（semver range） */
  apiVersion: string;
  players: { min: number; max: number };
  modes: ('realtime' | 'turnbased')[];
  tags: string[];
  estimatedMinutes: number;
}

/* ------------------------------------------------------------------ */
/* 副作用                                                              */
/* ------------------------------------------------------------------ */

export type Effect =
  /** 写进牌桌日志，客户端按 key 做 i18n */
  | { type: 'log'; key: string; args?: Record<string, unknown>; to?: 'all' | PlayerId[] }
  /** 站内提示，只发给某个人 */
  | { type: 'notify'; player: PlayerId; key: string; args?: Record<string, unknown> }
  /** 推动计时器（不填则由宿主按上桌顺序推导） */
  | { type: 'clock'; player: PlayerId; ms: number }
  | { type: 'sound'; key: string };

export interface LogEntry {
  seq: number;
  key: string;
  args?: Record<string, unknown>;
  to: 'all' | PlayerId[];
  at: number;
}

/* ------------------------------------------------------------------ */
/* 动作与状态机                                                        */
/* ------------------------------------------------------------------ */

export interface AnyAction {
  type: string;
  payload?: unknown;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * 动作上下文。reducer 通过它拿外部能力、上报副作用、触发状态跳转。
 * 注意：ctx 里没有 DB、没有 socket，这是可回放与可沙箱的前提。
 */
export interface ActionContext<S extends BaseState = BaseState> {
  /** 提交动作的人 */
  playerId: PlayerId;
  players: PlayerId[];
  /** 服务端时间（毫秒），插件禁止用 Date.now() */
  now: number;
  /** 确定性随机，种子来自 state.rngSeed */
  rng(): number;
  emit(effect: Effect): void;
  /** 显式跳转到某个阶段；不调用则按当前阶段的 next 规则走 */
  goTo(phase: string): void;
  /** 只读引用，方便插件内部判定（不要改写它，改写 state 本身） */
  state: S;
}

export interface ActionDef<S extends BaseState = BaseState> {
  /** 只在这些阶段允许执行 */
  allowedIn: string[];
  /** 入参运行时校验 */
  schema: z.ZodTypeAny;
  /** 权威合法性判定。返回 false 的 reason 会原样回给客户端 */
  validate?(state: S, action: AnyAction, ctx: ActionContext<S>): ValidationResult;
  /** 纯逻辑：直接改 state（引擎已克隆，无需手写不可变更新） */
  reduce(state: S, action: AnyAction, ctx: ActionContext<S>): void;
}

export interface StateDef<S extends BaseState = BaseState> {
  type: 'private' | 'global' | 'activePlayer';
  /**
   * 进入本阶段后自动去的下一阶段。不填 = 停下来等待输入。
   * 用于 roundEnd / resolve 这类"过渡态"。
   */
  next?: string | ((state: S) => string);
  /** 进入本阶段时触发（可以修改 state） */
  onEnter?(state: S, ctx: ActionContext<S>): void;
  /** 超时兜底：必须返回一个合法动作，null 表示无法兜底 */
  onTimeout?(state: S, ctx: ActionContext<S>): AnyAction | null;
}

export interface SetupContext {
  players: PlayerId[];
  options: Record<string, unknown>;
  seed: number;
  now: number;
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

/**
 * 交给客户端的视图。隐藏信息只能在这里裁剪 —— 客户端永远拿不到完整 state。
 */
export interface PublicView {
  phase: string;
  players: PlayerId[];
  turn: PlayerId | null;
  round: number;
  finished: boolean;
  ranking: PlayerId[][] | null;
  /** 游戏自定义的公开数据 */
  data: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

export type BotLevel = 'easy' | 'normal' | 'hard';

/**
 * 人机能看到的东西。
 *
 * 注意只有 `view`（裁剪后的视图），没有完整 state —— 这样以后加难度也不会变成"靠偷看对手手牌变强"。
 */
export interface BotContext {
  view: PublicView;
  me: PlayerId;
  /** 我当前能做的所有具体动作 */
  legal: AnyAction[];
  level: BotLevel;
  rng: () => number;
}

export interface BotPolicy {
  id: string;
  name: string;
  /** 返回 null 表示放弃，交给平台兜底（随机挑一个合法动作） */
  choose(context: BotContext): AnyAction | null;
}

export interface GamePlugin<S extends BaseState = BaseState> {
  manifest: GameManifest;
  /** 建局。必须纯：随机数用 seed 自己算，时间用 now */
  createState(ctx: SetupContext): S;
  states: Record<string, StateDef<S>>;
  actions: Record<string, ActionDef<S>>;
  view(state: S, viewer: PlayerId | 'spectator'): PublicView;
  /**
   * 枚举**具体**可执行动作（带参数）。
   *
   * 相比 legalActions 只给类型，这个能告诉 UI "第 3 张手牌可以打到曼荼罗 2 的高山"。
   * 也是人机的入口。
   */
  legalMoves?(state: S, playerId: PlayerId): AnyAction[];
  /** 可选的人机策略。不写就只有平台兜底的随机策略 */
  bots?: BotPolicy[];
}

/* ------------------------------------------------------------------ */
/* 线上协议（前后端共用）                                              */
/* ------------------------------------------------------------------ */

export interface TablePlayerInfo {
  id: PlayerId;
  name: string;
  seat: number;
  bot: boolean;
}

export interface ChatMessage {
  id: number;
  userId: PlayerId;
  name: string;
  body: string;
  at: number;
}

/* ---------------------- 回放 / 战绩 / 排名 ---------------------- */

export interface ReplayStep {
  seq: number;
  kind: string;
  actor: PlayerId | null;
  /** 该步的观战者视角 */
  view: PublicView;
  /** 截至该步的日志（截取最近若干条） */
  log: LogEntry[];
}

export interface ReplayPayload {
  tableId: string;
  gameId: string;
  gameName: string;
  gameVersion: string;
  status: TableStatus;
  players: TablePlayerInfo[];
  steps: ReplayStep[];
  truncated: boolean;
}

export interface LeaderboardEntry {
  userId: PlayerId;
  name: string;
  rating: number;
  games: number;
}

export interface PlayerStatsRow {
  gameId: string;
  gameName: string;
  games: number;
  wins: number;
}

export interface RecentMatchRow {
  tableId: string;
  gameId: string;
  gameName: string;
  rank: number;
  players: number;
  isWin: boolean;
  finishedAt: number;
}

export type TableStatus = 'lobby' | 'playing' | 'finished';

export interface TableSnapshot {
  tableId: string;
  gameId: string;
  gameName: string;
  gameVersion: string;
  status: TableStatus;
  seq: number;
  hostId: PlayerId;
  minPlayers: number;
  maxPlayers: number;
  options: Record<string, unknown>;
  players: TablePlayerInfo[];
  you: { id: PlayerId; isPlayer: boolean; isHost: boolean };
  /** 未开局时为 null */
  view: PublicView | null;
  /** 当前你有哪些动作可用（UI 提示用，非权威） */
  legal: string[];
  /** 具体可执行动作（带参数），UI 靠它做高亮 */
  legalMoves: AnyAction[];
  activePlayer: PlayerId | null;
  deadlineAt: number | null;
  log: LogEntry[];
  /** 最近若干条聊天 */
  chat: ChatMessage[];
  /** 当前有多少人在看这张桌（含玩家） */
  viewers: number;
}

export interface TableSummary {
  id: string;
  gameId: string;
  gameName: string;
  status: TableStatus;
  players: number;
  maxPlayers: number;
  hostName: string;
  createdAt: number;
}

export type ClientMessage =
  | { t: 'subscribe'; tableId: string }
  | { t: 'unsubscribe'; tableId: string }
  | { t: 'action'; tableId: string; type: string; payload?: unknown }
  | { t: 'chat'; tableId: string; text: string }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'snapshot'; snapshot: TableSnapshot }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong' };

export interface AuthUser {
  id: PlayerId;
  name: string;
  /** 管理员才有的管理端入口（插件上传、指标、备份） */
  isAdmin?: boolean;
}

/* 前端插件契约（框架无关的 mount / update / unmount） */
export type {
  ClientPlayer,
  ClientSnapshot,
  GameClient,
  GameClientContext,
} from './client.js';
