import { randomUUID } from 'node:crypto';
import type {
  Effect,
  GamePlugin,
  LogEntry,
  PublicView,
  TableSnapshot,
  TableSummary,
} from '@platform/sdk';
import {
  activePlayerOf,
  applyAction,
  applyTimeout,
  createInitialState,
  legalActions,
  RuleError,
} from '@platform/engine';
import type { EventBus } from './bus.js';
import type { GameRegistry } from './games.js';
import type { Store, TableRecord, UserRecord } from './store.js';

const DEFAULT_TURN_MS = 30_000;
const MAX_LOG = 200;

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** 同一张桌的写操作串行化（内存锁；多实例时换成 DB CAS） */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface CreateTableInput {
  gameId: string;
  maxPlayers?: number;
  options?: Record<string, unknown>;
}

export class TableService {
  private locks = new Map<string, Mutex>();

  constructor(
    private readonly store: Store,
    private readonly games: GameRegistry,
    private readonly bus: EventBus,
  ) {}

  private lock(tableId: string): Mutex {
    let mutex = this.locks.get(tableId);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(tableId, mutex);
    }
    return mutex;
  }

  private pluginOf(table: TableRecord): GamePlugin<any> {
    const plugin = this.games.get(table.gameId);
    if (!plugin) throw new ServiceError('unknown_game', `游戏未注册：${table.gameId}`);
    return plugin;
  }

  /* ---------------------------------------------------------------- */
  /* 建桌 / 加入 / 开局                                                 */
  /* ---------------------------------------------------------------- */

  async createTable(user: UserRecord, input: CreateTableInput): Promise<string> {
    const plugin = this.games.get(input.gameId);
    if (!plugin) throw new ServiceError('unknown_game', `没有这个游戏：${input.gameId}`);

    const { min, max } = plugin.manifest.players;
    const requested = input.maxPlayers ?? max;
    const maxPlayers = Math.max(min, Math.min(max, Math.trunc(requested)));

    const now = Date.now();
    const record: TableRecord = {
      id: randomUUID(),
      gameId: plugin.manifest.id,
      gameVersion: plugin.manifest.version,
      hostId: user.id,
      status: 'lobby',
      players: [{ id: user.id, name: user.name, seat: 0, bot: false }],
      maxPlayers,
      options: input.options ?? {},
      state: null,
      seq: 0,
      log: [],
      deadlineAt: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };

    await this.store.createTable(record);
    return record.id;
  }

  async joinTable(tableId: string, user: UserRecord): Promise<void> {
    await this.lock(tableId).run(async () => {
      const table = await this.store.getTable(tableId);
      if (!table) throw new ServiceError('no_table', '牌桌不存在');
      if (table.players.some((p) => p.id === user.id)) return;
      if (table.status !== 'lobby') throw new ServiceError('already_started', '对局已经开始，无法加入');
      if (table.players.length >= table.maxPlayers) throw new ServiceError('table_full', '牌桌已满');

      table.players.push({ id: user.id, name: user.name, seat: table.players.length, bot: false });
      table.seq += 1;
      await this.store.saveTable(table);
      this.bus.publish(tableId);
    });
  }

  async startTable(tableId: string, userId: string): Promise<void> {
    await this.lock(tableId).run(async () => {
      const table = await this.store.getTable(tableId);
      if (!table) throw new ServiceError('no_table', '牌桌不存在');
      if (table.hostId !== userId) throw new ServiceError('not_host', '只有房主可以开始');
      if (table.status !== 'lobby') throw new ServiceError('already_started', '对局已经开始');

      const plugin = this.pluginOf(table);
      if (table.players.length < plugin.manifest.players.min) {
        throw new ServiceError('not_enough_players', `至少需要 ${plugin.manifest.players.min} 人`);
      }

      const now = Date.now();
      const { state, effects } = createInitialState(plugin, {
        players: table.players.map((p) => p.id),
        options: table.options,
        // 建局是唯一允许"真随机"的地方；之后一切随机都走 state.rngSeed
        seed: Math.floor(Math.random() * 0xffffffff),
        now,
      });

      table.state = state;
      table.status = 'playing';
      table.startedAt = now;
      table.seq += 1;
      this.appendLogs(table, effects, now);
      this.refreshDeadline(table, plugin, now);
      await this.store.saveTable(table);
      this.bus.publish(tableId);
    });
  }

  /* ---------------------------------------------------------------- */
  /* 动作                                                              */
  /* ---------------------------------------------------------------- */

  async act(tableId: string, userId: string, action: { type: string; payload?: unknown }): Promise<void> {
    await this.lock(tableId).run(async () => {
      const table = await this.store.getTable(tableId);
      if (!table) throw new ServiceError('no_table', '牌桌不存在');
      if (table.status !== 'playing') throw new ServiceError('not_playing', '对局未开始或已结束');
      if (!table.state) throw new ServiceError('broken_table', '牌桌状态异常');
      if (!table.players.some((p) => p.id === userId)) {
        throw new ServiceError('not_seated', '你不在这一桌');
      }

      const plugin = this.pluginOf(table);
      const now = Date.now();
      let result;
      try {
        result = applyAction(plugin, table.state as any, userId, action, now);
      } catch (err) {
        if (err instanceof RuleError) throw new ServiceError(err.code, err.message);
        throw err;
      }

      table.state = result.state;
      table.seq += 1;
      this.appendLogs(table, result.effects, now);
      this.settle(table, plugin, now);
      await this.store.saveTable(table);
      this.bus.publish(tableId);
    });
  }

  /** 由定时器驱动：到点替当前玩家走一步 */
  async tick(now: number): Promise<void> {
    const tables = await this.store.listTables();

    for (const candidate of tables) {
      if (candidate.status !== 'playing') continue;
      if (candidate.deadlineAt === null || candidate.deadlineAt > now) continue;

      await this.lock(candidate.id).run(async () => {
        const table = await this.store.getTable(candidate.id);
        if (!table || table.status !== 'playing' || !table.state) return;
        // 二次确认：玩家可能刚刚落子，deadline 已被推后
        if (table.deadlineAt === null || table.deadlineAt > Date.now()) return;

        const plugin = this.pluginOf(table);
        const at = Date.now();
        const result = applyTimeout(plugin, table.state as any, at);

        if (!result) {
          // 插件没有兜底策略，只能把计时器停掉，避免空转
          table.deadlineAt = null;
          await this.store.saveTable(table);
          return;
        }

        table.state = result.state;
        table.seq += 1;
        this.appendLogs(table, result.effects, at);
        this.settle(table, plugin, at);
        await this.store.saveTable(table);
        this.bus.publish(table.id);
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 查询                                                              */
  /* ---------------------------------------------------------------- */

  async snapshot(tableId: string, viewerId: string): Promise<TableSnapshot> {
    const table = await this.store.getTable(tableId);
    if (!table) throw new ServiceError('no_table', '牌桌不存在');

    const plugin = this.pluginOf(table);
    const isPlayer = table.players.some((p) => p.id === viewerId);

    let view: PublicView | null = null;
    let activePlayer: string | null = null;
    let legal: string[] = [];

    if (table.state) {
      view = plugin.view(table.state as any, isPlayer ? viewerId : 'spectator');
      activePlayer = activePlayerOf(plugin, table.state as any);
      if (isPlayer) legal = legalActions(plugin, table.state as any, viewerId);
    }

    return {
      tableId: table.id,
      gameId: table.gameId,
      gameName: plugin.manifest.name,
      gameVersion: table.gameVersion,
      status: table.status,
      seq: table.seq,
      hostId: table.hostId,
      minPlayers: plugin.manifest.players.min,
      maxPlayers: table.maxPlayers,
      options: table.options,
      players: table.players.map((p) => ({ ...p })),
      you: { id: viewerId, isPlayer, isHost: table.hostId === viewerId },
      view,
      legal,
      activePlayer,
      deadlineAt: table.deadlineAt,
      log: table.log
        .filter((entry) => entry.to === 'all' || entry.to.includes(viewerId))
        .slice(-80),
    };
  }

  async summaries(): Promise<TableSummary[]> {
    const tables = await this.store.listTables();
    return tables.map((table) => {
      const plugin = this.games.get(table.gameId);
      const host = table.players.find((p) => p.id === table.hostId);
      return {
        id: table.id,
        gameId: table.gameId,
        gameName: plugin?.manifest.name ?? table.gameId,
        status: table.status,
        players: table.players.length,
        maxPlayers: table.maxPlayers,
        hostName: host?.name ?? '—',
        createdAt: table.createdAt,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                              */
  /* ---------------------------------------------------------------- */

  private appendLogs(table: TableRecord, effects: Effect[], now: number): void {
    for (const effect of effects) {
      if (effect.type !== 'log') continue;
      const entry: LogEntry = {
        seq: table.log.length + 1,
        key: effect.key,
        args: effect.args,
        to: effect.to ?? 'all',
        at: now,
      };
      table.log.push(entry);
    }
    if (table.log.length > MAX_LOG) table.log.splice(0, table.log.length - MAX_LOG);
  }

  private refreshDeadline(table: TableRecord, plugin: GamePlugin<any>, now: number): void {
    if (!table.state || table.status !== 'playing') {
      table.deadlineAt = null;
      return;
    }
    const active = activePlayerOf(plugin, table.state as any);
    if (!active) {
      table.deadlineAt = null;
      return;
    }
    const raw = table.options.turnMs;
    const turnMs = typeof raw === 'number' && raw >= 5_000 && raw <= 600_000 ? raw : DEFAULT_TURN_MS;
    table.deadlineAt = now + turnMs;
  }

  private settle(table: TableRecord, plugin: GamePlugin<any>, now: number): void {
    if (table.state?.finished) {
      table.status = 'finished';
      table.finishedAt = now;
      table.deadlineAt = null;
      return;
    }
    this.refreshDeadline(table, plugin, now);
  }
}
