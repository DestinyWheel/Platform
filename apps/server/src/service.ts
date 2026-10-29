import { randomUUID } from 'node:crypto';
import type {
  AnyAction,
  BaseState,
  Effect,
  GamePlugin,
  LogEntry,
  PublicView,
  ReplayPayload,
  ReplayStep,
  TableSnapshot,
  TableSummary,
} from '@platform/sdk';
import {
  activePlayerOf,
  applyAction,
  applyTimeout,
  createInitialState,
  enumerateLegalMoves,
  legalActions,
  RuleError,
} from '@platform/engine';
import type { EventBus } from './bus.js';
import type { PluginHost } from './pluginHost/host.js';
import { hashState } from './hash.js';
import { computeDeltas, DEFAULT_RATING } from './elo.js';
import type { Presence } from './presence.js';
import type { ActionLog, RecentMatch, Store, TableRecord, UserRecord } from './store.js';

const DEFAULT_TURN_MS = 30_000;
const MAX_LOG = 200;
const MAX_CAS_ATTEMPTS = 5;
const MAX_REPLAY_STEPS = 400;

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface CreateTableInput {
  gameId: string;
  maxPlayers?: number;
  options?: Record<string, unknown>;
}

/** 一次写操作的结果：write=false 表示这次不改库（例如并发下已被别人推进） */
interface MutationOutcome<T> {
  write: boolean;
  result: T;
  log?: ActionLog;
}

export class TableService {
  constructor(
    private readonly store: Store,
    private readonly host: PluginHost,
    private readonly bus: EventBus,
    private readonly presence: Presence,
    private readonly onError: (error: unknown, tableId: string) => void = () => {},
  ) {}

  /**
   * 取这张桌锁定的插件版本。
   * 注意用的是 table.gameVersion 而不是"当前最新版本"——这就是版本固定的落点。
   */
  private async pluginOf(table: TableRecord): Promise<GamePlugin<any>> {
    try {
      const loaded = await this.host.ensure(table.gameId, table.gameVersion);
      return loaded.plugin;
    } catch {
      throw new ServiceError(
        'plugin_missing',
        `插件 ${table.gameId}@${table.gameVersion} 当前不可用`,
      );
    }
  }

  /**
   * 单桌写操作统一入口：读 → 改 → CAS 写。
   *
   * 冲突时不加锁等待，而是重新读一遍再算一次。因为 reducer 是纯函数，
   * 重算的代价很低；也因为这样，多实例部署时天然不会互相覆盖。
   */
  private async withTable<T>(
    tableId: string,
    mutate: (table: TableRecord) => Promise<MutationOutcome<T>> | MutationOutcome<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const table = await this.store.getTable(tableId);
      if (!table) throw new ServiceError('no_table', '牌桌不存在');

      const expectedSeq = table.seq;
      const outcome = await mutate(table);
      if (!outcome.write) return outcome.result;

      const saved = await this.store.updateTable({ table, expectedSeq, log: outcome.log });
      if (saved) {
        this.bus.publish(tableId);
        // 结算在这一步之后做：只有 CAS 成功才算这局真的结束了
        if (table.status === 'finished') await this.recordResult(table);
        return outcome.result;
      }
      // 被别人抢先写了：丢弃这次的计算结果，重读重算
    }
    throw new ServiceError('conflict', '这张桌上同时在发生太多操作，请稍后重试');
  }

  /* ---------------------------------------------------------------- */
  /* 建桌 / 加入 / 开局                                                 */
  /* ---------------------------------------------------------------- */

  async createTable(user: UserRecord, input: CreateTableInput): Promise<string> {
    const active = this.host.activeFor(input.gameId);
    if (!active) throw new ServiceError('unknown_game', `没有这个游戏：${input.gameId}`);

    const { min, max } = active.manifest.players;
    const requested = input.maxPlayers ?? max;
    const maxPlayers = Math.max(min, Math.min(max, Math.trunc(requested)));

    const now = Date.now();
    const record: TableRecord = {
      id: randomUUID(),
      gameId: active.manifest.id,
      // ★ 建桌这一刻锁定版本：之后发新版不会影响这一桌
      gameVersion: active.version,
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
    await this.withTable(tableId, (table) => {
      if (table.players.some((player) => player.id === user.id)) {
        return { write: false, result: undefined };
      }
      if (table.status !== 'lobby') {
        throw new ServiceError('already_started', '对局已经开始，无法加入');
      }
      if (table.players.length >= table.maxPlayers) {
        throw new ServiceError('table_full', '牌桌已满');
      }

      table.players.push({
        id: user.id,
        name: user.name,
        seat: table.players.length,
        bot: false,
      });
      table.seq += 1;
      return { write: true, result: undefined };
    });
  }

  async startTable(tableId: string, userId: string): Promise<void> {
    await this.withTable(tableId, async (table) => {
      if (table.hostId !== userId) throw new ServiceError('not_host', '只有房主可以开始');
      if (table.status !== 'lobby') throw new ServiceError('already_started', '对局已经开始');

      const plugin = await this.pluginOf(table);
      if (table.players.length < plugin.manifest.players.min) {
        throw new ServiceError('not_enough_players', `至少需要 ${plugin.manifest.players.min} 人`);
      }

      const now = Date.now();
      const seed = Math.floor(Math.random() * 0xffffffff);
      const setup = {
        players: table.players.map((player) => player.id),
        options: table.options,
        // 建局是唯一允许"真随机"的地方；之后一切随机都走 state.rngSeed
        seed,
        now,
      };
      const { state, effects } = createInitialState(plugin, setup);

      table.state = state;
      table.status = 'playing';
      table.startedAt = now;
      table.seq += 1;
      this.appendLogs(table, effects, now);
      this.refreshDeadline(table, plugin, now);

      return {
        write: true,
        result: undefined,
        log: {
          actor: userId,
          kind: 'start',
          // 把建局参数一并落库，回放时才能重建出完全相同的初始状态
          action: { seed, players: setup.players, options: setup.options },
          effects,
          stateHash: hashState(state),
        },
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 动作                                                              */
  /* ---------------------------------------------------------------- */

  async act(tableId: string, userId: string, action: AnyAction): Promise<void> {
    await this.withTable(tableId, async (table) => {
      if (table.status !== 'playing') throw new ServiceError('not_playing', '对局未开始或已结束');
      if (!table.state) throw new ServiceError('broken_table', '牌桌状态异常');
      if (!table.players.some((player) => player.id === userId)) {
        throw new ServiceError('not_seated', '你不在这一桌');
      }

      const plugin = await this.pluginOf(table);
      const now = Date.now();

      let applied;
      try {
        applied = applyAction(plugin, table.state as any, userId, action, now);
      } catch (error) {
        if (error instanceof RuleError) throw new ServiceError(error.code, error.message);
        throw error;
      }

      table.state = applied.state;
      table.seq += 1;
      this.appendLogs(table, applied.effects, now);
      this.settle(table, plugin, now);

      return {
        write: true,
        result: undefined,
        log: {
          actor: userId,
          kind: 'action',
          action,
          effects: applied.effects,
          stateHash: hashState(applied.state),
        },
      };
    });
  }

  /** 由定时器驱动：到点替当前玩家走一步。多实例下每个实例都能扫，靠 CAS 去重。 */
  async tick(now: number): Promise<void> {
    const expired = await this.store.listExpired(now);

    for (const candidate of expired) {
      try {
        await this.withTable(candidate.id, async (table) => {
          if (table.status !== 'playing' || !table.state) return { write: false, result: undefined };
          // 回调里重新判定：读表和写库之间玩家可能刚刚落子，deadline 已被推后
          if (table.deadlineAt === null || table.deadlineAt > Date.now()) {
            return { write: false, result: undefined };
          }

          const plugin = await this.pluginOf(table);
          const at = Date.now();
          const applied = applyTimeout(plugin, table.state as any, at);

          if (!applied) {
            // 插件没有兜底策略，停掉计时器避免空转
            table.deadlineAt = null;
            table.seq += 1;
            return { write: true, result: undefined };
          }

          table.state = applied.state;
          table.seq += 1;
          this.appendLogs(table, applied.effects, at);
          this.settle(table, plugin, at);

          return {
            write: true,
            result: undefined,
            log: {
              // 超时也记下"代打了什么"，否则这一步在回放里就断了
              actor: applied.actor,
              kind: 'timeout',
              action: applied.action,
              effects: applied.effects,
              stateHash: hashState(applied.state),
            },
          };
        });
      } catch (error) {
        // 单张桌出错不能拖垮扫描循环
        this.onError(error, candidate.id);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 查询                                                              */
  /* ---------------------------------------------------------------- */

  async snapshot(tableId: string, viewerId: string): Promise<TableSnapshot> {
    const table = await this.store.getTable(tableId);
    if (!table) throw new ServiceError('no_table', '牌桌不存在');

    const plugin = await this.pluginOf(table);
    const isPlayer = table.players.some((player) => player.id === viewerId);

    let view: PublicView | null = null;
    let activePlayer: string | null = null;
    let legal: string[] = [];
    let legalMoves: AnyAction[] = [];

    if (table.state) {
      view = plugin.view(table.state as any, isPlayer ? viewerId : 'spectator');
      activePlayer = activePlayerOf(plugin, table.state as any);
      if (isPlayer) {
        legal = legalActions(plugin, table.state as any, viewerId);
        legalMoves = enumerateLegalMoves(plugin, table.state as any, viewerId);
      }
    }

    const chat = await this.store.listChat(table.id, 30);

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
      players: table.players.map((player) => ({ ...player })),
      you: { id: viewerId, isPlayer, isHost: table.hostId === viewerId },
      view,
      legal,
      legalMoves,
      activePlayer,
      deadlineAt: table.deadlineAt,
      log: table.log.filter((entry) => entry.to === 'all' || entry.to.includes(viewerId)).slice(-80),
      chat,
      viewers: this.presence.viewers(table.id),
    };
  }

  async summaries(): Promise<TableSummary[]> {
    const tables = await this.store.listTables();
    return tables.map((table) => {
      const gameName =
        this.host.get(table.gameId, table.gameVersion)?.manifest.name ??
        this.host.activeFor(table.gameId)?.manifest.name ??
        table.gameId;
      const host = table.players.find((player) => player.id === table.hostId);
      return {
        id: table.id,
        gameId: table.gameId,
        gameName,
        status: table.status,
        players: table.players.length,
        maxPlayers: table.maxPlayers,
        hostName: host?.name ?? '—',
        createdAt: table.createdAt,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 聊天 / 回放 / 战绩                                                 */
  /* ---------------------------------------------------------------- */

  async chat(tableId: string, user: { id: string; name: string }, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    if (body.length > 200) throw new ServiceError('chat_too_long', '消息最多 200 个字');

    const table = await this.store.getTable(tableId);
    if (!table) throw new ServiceError('no_table', '牌桌不存在');

    await this.store.appendChat(tableId, user.id, user.name, body, Date.now());
    this.bus.publish(tableId);
  }

  /**
   * 回放：把动作日志从头重放一遍，每一步留一张快照。
   * 因为 reducer 是纯函数，重放出来的局面和当时一模一样（测试里有哈希比对）。
   */
  async replay(tableId: string): Promise<ReplayPayload> {
    const table = await this.store.getTable(tableId);
    if (!table) throw new ServiceError('no_table', '牌桌不存在');

    const plugin = await this.pluginOf(table);
    const rows = await this.store.listActions(tableId);
    const start = rows.find((row) => row.kind === 'start');
    if (!start) throw new ServiceError('no_replay', '这局还没有可回放的记录');

    const setup = start.action as
      | { seed: number; players: string[]; options?: Record<string, unknown> }
      | null;
    if (!setup || typeof setup.seed !== 'number') {
      throw new ServiceError('no_replay', '建局记录不完整，无法回放');
    }

    let state = createInitialState(plugin, {
      players: setup.players,
      options: setup.options ?? {},
      seed: setup.seed,
      now: 0,
    }).state;

    const steps: ReplayStep[] = [];
    const logs: LogEntry[] = [];
    let truncated = false;

    const pushStep = (seq: number, kind: string, actor: string | null): void => {
      steps.push({
        seq,
        kind,
        actor,
        // 回放一律按观战者视角裁剪：不该看到的东西，看回放也不该看到
        view: plugin.view(state, 'spectator'),
        log: logs.slice(-60),
      });
    };

    pushStep(start.seq, 'start', start.actor);

    for (const row of rows) {
      if (row.kind === 'start') continue;
      if (steps.length >= MAX_REPLAY_STEPS) {
        truncated = true;
        break;
      }
      if (!row.action || !row.actor) continue;

      state = applyAction(plugin, state, row.actor, row.action as AnyAction, Number(row.createdAt))
        .state;
      this.pushLogs(logs, (row.effects as Effect[]) ?? [], Number(row.createdAt));
      pushStep(row.seq, row.kind, row.actor);
    }

    return {
      tableId: table.id,
      gameId: table.gameId,
      gameName: plugin.manifest.name,
      gameVersion: table.gameVersion,
      status: table.status,
      players: table.players.map((player) => ({ ...player })),
      steps,
      truncated,
    };
  }

  async stats(userId: string): Promise<{
    perGame: { gameId: string; gameName: string; games: number; wins: number }[];
    recent: (RecentMatch & { gameName: string })[];
  }> {
    const perGame = await this.store.getUserStats(userId);
    const recent = await this.store.getRecentMatches(userId, 20);

    const nameOf = (gameId: string): string =>
      this.host.activeFor(gameId)?.manifest.name ?? gameId;

    return {
      perGame: perGame.map((row) => ({ ...row, gameName: nameOf(row.gameId) })),
      recent: recent.map((row) => ({ ...row, gameName: nameOf(row.gameId) })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                              */
  /* ---------------------------------------------------------------- */

  /** 一局结束写一次战绩 + 更新 Elo；saveMatchResults 幂等，重复调用不会重复计分 */
  private async recordResult(table: TableRecord): Promise<void> {
    const ranking = table.state?.ranking;
    if (!ranking || ranking.length === 0) return;

    const humans = table.players.filter((player) => !player.bot);
    if (humans.length < 2) return;
    if (await this.store.hasMatchResults(table.id)) return;

    const rankOf = new Map<string, number>();
    ranking.forEach((group, index) => {
      for (const playerId of group) rankOf.set(playerId, index + 1);
    });

    const rows = humans.map((player) => {
      const rank = rankOf.get(player.id) ?? humans.length;
      return { userId: player.id, rank, players: humans.length, isWin: rank === 1 };
    });

    const finishedAt = table.finishedAt ?? Date.now();
    await this.store.saveMatchResults(table.id, table.gameId, rows, finishedAt);

    // 默认计分；房主把 options.ranked 设成 false 就是休闲局
    if (table.options.ranked === false) return;

    const current = await this.store.getRatings(
      table.gameId,
      rows.map((row) => row.userId),
    );
    const players = rows.map((row) => ({
      userId: row.userId,
      rank: row.rank,
      rating: current.get(row.userId)?.rating ?? DEFAULT_RATING,
      games: current.get(row.userId)?.games ?? 0,
    }));

    const deltas = computeDeltas(players);
    await this.store.applyRatingDeltas(
      table.gameId,
      players.map((player) => ({
        userId: player.userId,
        rating: player.rating + (deltas.get(player.userId) ?? 0),
        games: player.games + 1,
      })),
      finishedAt,
    );
  }

  async leaderboard(gameId: string, limit = 20) {
    return this.store.listRatings(gameId, limit);
  }

  private pushLogs(into: LogEntry[], effects: Effect[], now: number): void {
    for (const effect of effects) {
      if (effect.type !== 'log') continue;
      into.push({
        seq: into.length + 1,
        key: effect.key,
        args: effect.args,
        to: effect.to ?? 'all',
        at: now,
      });
    }
  }

  private appendLogs(table: TableRecord, effects: Effect[], now: number): void {
    this.pushLogs(table.log, effects, now);
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
