import type {
  AdminOverview,
  AdminPluginVersion,
  AdminUserRow,
  AuthUser,
  GameManifest,
  LeaderboardEntry,
  PlayerStatsRow,
  RecentMatchRow,
  ReplayPayload,
  TableSnapshot,
  TableSummary,
} from '@platform/sdk';

const SESSION_KEY = 'platform.session';

export interface Session {
  token: string;
  user: AuthUser;
}

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

/** 带 code 的错误：前端要区分"密码错"和"这个账号还没设密码"等情形 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
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
    throw new ApiError(code, message, response.status);
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
  authConfig: () =>
    request<{ registration: 'open' | 'code'; allowClaim: boolean }>('/auth/config'),

  register: (input: { name: string; password: string; confirm: string; code?: string; remember?: boolean }) =>
    request<{ token: string; user: AuthUser }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (input: { name: string; password: string; remember?: boolean }) =>
    request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  claim: (input: { name: string; password: string; remember?: boolean }) =>
    request<{ token: string; user: AuthUser }>('/auth/claim', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  changePassword: (input: { oldPassword: string; newPassword: string }) =>
    request<{ token: string; user: AuthUser }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  games: () => request<{ games: GameManifest[] }>('/games'),

  tables: () => request<{ tables: TableSummary[] }>('/tables'),

  createTable: (input: { gameId: string; maxPlayers?: number; options?: Record<string, unknown> }) =>
    request<{ id: string }>('/tables', { method: 'POST', body: JSON.stringify(input) }),

  joinTable: (id: string) => request<{ ok: true }>(`/tables/${id}/join`, { method: 'POST' }),

  startTable: (id: string) => request<{ ok: true }>(`/tables/${id}/start`, { method: 'POST' }),

  snapshot: (id: string) => request<{ snapshot: TableSnapshot }>(`/tables/${id}`),

  replay: (id: string) => request<{ replay: ReplayPayload }>(`/tables/${id}/replay`),

  stats: () =>
    request<{ perGame: PlayerStatsRow[]; recent: RecentMatchRow[] }>('/stats/me'),

  leaderboard: (gameId: string) =>
    request<{ gameId: string; entries: LeaderboardEntry[] }>(
      `/leaderboard?gameId=${encodeURIComponent(gameId)}`,
    ),

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

  adminGc: () =>
    request<{ released: string[]; loaded: string[] }>('/admin/plugins/gc', { method: 'POST' }),

  adminRepublish: () =>
    request<{ games: string[] }>('/admin/plugins/republish', { method: 'POST' }),

  adminUsers: () => request<{ users: AdminUserRow[] }>('/admin/users'),

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
    request<{ file: string; bytes: number; counts: Record<string, number> }>('/admin/backup', {
      method: 'POST',
    }),
};
