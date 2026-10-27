import { randomUUID } from 'node:crypto';
import type { BaseState, LogEntry, TableStatus } from '@platform/sdk';
import type { Db } from './db/types.js';

export interface UserRecord {
  id: string;
  name: string;
  createdAt: number;
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
    // 同名并发登录时靠唯一索引兜底，冲突了就回读
    await this.db.execute(
      'INSERT INTO users (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
      [randomUUID(), name, Date.now()],
    );
    const rows = await this.db.query<{ id: string; name: string; created_at: number }>(
      'SELECT id, name, created_at FROM users WHERE name = $1',
      [name],
    );
    const row = rows[0];
    if (!row) throw new Error(`无法创建用户：${name}`);
    return { id: row.id, name: row.name, createdAt: Number(row.created_at) };
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const rows = await this.db.query<{ id: string; name: string; created_at: number }>(
      'SELECT id, name, created_at FROM users WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, createdAt: Number(row.created_at) } : undefined;
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
}
