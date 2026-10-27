import type { AuthUser, GameManifest, TableSnapshot, TableSummary } from '@platform/sdk';

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  // 只有带 body 时才声明 content-type，否则 Fastify 会因为"空 JSON body"直接报 400
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  const response = await fetch(`/api${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const message = (body as { message?: string }).message ?? `请求失败 (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  login: (name: string) =>
    request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  games: () => request<{ games: GameManifest[] }>('/games'),

  tables: () => request<{ tables: TableSummary[] }>('/tables'),

  createTable: (input: { gameId: string; maxPlayers?: number; options?: Record<string, unknown> }) =>
    request<{ id: string }>('/tables', { method: 'POST', body: JSON.stringify(input) }),

  joinTable: (id: string) => request<{ ok: true }>(`/tables/${id}/join`, { method: 'POST' }),

  startTable: (id: string) => request<{ ok: true }>(`/tables/${id}/start`, { method: 'POST' }),

  snapshot: (id: string) => request<{ snapshot: TableSnapshot }>(`/tables/${id}`),
};
