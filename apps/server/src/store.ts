import { randomUUID } from 'node:crypto';
import type { BaseState, ChatMessage, GameManifest, LogEntry, TableStatus } from '@platform/sdk';
import type { Db } from './db/types.js';

export interface UserRecord {
  id: string;
  name: string;
  createdAt: number;
  /** 第一个注册的人自动成为管理员（私人平台够用，M3 再加角色表） */
  isAdmin: boolean;
}

export interface TablePlayer {
  id: string;
  name: string;
  seat: number;
  bot: boolean;
}

export interface TableRecord {
  id: string;
  gameId: string;
  gameVersion: string;
  hostId: string;
  status: TableStatus;
  players: TablePlayer[];
  maxPlayers: number;
  options: Record<string, unknown>;
  state: BaseState | null;
  /** 单调递增。既是给客户端的版本号，也是 CAS 的期望值 */
  seq: number;
  log: LogEntry[];
  deadlineAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** 一次状态变化要落进 match_actions 的记录 */
export interface ActionLog {
  actor: string | null;
  kind: 'start' | 'action' | 'timeout';
  action: unknown;
  effects: unknown[];
  stateHash: string;
}

export interface TableWrite {
  /** 已经改好的完整记录；table.seq 必须是 expectedSeq + 1 */
  table: TableRecord;
  expectedSeq: number;
  log?: ActionLog;
}

export interface Store {
  findOrCreateUser(name: string): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | undefined>;
  countUsers(): Promise<number>;

  createTable(record: TableRecord): Promise<void>;
  getTable(id: string): Promise<TableRecord | undefined>;
  /**
   * 乐观并发写入：只有库里的 seq 仍等于 expectedSeq 时才成功。
   * 返回 false 表示被别人抢先改了，调用方应重新读取后重试。
   */
  updateTable(write: TableWrite): Promise<boolean>;
  listTables(): Promise<TableRecord[]>;
  /** 已到期需要代走的桌（只取 status='playing'） */
  listExpired(now: number): Promise<TableRecord[]>;

  /* ------------------------- 插件版本 ------------------------- */
  getGameVersion(gameId: string, version: string): Promise<GameVersionRecord | undefined>;
  listGameVersions(): Promise<GameVersionRecord[]>;
  /** 写入/更新一行版本记录；status 由激活流程单独维护，这里不动它 */
  upsertGameVersion(record: GameVersionRecord): Promise<void>;
  markVersionFailed(gameId: string, version: string, error: string): Promise<void>;
  /** 事务：把该游戏原 active 版本降级为 retired，再激活指定版本 */
  setActiveVersion(gameId: string, version: string): Promise<void>;

  /* ------------------------- 聊天 / 战绩 ------------------------- */
  listActions(tableId: string): Promise<ActionRow[]>;
  appendChat(tableId: string, userId: string, name: string, body: string, at: number): Promise<ChatMessage>;
  listChat(tableId: string, limit: number): Promise<ChatMessage[]>;
  /** 幂等：同一桌重复调用不会产生重复战绩 */
  saveMatchResults(
    tableId: string,
    gameId: string,
    rows: { userId: string; rank: number; players: number; isWin: boolean }[],
    finishedAt: number,
  ): Promise<void>;
  getUserStats(userId: string): Promise<{ gameId: string; games: number; wins: number }[]>;
  getRecentMatches(userId: string, limit: number): Promise<RecentMatch[]>;
  /** 这一桌是否已经结算过（防止重复计分） */
  hasMatchResults(tableId: string): Promise<boolean>;

  /* ------------------------- Elo ------------------------- */
  getRatings(
    gameId: string,
    userIds: string[],
  ): Promise<Map<string, { rating: number; games: number }>>;
  applyRatingDeltas(
    gameId: string,
    rows: { userId: string; rating: number; games: number }[],
    now: number,
  ): Promise<void>;
  listRatings(
    gameId: string,
    limit: number,
  ): Promise<{ userId: string; name: string; rating: number; games: number }[]>;
}

export interface ActionRow {
  seq: number;
  actor: string | null;
  kind: 'start' | 'action' | 'timeout';
  action: unknown;
  effects: unknown[];
  stateHash: string;
  createdAt: number;
}

export interface RecentMatch {
  tableId: string;
  gameId: string;
  rank: number;
  players: number;
  isWin: boolean;
  finishedAt: number;
}

export interface GameVersionRecord {
  gameId: string;
  version: string;
  apiVersion: string;
  manifest: GameManifest;
  dir: string;
  hash: string;
  status: 'pending' | 'active' | 'retired' | 'failed';
  error: string | null;
  createdAt: number;
  activatedAt: number | null;
}

interface TableRow {
  id: string;
  game_id: string;
  game_version: string;
  host_id: string;
  status: string;
  players: TablePlayer[];
  max_players: number;
  options: Record<string, unknown>;
  state: BaseState | null;
  seq: number;
  log: LogEntry[];
  deadline_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function toRecord(row: TableRow): TableRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    gameVersion: row.game_version,
    hostId: row.host_id,
    status: row.status as TableStatus,
    players: row.players,
    maxPlayers: Number(row.max_players),
    options: row.options ?? {},
    state: row.state,
    seq: Number(row.seq),
    log: row.log ?? [],
    deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}

export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  async findOrCreateUser(name: string): Promise<UserRecord> {
    // 第一个注册的人自动成为管理员
    const isFirst = (await this.countUsers()) === 0;

    // 同名并发登录时靠唯一索引兜底，冲突了就回读
    await this.db.execute(
      `INSERT INTO users (id, name, created_at, is_admin)
       VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`,
      [randomUUID(), name, Date.now(), isFirst],
    );

    const rows = await this.db.query<{ id: string; name: string; created_at: number; is_admin: boolean }>(
      'SELECT id, name, created_at, is_admin FROM users WHERE name = $1',
      [name],
    );
    const row = rows[0];
    if (!row) throw new Error(`无法创建用户：${name}`);
    return {
      id: row.id,
      name: row.name,
      createdAt: Number(row.created_at),
      isAdmin: Boolean(row.is_admin),
    };
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const rows = await this.db.query<{ id: string; name: string; created_at: number; is_admin: boolean }>(
      'SELECT id, name, created_at, is_admin FROM users WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row
      ? { id: row.id, name: row.name, createdAt: Number(row.created_at), isAdmin: Boolean(row.is_admin) }
      : undefined;
  }

  async countUsers(): Promise<number> {
    const rows = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    return Number(rows[0]?.n ?? 0);
  }

  async createTable(record: TableRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO tables
         (id, game_id, game_version, host_id, status, players, max_players, options,
          state, seq, log, deadline_at, created_at, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15)`,
      [
        record.id,
        record.gameId,
        record.gameVersion,
        record.hostId,
        record.status,
        JSON.stringify(record.players),
        record.maxPlayers,
        JSON.stringify(record.options),
        record.state === null ? null : JSON.stringify(record.state),
        record.seq,
        JSON.stringify(record.log),
        record.deadlineAt,
        record.createdAt,
        record.startedAt,
        record.finishedAt,
      ],
    );
  }

  async getTable(id: string): Promise<TableRecord | undefined> {
    const rows = await this.db.query<TableRow>('SELECT * FROM tables WHERE id = $1', [id]);
    const row = rows[0];
    return row ? toRecord(row) : undefined;
  }

  async updateTable(write: TableWrite): Promise<boolean> {
    const { table, expectedSeq, log } = write;

    return this.db.transaction(async (tx) => {
      const updated = await tx.query<{ seq: number }>(
        `UPDATE tables SET
           players = $1::jsonb, status = $2, state = $3::jsonb, seq = $4, log = $5::jsonb,
           deadline_at = $6, started_at = $7, finished_at = $8
         WHERE id = $9 AND seq = $10
         RETURNING seq`,
        [
          JSON.stringify(table.players),
          table.status,
          table.state === null ? null : JSON.stringify(table.state),
          table.seq,
          JSON.stringify(table.log),
          table.deadlineAt,
          table.startedAt,
          table.finishedAt,
          table.id,
          expectedSeq,
        ],
      );

      if (updated.length === 0) return false;

      if (log) {
        await tx.execute(
          `INSERT INTO match_actions (table_id, seq, actor, kind, action, effects, state_hash, created_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
          [
            table.id,
            table.seq,
            log.actor,
            log.kind,
            JSON.stringify(log.action ?? null),
            JSON.stringify(log.effects ?? []),
            log.stateHash,
            Date.now(),
          ],
        );
      }

      return true;
    });
  }

  async listTables(): Promise<TableRecord[]> {
    const rows = await this.db.query<TableRow>('SELECT * FROM tables ORDER BY created_at DESC');
    return rows.map(toRecord);
  }

  async listExpired(now: number): Promise<TableRecord[]> {
    const rows = await this.db.query<TableRow>(
      `SELECT * FROM tables
        WHERE status = 'playing' AND deadline_at IS NOT NULL AND deadline_at <= $1
        ORDER BY deadline_at ASC
        LIMIT 200`,
      [now],
    );
    return rows.map(toRecord);
  }

  /* ------------------------- 插件版本 ------------------------- */

  async getGameVersion(gameId: string, version: string): Promise<GameVersionRecord | undefined> {
    const rows = await this.db.query<GameVersionRow>(
      'SELECT * FROM game_versions WHERE game_id = $1 AND version = $2',
      [gameId, version],
    );
    const row = rows[0];
    return row ? toVersionRecord(row) : undefined;
  }

  async listGameVersions(): Promise<GameVersionRecord[]> {
    const rows = await this.db.query<GameVersionRow>(
      'SELECT * FROM game_versions ORDER BY game_id ASC, created_at DESC',
    );
    return rows.map(toVersionRecord);
  }

  async upsertGameVersion(record: GameVersionRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO game_versions
         (game_id, version, api_version, manifest, dir, hash, status, error, created_at, activated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (game_id, version) DO UPDATE SET
         api_version  = EXCLUDED.api_version,
         manifest     = EXCLUDED.manifest,
         dir          = EXCLUDED.dir,
         hash         = EXCLUDED.hash,
         error        = EXCLUDED.error,
         status       = CASE WHEN game_versions.status = 'active' THEN 'active' ELSE EXCLUDED.status END,
         activated_at = COALESCE(EXCLUDED.activated_at, game_versions.activated_at)`,
      [
        record.gameId,
        record.version,
        record.apiVersion,
        JSON.stringify(record.manifest),
        record.dir,
        record.hash,
        record.status,
        record.error,
        record.createdAt,
        record.activatedAt,
      ],
    );
  }

  async markVersionFailed(gameId: string, version: string, error: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO game_versions
         (game_id, version, api_version, manifest, dir, hash, status, error, created_at, activated_at)
       VALUES ($1,$2,'','{}'::jsonb,'','', 'failed', $3, $4, NULL)
       ON CONFLICT (game_id, version) DO UPDATE SET
         error  = EXCLUDED.error,
         status = CASE WHEN game_versions.status = 'active' THEN 'active' ELSE 'failed' END`,
      [gameId, version, error, Date.now()],
    );
  }

  async setActiveVersion(gameId: string, version: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE game_versions SET status = 'retired'
          WHERE game_id = $1 AND status = 'active' AND version <> $2`,
        [gameId, version],
      );
      await tx.execute(
        `UPDATE game_versions SET status = 'active', activated_at = $3
          WHERE game_id = $1 AND version = $2`,
        [gameId, version, Date.now()],
      );
    });
  }

  /* ------------------------- 聊天 / 战绩 ------------------------- */

  async listActions(tableId: string): Promise<ActionRow[]> {
    const rows = await this.db.query<{
      seq: number;
      actor: string | null;
      kind: 'start' | 'action' | 'timeout';
      action: unknown;
      effects: unknown[];
      state_hash: string;
      created_at: number;
    }>('SELECT * FROM match_actions WHERE table_id = $1 ORDER BY seq ASC', [tableId]);

    return rows.map((row) => ({
      seq: Number(row.seq),
      actor: row.actor,
      kind: row.kind,
      action: row.action,
      effects: row.effects,
      stateHash: row.state_hash,
      createdAt: Number(row.created_at),
    }));
  }

  async appendChat(
    tableId: string,
    userId: string,
    name: string,
    body: string,
    at: number,
  ): Promise<ChatMessage> {
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO table_chat (table_id, user_id, name, body, created_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tableId, userId, name, body, at],
    );
    return { id: Number(rows[0]?.id ?? 0), userId, name, body, at };
  }

  async listChat(tableId: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.db.query<{
      id: string;
      user_id: string;
      name: string;
      body: string;
      created_at: number;
    }>(
      `SELECT id, user_id, name, body, created_at FROM table_chat
        WHERE table_id = $1 ORDER BY id DESC LIMIT $2`,
      [tableId, limit],
    );

    return rows
      .map((row) => ({
        id: Number(row.id),
        userId: row.user_id,
        name: row.name,
        body: row.body,
        at: Number(row.created_at),
      }))
      .reverse();
  }

  async saveMatchResults(
    tableId: string,
    gameId: string,
    rows: { userId: string; rank: number; players: number; isWin: boolean }[],
    finishedAt: number,
  ): Promise<void> {
    for (const row of rows) {
      await this.db.execute(
        `INSERT INTO match_results (table_id, user_id, game_id, rank, players, is_win, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (table_id, user_id) DO NOTHING`,
        [tableId, row.userId, gameId, row.rank, row.players, row.isWin, finishedAt],
      );
    }
  }

  async getUserStats(userId: string): Promise<{ gameId: string; games: number; wins: number }[]> {
    const rows = await this.db.query<{ game_id: string; games: number; wins: number }>(
      `SELECT game_id,
              count(*)::int AS games,
              sum(CASE WHEN is_win THEN 1 ELSE 0 END)::int AS wins
         FROM match_results
        WHERE user_id = $1
        GROUP BY game_id
        ORDER BY games DESC`,
      [userId],
    );
    return rows.map((row) => ({
      gameId: row.game_id,
      games: Number(row.games),
      wins: Number(row.wins),
    }));
  }

  async getRecentMatches(userId: string, limit: number): Promise<RecentMatch[]> {
    const rows = await this.db.query<{
      table_id: string;
      game_id: string;
      rank: number;
      players: number;
      is_win: boolean;
      finished_at: number;
    }>(
      `SELECT table_id, game_id, rank, players, is_win, finished_at
         FROM match_results WHERE user_id = $1 ORDER BY finished_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((row) => ({
      tableId: row.table_id,
      gameId: row.game_id,
      rank: Number(row.rank),
      players: Number(row.players),
      isWin: Boolean(row.is_win),
      finishedAt: Number(row.finished_at),
    }));
  }

  async hasMatchResults(tableId: string): Promise<boolean> {
    const rows = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM match_results WHERE table_id = $1',
      [tableId],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /* ------------------------- Elo ------------------------- */

  async getRatings(
    gameId: string,
    userIds: string[],
  ): Promise<Map<string, { rating: number; games: number }>> {
    const result = new Map<string, { rating: number; games: number }>();
    if (userIds.length === 0) return result;

    const rows = await this.db.query<{ user_id: string; rating: number; games: number }>(
      'SELECT user_id, rating, games FROM ratings WHERE game_id = $1 AND user_id = ANY($2::text[])',
      [gameId, userIds],
    );
    for (const row of rows) {
      result.set(row.user_id, { rating: Number(row.rating), games: Number(row.games) });
    }
    return result;
  }

  async applyRatingDeltas(
    gameId: string,
    rows: { userId: string; rating: number; games: number }[],
    now: number,
  ): Promise<void> {
    for (const row of rows) {
      await this.db.execute(
        `INSERT INTO ratings (game_id, user_id, rating, games, updated_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (game_id, user_id) DO UPDATE SET
           rating = EXCLUDED.rating, games = EXCLUDED.games, updated_at = EXCLUDED.updated_at`,
        [gameId, row.userId, row.rating, row.games, now],
      );
    }
  }

  async listRatings(
    gameId: string,
    limit: number,
  ): Promise<{ userId: string; name: string; rating: number; games: number }[]> {
    const rows = await this.db.query<{
      user_id: string;
      name: string;
      rating: number;
      games: number;
    }>(
      `SELECT r.user_id, u.name, r.rating, r.games
         FROM ratings r JOIN users u ON u.id = r.user_id
        WHERE r.game_id = $1
        ORDER BY r.rating DESC, r.games DESC
        LIMIT $2`,
      [gameId, limit],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      rating: Number(row.rating),
      games: Number(row.games),
    }));
  }
}

interface GameVersionRow {
  game_id: string;
  version: string;
  api_version: string;
  manifest: GameManifest;
  dir: string;
  hash: string;
  status: string;
  error: string | null;
  created_at: number;
  activated_at: number | null;
}

function toVersionRecord(row: GameVersionRow): GameVersionRecord {
  return {
    gameId: row.game_id,
    version: row.version,
    apiVersion: row.api_version,
    manifest: row.manifest,
    dir: row.dir,
    hash: row.hash,
    status: row.status as GameVersionRecord['status'],
    error: row.error,
    createdAt: Number(row.created_at),
    activatedAt: row.activated_at === null ? null : Number(row.activated_at),
  };
}
