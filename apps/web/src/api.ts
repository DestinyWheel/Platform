import type {
  AdminOverview,
  AdminPluginVersion,
  AdminRatingRow,
  AdminUserRow,
  AuthUser,
  DirectMessage,
  DirectThread,
  FollowedUser,
  FollowGroup,
  GameManifest,
  LeaderboardEntry,
  Notification,
  PlayerStatsRow,
  RecentMatchRow,
  RecentPlayer,
  ReplayPayload,
  SocialOverview,
  SocialPulse,
  Subscription,
  TableSnapshot,
  TableSummary,
  UserCard,
  UserProfile,
} from '@platform/sdk';

const SESSION_KEY = 'platform.session';

export interface Session {
  token: string;
  user: AuthUser;
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

/**
 * 当前令牌。
 *
 * 这里踩过一个坑：令牌原本只在 App 的 useEffect 里设置，而 React 的副作用是
 * **子组件先跑、父组件后跑**。于是登录成功的同一次渲染里，Lobby 的挂载请求
 * （/tables/mine、/stats/me）比"设置令牌"那步先发出去，还没带 Authorization，
 * 服务端回 401，前端按"登录已过期"处理，人就被踢回登录页了。
 *
 * 所以令牌改成跟着会话走：模块加载时从 localStorage 读一次（刷新页面直接可用），
 * saveSession() 里同步更新（登录后立刻可用）。setAuthToken 留着给显式场景用。
 */
let authToken: string | null = readSession()?.token ?? null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function loadSession(): Session | null {
  return readSession();
}

export function saveSession(session: Session | null): void {
  authToken = session?.token ?? null;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

/** 带 code 的错误：前端要区分"密码错"和"这个账号还没设密码"等情形 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** 服务端附带的额外数据（比如重名时的候选人列表） */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;
/** 令牌过期/被作废时统一回调，省得每个页面各写一遍 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  // 只有带 body 时才声明 content-type，否则 Fastify 会因为"空 JSON body"直接报 400
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  const response = await fetch(`/api${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    if (response.status === 401) onUnauthorized?.();
    const code = (body as { code?: string }).code ?? 'http_error';
    const message = (body as { message?: string }).message ?? `请求失败 (${response.status})`;
    const details = (body as { details?: unknown }).details;
    throw new ApiError(code, message, response.status, details);
  }
  return body as T;
}

/** 二进制上传（插件 zip）；和 request 分开是因为不能塞 content-type: application/json */
async function sendBinary<T>(path: string, body: ArrayBuffer): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/zip' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  const response = await fetch(`/api${path}`, { method: 'POST', headers, body });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    if (response.status === 401) onUnauthorized?.();
    const code = (payload as { code?: string }).code ?? 'http_error';
    const message = (payload as { message?: string }).message ?? `上传失败 (${response.status})`;
    throw new ApiError(code, message, response.status);
  }
  return payload as T;
}

export const api = {
  /** 刷新当前用户（权限可能被管理员改过，本地存的可能过期了） */
  me: () => request<{ user: AuthUser }>('/me'),

  /** 用户中心：我的邀请码 + 我拉进来的人（code=null 表示还没生成） */
  myInvite: () =>
    request<{
      code: string | null;
      createdAt: number | null;
      invited: { id: string; account: string; name: string; createdAt: number }[];
    }>('/me/invite'),

  /** 生成我的邀请码，只能生成一次；已经有了服务端回 409 */
  generateInvite: () => request<{ code: string }>('/me/invite', { method: 'POST' }),

  register: (input: {
    account: string;
    /** 昵称选填，不填就用账户名 */
    name?: string;
    password: string;
    confirm: string;
    code?: string;
    remember?: boolean;
  }) =>
    request<{ token: string; user: AuthUser }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (input: { account: string; password: string; remember?: boolean }) =>
    request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  claim: (input: { account: string; password: string; remember?: boolean }) =>
    request<{ token: string; user: AuthUser }>('/auth/claim', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** 改昵称 / 头像 / 签名（账户不可改） */
  updateProfile: (input: {
    name?: string;
    signature?: string | null;
    avatar?: string | null;
  }) =>
    request<{ user: AuthUser }>('/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /** 上传头像（默认关闭；开了才有入口） */
  uploadAvatar: async (file: ArrayBuffer): Promise<{ user: AuthUser }> => {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const response = await fetch('/api/me/avatar', { method: 'POST', headers, body: file });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as { code?: string; message?: string }) : {};
    if (!response.ok) {
      throw new ApiError(
        payload.code ?? 'http_error',
        payload.message ?? `上传失败 (${response.status})`,
        response.status,
      );
    }
    return payload as { user: AuthUser };
  },

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  changePassword: (input: { oldPassword: string; newPassword: string }) =>
    request<{ token: string; user: AuthUser }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  games: () => request<{ games: GameManifest[] }>('/games'),

  tables: () => request<{ tables: TableSummary[] }>('/tables'),

  createTable: (input: {
    gameId: string;
    maxPlayers?: number;
    options?: Record<string, unknown>;
    mode?: 'realtime' | 'turnbased';
    pace?: string;
    /** 每日可行动时段，UTC 当天第几分钟 */
    windowStart?: number | null;
    windowEnd?: number | null;
  }) => request<{ id: string }>('/tables', { method: 'POST', body: JSON.stringify(input) }),

  joinTable: (id: string) => request<{ ok: true }>(`/tables/${id}/join`, { method: 'POST' }),

  /** 我参与的、还没结束的桌 */
  myTables: () => request<{ tables: TableSummary[] }>('/tables/mine'),

  /** 随机加入：没桌就现开一张，所以一定会给你一个牌桌 */
  quickMatch: (gameId?: string, settings?: {
    mode?: 'realtime' | 'turnbased';
    pace?: string;
    windowStart?: number | null;
    windowEnd?: number | null;
  }) =>
    request<{ id: string; created: boolean }>('/tables/quick-match', {
      method: 'POST',
      body: JSON.stringify({ ...(gameId ? { gameId } : {}), ...(settings ?? {}) }),
    }),

  joinByCode: (code: string) =>
    request<{ id: string }>('/tables/join-by-code', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  leaveTable: (id: string) => request<{ ok: true }>(`/tables/${id}/leave`, { method: 'POST' }),

  /** 已开局时退出 = 认负 */
  forfeitTable: (id: string) => request<{ ok: true }>(`/tables/${id}/forfeit`, { method: 'POST' }),

  rematch: (id: string) => request<{ id: string }>(`/tables/${id}/rematch`, { method: 'POST' }),

  /** 版本公告：读过了就不再弹 */
  ackNotice: (gameId: string, version: string) =>
    request<{ ok: true }>('/notices/ack', {
      method: 'POST',
      body: JSON.stringify({ gameId, version }),
    }),

  startTable: (id: string) => request<{ ok: true }>(`/tables/${id}/start`, { method: 'POST' }),

  snapshot: (id: string) => request<{ snapshot: TableSnapshot }>(`/tables/${id}`),

  replay: (id: string) => request<{ replay: ReplayPayload }>(`/tables/${id}/replay`),

  stats: () =>
    request<{ perGame: PlayerStatsRow[]; recent: RecentMatchRow[] }>('/stats/me'),

  leaderboard: (gameId: string) =>
    request<{ gameId: string; entries: LeaderboardEntry[] }>(
      `/leaderboard?gameId=${encodeURIComponent(gameId)}`,
    ),

  /* ------------------------------ 用户 / 社交 ------------------------------ */

  /** 按账户或昵称找人 */
  searchUsers: (query: string) =>
    request<{ users: UserCard[] }>(`/users/search?q=${encodeURIComponent(query)}`),

  userProfile: (id: string) => request<{ profile: UserProfile }>(`/users/${encodeURIComponent(id)}`),

  /** 首页铃铛：未读私聊 + 未读提醒 */
  pulse: () => request<{ pulse: SocialPulse }>('/social/pulse'),

  /** 打开消息页：把所有提醒标记成已读 */
  markSeen: () => request<{ pulse: SocialPulse }>('/social/seen', { method: 'POST' }),

  /* ------------------------------ 提醒 ------------------------------ */

  notifications: () =>
    request<{ notifications: Notification[]; pulse: SocialPulse }>('/notifications'),

  readNotifications: () =>
    request<{ pulse: SocialPulse }>('/notifications/read', { method: 'POST' }),

  /* ------------------------------ 订阅 ------------------------------ */

  subscriptions: () => request<{ subscriptions: Subscription[] }>('/subscriptions'),

  subscribe: (kind: 'game' | 'user', target: string) =>
    request<{ ok: true }>('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ kind, target }),
    }),

  unsubscribe: (kind: 'game' | 'user', target: string) =>
    request<{ ok: true }>(`/subscriptions/${kind}/${encodeURIComponent(target)}`, {
      method: 'DELETE',
    }),

  /** 最近一起玩过的人 */
  recentPlayers: () => request<{ players: RecentPlayer[] }>('/players/recent'),

  /** 邀请某人来这张桌：给他发一条带房间号的私聊 + 提醒 */
  inviteToTable: (tableId: string, userId: string) =>
    request<{ message: DirectMessage }>(`/tables/${encodeURIComponent(tableId)}/invite`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  socialOverview: () => request<SocialOverview>('/social/overview'),

  followUser: (userId: string, options: { groupId?: string | null; special?: boolean } = {}) =>
    request<{ following: FollowedUser }>('/social/follow', {
      method: 'POST',
      body: JSON.stringify({ userId, ...options }),
    }),

  unfollowUser: (userId: string) =>
    request<{ ok: true }>(`/social/follow/${encodeURIComponent(userId)}`, { method: 'DELETE' }),

  updateFollow: (userId: string, patch: { groupId?: string | null; special?: boolean }) =>
    request<{ following: FollowedUser }>(`/social/follow/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  createGroup: (name: string) =>
    request<{ group: FollowGroup }>('/social/groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  renameGroup: (id: string, name: string) =>
    request<{ ok: true }>(`/social/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteGroup: (id: string) =>
    request<{ ok: true }>(`/social/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  blockUser: (id: string) =>
    request<{ ok: true }>(`/social/block/${encodeURIComponent(id)}`, { method: 'POST' }),

  unblockUser: (id: string) =>
    request<{ ok: true }>(`/social/block/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ------------------------------ 私聊 ------------------------------ */

  dmThreads: () => request<{ threads: DirectThread[]; pulse: SocialPulse }>('/dm'),

  /** 打开某个会话：顺带把对方发来的消息标成已读 */
  dmMessages: (userId: string) =>
    request<{ user: UserCard; messages: DirectMessage[] }>(`/dm/${encodeURIComponent(userId)}`),

  sendDm: (userId: string, body: string) =>
    request<{ message: DirectMessage }>(`/dm/${encodeURIComponent(userId)}`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  /* ------------------------------ 管理端 ------------------------------ */

  adminOverview: () => request<AdminOverview>('/admin/overview'),

  adminPlugins: () =>
    request<{ versions: AdminPluginVersion[]; loaded: string[]; inUse: string[] }>('/admin/plugins'),

  /** 插件包直接当请求体发，省掉 multipart */
  adminUpload: (file: ArrayBuffer) =>
    sendBinary<{ gameId: string; version: string; status: string }>('/admin/plugins', file),

  adminActivate: (gameId: string, version: string) =>
    request<{ ok: true; activatedAt: number }>(
      `/admin/plugins/${encodeURIComponent(gameId)}/${encodeURIComponent(version)}/activate`,
      { method: 'POST' },
    ),

  /** 禁用：大厅下架、不能开新房；进行中的牌桌照常打完 */
  adminDisable: (gameId: string, version: string) =>
    request<{ ok: true; released: string[]; loaded: string[] }>(
      `/admin/plugins/${encodeURIComponent(gameId)}/${encodeURIComponent(version)}/disable`,
      { method: 'POST' },
    ),

  adminGc: () =>
    request<{ released: string[]; loaded: string[] }>('/admin/plugins/gc', { method: 'POST' }),

  adminRepublish: () =>
    request<{ games: string[] }>('/admin/plugins/republish', { method: 'POST' }),

  adminUsers: () => request<{ users: AdminUserRow[] }>('/admin/users'),

  /** 某个游戏的完整榜单（含被隐藏的人） */
  adminRatings: (gameId: string) =>
    request<{ gameId: string; rows: AdminRatingRow[] }>(
      `/admin/ratings?gameId=${encodeURIComponent(gameId)}`,
    ),

  adminHideRating: (gameId: string, userId: string, hidden: boolean) =>
    request<{ ok: true }>('/admin/ratings/hide', {
      method: 'POST',
      body: JSON.stringify({ gameId, userId, hidden }),
    }),

  adminSetAdmin: (id: string, isAdmin: boolean) =>
    request<{ ok: true }>(`/admin/users/${encodeURIComponent(id)}/admin`, {
      method: 'POST',
      body: JSON.stringify({ isAdmin }),
    }),

  /** 不传 password 就让服务端生成一个临时口令，返回值只出现这一次 */
  adminResetPassword: (id: string, password?: string) =>
    request<{ ok: true; password: string }>(`/admin/users/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
    }),

  adminBackup: () =>
    request<{ file: string; bytes: number; pruned: string[]; counts: Record<string, number> }>(
      '/admin/backup',
      { method: 'POST' },
    ),

  adminBackups: () =>
    request<{
      keep: number;
      bytes: number;
      files: { name: string; bytes: number; createdAt: number }[];
    }>('/admin/backups'),
};
