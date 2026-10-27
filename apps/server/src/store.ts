/**
 * 存储层接口。
 *
 * M0 用内存实现把链路跑通；M1 换成 Postgres 实现时，只需要替换这个接口的实现，
 * service / ws / routes 一行都不用改 —— 这就是文档里说的"接缝"。
 */
import { randomUUID } from 'node:crypto';
import type { AuthUser, BaseState, LogEntry, TableStatus } from '@platform/sdk';

export interface UserRecord extends AuthUser {
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
  /** 单调递增，客户端用来丢弃过期快照 */
  seq: number;
  log: LogEntry[];
  deadlineAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Store {
  findOrCreateUser(name: string): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | undefined>;
  createTable(record: TableRecord): Promise<void>;
  getTable(id: string): Promise<TableRecord | undefined>;
  saveTable(record: TableRecord): Promise<void>;
  listTables(): Promise<TableRecord[]>;
}

export class MemoryStore implements Store {
  private users = new Map<string, UserRecord>();
  private userIdByName = new Map<string, string>();
  private tables = new Map<string, TableRecord>();

  async findOrCreateUser(name: string): Promise<UserRecord> {
    const existing = this.userIdByName.get(name);
    if (existing) {
      const user = this.users.get(existing);
      if (user) return user;
    }
    const user: UserRecord = { id: randomUUID(), name, createdAt: Date.now() };
    this.users.set(user.id, user);
    this.userIdByName.set(name, user.id);
    return user;
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    return this.users.get(id);
  }

  async createTable(record: TableRecord): Promise<void> {
    this.tables.set(record.id, record);
  }

  async getTable(id: string): Promise<TableRecord | undefined> {
    return this.tables.get(id);
  }

  async saveTable(record: TableRecord): Promise<void> {
    this.tables.set(record.id, record);
  }

  async listTables(): Promise<TableRecord[]> {
    return [...this.tables.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
