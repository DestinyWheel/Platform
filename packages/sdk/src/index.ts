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

/**
 * 插件声明的一个可选扩展模块。
 *
 * 同一个扩展品牌的不同玩法（例如马赛克水晶的两面玩家板）可以拆成多个
 * id、用相同的 `group` 标记互斥；平台不关心内容，只负责选择和隔离 Elo。
 */
export interface GameExpansionDef {
  /** 插件内唯一，小写字母/数字/连字符 */
  id: string;
  name: string;
  description?: string;
  /** 同组扩展互斥；不填表示可以任意组合 */
  group?: string;
}

/** 快照里给客户端看的扩展信息（manifest 声明 + 本桌实际选择） */
export interface SelectedExpansionInfo {
  id: string;
  name: string;
  description?: string;
  group?: string;
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
  /** 一句话简介：大厅卡片上显示，没有就只显示人数和时长 */
  description?: string;
  /**
   * 详情页的游戏介绍。纯文本，空行分段；
   * 以 "- " 开头的连续行渲染成条目。
   */
  intro?: string;
  /**
   * 这一版的更新内容（给人看的一两句话）。
   *
   * 玩家第一次进到跑这个版本的牌桌时会强制看一次——所以这里写的是
   * "玩家需要知道的变化"，不是 changelog。
   */
  notes?: string[];
  /**
   * 即时制每步的时间限制（秒）。插件自己定，因为不同游戏一步的思考量差很多。
   * 不填就用平台默认：快 20 / 中 45 / 慢 90。除此之外还有一个「无限」档，
   * 不自动替人走，那种桌按友谊赛处理（不计分）。
   */
  realtime?: { fast: number; normal: number; slow: number };
  /**
   * 开桌时可以选的对局设置。选中值会原样进 createState(options)，
   * 默认值就是建桌时没传时的值。
   */
  options?: {
    key: string;
    label: string;
    choices: { value: string; label: string; hint?: string }[];
    default: string;
  }[];
  /**
   * 可选扩展模块。开桌时由房主选择，选中的 id 通过 createState 的
   * `expansions` 传给插件；不同组合的 Elo 分开计算。
   */
  expansions?: GameExpansionDef[];
  /** 牌桌界面上想改的地方：比如这个游戏的日志没用，就别占一列 */
  ui?: {
    /** 隐藏右侧「对局日志」（聊天还在） */
    hideLog?: boolean;
  };
  /**
   * 这个游戏要不要 Elo 和排行榜，默认 `true`。
   *
   * 合作游戏没有「谁赢」，五个人一起赢或者一起输，名次本身说不清 —— 这种游戏写
   * `false`，平台就不再给它算分：
   * - 大厅的「排行榜（Elo）」里选不到它
   * - 详情页没有「排行榜」标签页（只剩介绍）
   * - 结算时不动任何人的分数
   *
   * 插件在终局 `ranking` 里报了名次的话，战绩和回放照记，只是没有分数。
   */
  elo?: boolean;
  /**
   * 这个游戏的成就。**定义权和外观都归插件**：平台只存「谁解锁了哪个 id」，
   * 名字、说明、徽章长什么样都从这份声明里读。
   *
   * 解锁方式：在动作里 `ctx.emit({ type: 'achievement', player, key })`。
   */
  achievements?: AchievementDef[];
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
  | { type: 'sound'; key: string }
  /**
   * 解锁成就。`key` 必须是 manifest.achievements 里声明过的 id；
   * 平台去重（同一人同一成就只记一次），并给那个人发一条提醒。
   */
  | { type: 'achievement'; player: PlayerId; key: string };

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
  /**
   * 本桌选中的扩展 id，按 manifest 声明顺序排列；不选就是空数组。
   * 老插件可以忽略。
   */
  expansions?: string[];
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
  /** 中途认负：还在名单里，但这一局对他而言已经结束 */
  forfeited?: boolean;
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
  /** 本局实际使用的扩展；没有就是空数组 */
  expansions: SelectedExpansionInfo[];
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

/** 一个游戏已经产生过 Elo 的范围：本体 + 各扩展组合 */
export interface RatingScopeInfo {
  /** 分榜键；本体为空串 */
  value: string;
  /** 展示名；本体为「本体」 */
  label: string;
  /** 这个榜上的总场次（按 ratings.games 之和） */
  games: number;
}

/* ------------------------- 用户 / 社交 ------------------------- */

/**
 * 一个人有两样东西：
 *
 * - `account`：账户，全局唯一、不可改，**登录用它**
 * - `name`：昵称，随便改、可以重名，界面上显示的是它
 */
export interface UserCard {
  id: PlayerId;
  /** 账户（登录名），全局唯一 */
  account: string;
  /** 昵称，可以重复 */
  name: string;
  /** 头像：`preset:<id>` / `upload:<id>` / null（按 id 稳定挑一个） */
  avatar: string | null;
}

/** 邀请消息里那张桌：够画一张卡片，也够拼出邀请链接 */
export interface DirectInvite {
  tableId: string;
  /** 房间号；没有码的老桌是 null，靠 tableId 进 */
  code: string | null;
  gameId: string;
  gameName: string;
}

export interface DirectMessage {
  id: string;
  from: PlayerId;
  to: PlayerId;
  body: string;
  at: number;
  /** 对方读过的时间；null = 还没读 */
  readAt: number | null;
  /** 'invite' = 叫你打一局，前端画成卡片；老消息没这个字段，按 text 处理 */
  kind?: 'text' | 'invite';
  /** 点开跳哪儿，形如 `#/join/ABC234` */
  link?: string | null;
  invite?: DirectInvite | null;
}

/** 会话列表里的一行（按对方聚合，不按消息） */
export interface DirectThread {
  user: UserCard;
  last: DirectMessage | null;
  unread: number;
  /** 我们之间有一方拉黑了对方 */
  blocked: boolean;
}

export interface FollowGroup {
  id: string;
  name: string;
  sort: number;
}

export interface FollowedUser extends UserCard {
  groupId: string | null;
  /** 特别关注：列表置顶、消息提醒不被折叠 */
  special: boolean;
  at: number;
}

export interface SocialOverview {
  groups: FollowGroup[];
  following: FollowedUser[];
  followers: (UserCard & { at: number })[];
  blocked: UserCard[];
}

/** 首页铃铛上的数字 */
export interface SocialPulse {
  /** 未读私聊条数 */
  unreadDms: number;
  /** 未读的提醒（@提及 / 新粉丝 / 订阅 / 成就） */
  unreadNotifications: number;
  total: number;
}

/* ------------------------- 提醒 / 订阅 ------------------------- */

export type NotificationKind = 'mention' | 'follow' | 'subscribe' | 'achievement' | 'system';

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** 点开跳哪儿，形如 `#/table/xxx`；空就不跳 */
  link: string | null;
  at: number;
  readAt: number | null;
}

/** 订阅：某个游戏开桌、或者某个人开桌时提醒我 */
export interface Subscription {
  kind: 'game' | 'user';
  target: string;
  /** 给人看的名字（游戏名 / 昵称） */
  label: string;
  at: number;
}

export interface UserProfile extends UserCard {
  createdAt: number;
  signature: string | null;
  stats: PlayerStatsRow[];
  achievements: UnlockedAchievement[];
  following: boolean;
  followedBy: boolean;
  /** 关注时他所在的（我的）分组 */
  groupId: string | null;
  /** 我给他标的特别关注 */
  special: boolean;
  /** 我拉黑了他 */
  blocked: boolean;
  /** 他拉黑了我 */
  blocksMe: boolean;
  followerCount: number;
  followingCount: number;
}

/* ------------------------- 成就 ------------------------- */

/**
 * 成就由**游戏插件**定义，平台只负责记「谁在什么时候解锁了哪一个」。
 *
 * 徽章长什么样也归插件：给一个 emoji + 一个颜色，平台照着画。
 * 这样加新成就只要发个新版插件，不用动平台代码。
 */
export interface AchievementDef {
  /** 插件内唯一，比如 `first-win` */
  id: string;
  name: string;
  description: string;
  /** 徽章上的字：一个 emoji 最好认 */
  icon: string;
  /** 徽章底色，十六进制；不填用平台默认 */
  color?: string;
  /** 隐藏成就：没解锁时不显示名字，只显示「？？？」 */
  secret?: boolean;
}

export interface UnlockedAchievement {
  gameId: string;
  gameName: string;
  def: AchievementDef;
  /** 解锁时间 */
  at: number;
  /** 在哪张桌解锁的，可以点回去看回放 */
  tableId: string | null;
}

/** 最近一起玩过的人（大厅开桌时一键邀请用） */
export interface RecentPlayer extends UserCard {
  /** 最近一次同桌的时间 */
  at: number;
  /** 一起打过几局 */
  games: number;
}

/** 管理端：某个游戏的完整榜单（含被隐藏的） */
export interface AdminRatingRow {
  userId: PlayerId;
  name: string;
  account: string;
  rating: number;
  games: number;
  hidden: boolean;
}

export interface PlayerStatsRow {
  gameId: string;
  gameName: string;
  /** 本体为空串，扩展组合为 `id+id`；与 Elo 分榜键一致 */
  ratingScope: string;
  /** 展示用：本体 / 扩展名称组合 */
  ratingLabel: string;
  games: number;
  wins: number;
}

export interface RecentMatchRow {
  tableId: string;
  gameId: string;
  gameName: string;
  ratingScope: string;
  ratingLabel: string;
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
  /** 6 位房间码，念给朋友听的；老桌可能没有 */
  code: string | null;
  status: TableStatus;
  seq: number;
  hostId: PlayerId;
  minPlayers: number;
  maxPlayers: number;
  options: Record<string, unknown>;
  /** 本桌实际选中的扩展（已按 manifest 解析成名称） */
  expansions: SelectedExpansionInfo[];
  /** Elo 分榜键：本体为空串，扩展组合为 `id+id` */
  ratingScope: string;
  /** 展示用：本体 / 扩展名称组合 */
  ratingLabel: string;
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
  /** 这张桌的节奏：即时 / 回合制 */
  mode: TableMode;
  pace: string;
  /** 友谊赛（无限时长档）：不计 Elo、不记战绩 */
  friendly: boolean;
  /** 连续超时次数，满 3 次判负 */
  timeoutStreak: number;
  /** 插件声明的界面偏好 */
  ui?: { hideLog?: boolean };
  log: LogEntry[];
  /** 最近若干条聊天 */
  chat: ChatMessage[];
  /** 当前有多少人在看这张桌（含玩家） */
  viewers: number;
  /**
   * 这个版本有更新公告、而你还不知道 → 强制读一次（前端弹窗）。
   * 已经读过、或者这一版没写 notes，就是 null。
   */
  notice: VersionNotice | null;
  /**
   * 本局使用了扩展、而你这个非房主玩家还没读过 → 在版本公告之后提示一次。
   * 没有扩展、已读、房主或观战者都是 null。
   */
  expansionNotice: ExpansionNotice | null;
}

export interface VersionNotice {
  gameId: string;
  gameName: string;
  version: string;
  notes: string[];
}

export interface ExpansionNotice {
  tableId: string;
  gameId: string;
  gameVersion: string;
  /** 扩展组合签名（= ratingScope），用于已读去重 */
  key: string;
  items: SelectedExpansionInfo[];
}

export type TableMode = 'realtime' | 'turnbased';

export interface TableSummary {
  id: string;
  gameId: string;
  gameName: string;
  code: string | null;
  status: TableStatus;
  players: number;
  maxPlayers: number;
  hostName: string;
  createdAt: number;
  expansions: SelectedExpansionInfo[];
  ratingScope: string;
  ratingLabel: string;
  /** 我在这张桌里的角色，用于「我的对局」列表 */
  mine?: 'host' | 'player' | 'spectator';
  mode: TableMode;
  /** 节奏档位：即时 fast|normal|slow|none；回合 24|12|8|4|2|1|2d|none */
  pace: string;
  /** 友谊赛：无限时长档不计分 */
  friendly: boolean;
  /** 下一步到期时间；null = 不限时 */
  deadlineAt: number | null;
  /** 现在轮到我动（回合制列表排序用） */
  myTurn: boolean;
}

/* ---------------- 管理端（只有管理员能拿到） ---------------- */

export interface AdminUserRow {
  id: PlayerId;
  /** 账户名（登录用） */
  account: string;
  /** 昵称（展示用） */
  name: string;
  avatar: string | null;
  isAdmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** false = 还没设过密码的老账号 */
  hasPassword: boolean;
  tokenVersion: number;
  games: number;
  wins: number;
}

export interface AdminPluginVersion {
  gameId: string;
  name: string;
  version: string;
  status: 'pending' | 'active' | 'retired' | 'failed' | 'disabled';
  hash: string;
  error: string | null;
  createdAt: number;
  activatedAt: number | null;
  /** 这个版本的 worker 现在是否在内存里 */
  loaded: boolean;
}

export interface AdminOverview {
  uptime: number;
  db: string;
  memory: { rss: number; heapUsed: number };
  /** 内存里活着的插件版本 */
  workers: string[];
  /** 还有进行中牌桌在用的版本（回收不会动它们） */
  inUse: string[];
  tables: Record<string, number>;
  users: { total: number; admins: number };
  versions: { total: number; active: number; failed: number };
  games: { id: string; name: string; version: string }[];
  limits: { ipBuckets: number };
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
  | { t: 'pong' }
  /** 有人私聊我：直接推到对方那条连接上 */
  | { t: 'dm'; message: DirectMessage }
  /** 关注 / 未读变化，前端拿它刷新铃铛 */
  | { t: 'social'; pulse: SocialPulse }
  /** 新的提醒（@提及 / 订阅 / 成就）：前端插一条并刷新铃铛 */
  | { t: 'notice'; notification: Notification };

export interface AuthUser {
  id: PlayerId;
  /** 账户：登录名，全局唯一、不可改 */
  account: string;
  /** 昵称：界面上显示的名字，可以重复、可以改 */
  name: string;
  /** 头像：`preset:<id>` / `upload:<id>` / null（按 id 稳定挑一个） */
  avatar: string | null;
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

/* 头像预设：前后端共用同一份 */
export { AVATAR_PRESETS, avatarOf, isPresetAvatar } from './avatar.js';
export type { AvatarPreset } from './avatar.js';
