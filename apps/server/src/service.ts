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
  RuleError,
} from '@platform/engine';
import type { EventBus } from './bus.js';
import type { PluginHost } from './pluginHost/host.js';
import type { PluginRuntime } from './pluginHost/runtime.js';
import { hashState } from './hash.js';
import { computeDeltas, DEFAULT_RATING } from './elo.js';
import type { Presence } from './presence.js';
import type { ActionLog, RecentMatch, Store, TableRecord, UserRecord } from './store.js';

const DEFAULT_TURN_MS = 30_000;
const MAX_LOG = 200;
const MAX_CAS_ATTEMPTS = 5;
const MAX_REPLAY_STEPS = 400;
/** 每多少步存一份回放快照 */
const SNAPSHOT_EVERY = 50;

/** 房间码字母表：去掉 0/O/1/I/L，念出来不会听错 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 6): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

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
  /** 落子之后轮到谁（用于判断该不该让机器人动） */
  activePlayer?: string | null;
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
  private async runtimeOf(table: TableRecord): Promise<PluginRuntime> {
    try {
      return await this.host.ensure(table.gameId, table.gameVersion);
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

      const saved = await this.store.updateTable({
        table,
        expectedSeq,
        log: outcome.log,
        // 每 50 步留一份快照，回放很长时从最近的一份起算，不用从第 0 步重放
        snapshot:
          table.state && table.seq % SNAPSHOT_EVERY === 0
            ? { state: table.state, hash: hashState(table.state) }
            : undefined,
      });
      if (saved) {
        this.bus.publish(tableId);
        // 结算在这一步之后做：只有 CAS 成功才算这局真的结束了
        if (table.status === 'finished') await this.recordResult(table);
        // 如果轮到机器人，安排它走一步
        this.scheduleBot(table, outcome.activePlayer ?? null);
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
      code: await this.allocateCode(),
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
      result: null,
    };

    await this.store.createTable(record);
    return record.id;
  }

  /** 房间码撞了就换一个；6 位 31 进制，撞车概率低到可以忽略，但还是认真重试 */
  private async allocateCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomCode();
      if (!(await this.store.findTableByCode(code))) return code;
    }
    throw new ServiceError('code_exhausted', '生成房间号失败，稍后再试');
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

  /**
   * 按房间号加入。已经开打的桌不允许再坐进来，但可以当观战入口——
   * 朋友发来"房间号 ABC234"，点进去至少能看到这局在打什么。
   */
  async joinByCode(code: string, user: UserRecord): Promise<string> {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) throw new ServiceError('bad_code', '请输入房间号');

    const table = await this.store.findTableByCode(trimmed);
    if (!table) throw new ServiceError('no_such_room', '没有这个房间号');

    if (table.status !== 'lobby') return table.id;

    await this.joinTable(table.id, user);
    return table.id;
  }

  /**
   * 随机加入：找一张还在等人、还有空位的桌。
   * 找不到就直接开一张——否则按钮点下去毫无反应，是最差的手感。
   */
  async quickMatch(user: UserRecord, gameId?: string): Promise<{ id: string; created: boolean }> {
    const target = gameId ?? this.host.listActive()[0]?.id;
    if (!target) throw new ServiceError('no_games', '还没有可玩的游戏');

    const open = await this.store.findOpenTable(target);
    if (open) {
      if (open.players.some((player) => player.id === user.id)) {
        return { id: open.id, created: false };
      }
      try {
        await this.joinTable(open.id, user);
        return { id: open.id, created: false };
      } catch (error) {
        // 刚好被人坐满：那就自己开一张，别把错误丢给用户
        if (!(error instanceof ServiceError)) throw error;
      }
    }

    return { id: await this.createTable(user, { gameId: target }), created: true };
  }

  /**
   * 未开局时离开。
   *
   * 房主走了就把房主顺位交给下一个人——否则这张桌谁也开不了，只能烂在大厅里。
   */
  async leave(tableId: string, userId: string): Promise<void> {
    await this.withTable(tableId, (table) => {
      if (table.status !== 'lobby') {
        throw new ServiceError('already_started', '对局已经开始，要离开请认负');
      }
      const index = table.players.findIndex((player) => player.id === userId);
      if (index < 0) throw new ServiceError('not_seated', '你不在这一桌');

      const now = Date.now();
      const leaving = table.players[index]!;
      table.players.splice(index, 1);
      table.players.forEach((player, seat) => {
        player.seat = seat;
      });
      table.seq += 1;

      if (table.players.length === 0) {
        // 最后一个人走了：这桌就没意义了，直接关掉（不产生战绩）
        table.status = 'finished';
        table.finishedAt = now;
        table.result = { ranking: [], reason: 'abandon', by: userId };
        table.deadlineAt = null;
      } else if (table.hostId === userId) {
        table.hostId = table.players[0]!.id;
        this.pushLogs(
          table.log,
          [
            {
              type: 'log',
              key: 'table.host_transferred',
              args: { from: leaving.name, to: table.players[0]!.name },
            },
          ],
          now,
        );
      }

      return { write: true, result: undefined };
    });
  }

  /**
   * 已开局时退出 = 认负。
   *
   * 不写 match_actions：那条日志是用来重演的，塞一个插件不认识的动作会让回放断掉。
   * 结果落在 tables.result 上，recordResult 会优先读它。
   */
  async forfeit(tableId: string, userId: string): Promise<void> {
    await this.withTable(tableId, (table) => {
      if (table.status !== 'playing') {
        throw new ServiceError('not_playing', '对局还没开始或已经结束');
      }
      const me = table.players.find((player) => player.id === userId);
      if (!me) throw new ServiceError('not_seated', '你不在这一桌');

      const now = Date.now();
      const others = table.players
        .filter((player) => player.id !== userId)
        .map((player) => [player.id]);

      table.result = { ranking: [...others, [userId]], reason: 'forfeit', by: userId };
      me.forfeited = true;
      table.status = 'finished';
      table.finishedAt = now;
      table.deadlineAt = null;
      table.seq += 1;
      this.pushLogs(
        table.log,
        [{ type: 'log', key: 'table.forfeit', args: { name: me.name } }],
        now,
      );

      return { write: true, result: undefined, activePlayer: null };
    });
  }

  /**
   * 再来一局：原班人马、原版本、原设置，开一张新桌。
   *
   * 注意版本用的是 `table.gameVersion` 而不是当前最新版——发新版是"新桌用新版"，
   * 不该顺带把这一桌的人偷偷换到另一套规则上。
   */
  async rematch(tableId: string, user: UserRecord): Promise<string> {
    const table = await this.store.getTable(tableId);
    if (!table) throw new ServiceError('no_table', '牌桌不存在');
    if (table.status !== 'finished') throw new ServiceError('not_finished', '这一局还没结束');
    if (!table.players.some((player) => player.id === user.id)) {
      throw new ServiceError('not_seated', '你不在这一桌');
    }

    // 认负退出的人不再拉进下一局：他想玩可以自己按房间号回来
    const humans = table.players.filter((player) => !player.bot && !player.forfeited);
    const now = Date.now();
    const record: TableRecord = {
      id: randomUUID(),
      code: await this.allocateCode(),
      gameId: table.gameId,
      gameVersion: table.gameVersion,
      hostId: user.id,
      status: 'lobby',
      players: humans.map((player, seat) => ({
        id: player.id,
        name: player.name,
        seat,
        bot: false,
      })),
      maxPlayers: table.maxPlayers,
      options: table.options,
      state: null,
      seq: 0,
      log: [],
      deadlineAt: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      result: null,
    };

    await this.store.createTable(record);
    return record.id;
  }

  async startTable(tableId: string, userId: string): Promise<void> {
    await this.withTable(tableId, async (table) => {
      if (table.hostId !== userId) throw new ServiceError('not_host', '只有房主可以开始');
      if (table.status !== 'lobby') throw new ServiceError('already_started', '对局已经开始');

      const runtime = await this.runtimeOf(table);

      // 开局时按 options.bots 补几个机器人座位
      const requestedBots = Number(table.options.bots ?? 0);
      if (Number.isFinite(requestedBots) && requestedBots > 0) {
        for (let index = 0; index < requestedBots && table.players.length < table.maxPlayers; index += 1) {
          table.players.push({
            id: `bot:${randomUUID()}`,
            name: `机器人 ${index + 1}`,
            seat: table.players.length,
            bot: true,
          });
        }
      }

      if (table.players.length < runtime.manifest.players.min) {
        throw new ServiceError(
          'not_enough_players',
          `至少需要 ${runtime.manifest.players.min} 人`,
        );
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
      const { state, effects, activePlayer } = await runtime.createState(setup);

      table.state = state as BaseState;
      table.status = 'playing';
      table.startedAt = now;
      table.seq += 1;
      this.appendLogs(table, effects, now);
      this.refreshDeadline(table, activePlayer, now);

      return {
        write: true,
        result: undefined,
        activePlayer,
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

      const runtime = await this.runtimeOf(table);
      const now = Date.now();

      let applied;
      try {
        applied = await runtime.applyAction(table.state, userId, action, now);
      } catch (error) {
        if (error instanceof RuleError) throw new ServiceError(error.code, error.message);
        throw error;
      }

      table.state = applied.state as BaseState;
      table.seq += 1;
      this.appendLogs(table, applied.effects, now);
      this.settle(table, applied.activePlayer, now);

      return {
        write: true,
        result: undefined,
        activePlayer: applied.activePlayer,
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

          const runtime = await this.runtimeOf(table);
          const at = Date.now();
          const applied = await runtime.applyTimeout(table.state, at);

          if (!applied) {
            // 插件没有兜底策略，停掉计时器避免空转
            table.deadlineAt = null;
            table.seq += 1;
            return { write: true, result: undefined };
          }

          table.state = applied.state as BaseState;
          table.seq += 1;
          this.appendLogs(table, applied.effects, at);
          this.settle(table, applied.activePlayer, at);

          return {
            write: true,
            result: undefined,
            activePlayer: applied.activePlayer,
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

    const runtime = await this.runtimeOf(table);
    const isPlayer = table.players.some((player) => player.id === viewerId);

    let view: PublicView | null = null;
    let activePlayer: string | null = null;
    let legal: string[] = [];
    let legalMoves: AnyAction[] = [];

    if (table.state) {
      // 一次跨线程调用拿齐视图 / 当前玩家 / 合法动作，避免每个快照打好几个来回
      const described = await runtime.describe(
        table.state,
        isPlayer ? viewerId : 'spectator',
        isPlayer ? viewerId : undefined,
      );
      view = described.view;
      activePlayer = described.activePlayer;
      legal = described.legal;
      legalMoves = described.legalMoves;
    }

    const chat = await this.store.listChat(table.id, 30);

    // 只有"这一版写了更新公告、而你还不知道"才查一次库；
    // 没写 notes 的游戏（大多数）零开销
    const notes = runtime.manifest.notes ?? [];
    const notice =
      notes.length > 0 &&
      !(await this.store.hasAckedVersion(viewerId, table.gameId, table.gameVersion))
        ? {
            gameId: table.gameId,
            gameName: runtime.manifest.name,
            version: table.gameVersion,
            notes,
          }
        : null;

    return {
      tableId: table.id,
      gameId: table.gameId,
      gameName: runtime.manifest.name,
      gameVersion: table.gameVersion,
      code: table.code,
      status: table.status,
      seq: table.seq,
      hostId: table.hostId,
      minPlayers: runtime.manifest.players.min,
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
      notice,
    };
  }

  /** 我参与的、还没结束的桌（首页「我的对局」） */
  async listMine(userId: string): Promise<TableSummary[]> {
    const tables = await this.store.listMyTables(userId, 20);
    return tables.map((table) => this.toSummary(table, userId));
  }

  private toSummary(table: TableRecord, viewerId?: string): TableSummary {
    const gameName =
      this.host.get(table.gameId, table.gameVersion)?.manifest.name ??
      this.host.activeFor(table.gameId)?.manifest.name ??
      table.gameId;
    const host = table.players.find((player) => player.id === table.hostId);
    const seated = viewerId ? table.players.find((player) => player.id === viewerId) : undefined;

    return {
      id: table.id,
      gameId: table.gameId,
      gameName,
      code: table.code,
      status: table.status,
      players: table.players.length,
      maxPlayers: table.maxPlayers,
      hostName: host?.name ?? '—',
      createdAt: table.createdAt,
      ...(viewerId
        ? { mine: seated ? (seated.id === table.hostId ? ('host' as const) : ('player' as const)) : ('spectator' as const) }
        : {}),
    };
  }

  async summaries(): Promise<TableSummary[]> {
    const tables = await this.store.listTables();
    return tables.map((table) => this.toSummary(table));
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

    const runtime = await this.runtimeOf(table);
    const rows = await this.store.listActions(tableId);
    const start = rows.find((row) => row.kind === 'start');
    if (!start) throw new ServiceError('no_replay', '这局还没有可回放的记录');

    const setup = start.action as
      | { seed: number; players: string[]; options?: Record<string, unknown> }
      | null;
    if (!setup || typeof setup.seed !== 'number') {
      throw new ServiceError('no_replay', '建局记录不完整，无法回放');
    }

    // 步数超过上限时，从最近的快照起算：回放"最后一段"，
    // 总比永远卡在第 400 步、看不到结局强。快照只存库，下发的仍然是观战者视角。
    const total = rows.length;
    const fromSeq = total > MAX_REPLAY_STEPS ? rows[total - MAX_REPLAY_STEPS]!.seq : start.seq;
    const snapshot = fromSeq > start.seq ? await this.store.latestSnapshot(table.id, fromSeq) : undefined;

    let state: unknown;
    let cursor: number;
    if (snapshot) {
      state = snapshot.state;
      cursor = snapshot.seq;
    } else {
      state = (
        await runtime.createState({
          players: setup.players,
          options: setup.options ?? {},
          seed: setup.seed,
          now: 0,
        })
      ).state;
      cursor = start.seq;
    }

    const steps: ReplayStep[] = [];
    const logs: LogEntry[] = [];
    let truncated = fromSeq > start.seq;

    const pushStep = async (seq: number, kind: string, actor: string | null): Promise<void> => {
      const described = await runtime.describe(state, 'spectator');
      steps.push({
        seq,
        kind,
        actor,
        // 回放一律按观战者视角裁剪：不该看到的东西，看回放也不该看到
        view: described.view,
        log: logs.slice(-60),
      });
    };

    const anchor = rows.find((row) => row.seq === cursor);
    await pushStep(cursor, anchor?.kind ?? 'start', anchor?.actor ?? null);

    for (const row of rows) {
      if (row.seq <= cursor) continue;
      if (row.kind === 'start') continue;
      if (steps.length >= MAX_REPLAY_STEPS) {
        truncated = true;
        break;
      }
      if (!row.action || !row.actor) continue;

      state = (
        await runtime.applyAction(state, row.actor, row.action as AnyAction, Number(row.createdAt))
      ).state;
      this.pushLogs(logs, (row.effects as Effect[]) ?? [], Number(row.createdAt));
      await pushStep(row.seq, row.kind, row.actor);
    }

    return {
      tableId: table.id,
      gameId: table.gameId,
      gameName: runtime.manifest.name,
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
    // 认负这类平台算出来的结果优先：插件在中途根本没跑过结算
    const ranking = table.result?.ranking ?? table.state?.ranking;
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

  /* ---------------------------------------------------------------- */
  /* 人机                                                              */
  /* ---------------------------------------------------------------- */

  private readonly botTimers = new Map<string, NodeJS.Timeout>();

  /**
   * 轮到机器人就安排它走一步。
   *
   * 机器人**不是特殊路径**：它同样走 act() → validate → reduce → CAS，
   * 只是提交动作的不是一条 WebSocket 连接，而是一个定时器。
   */
  private scheduleBot(table: TableRecord, activePlayer: string | null): void {
    if (!activePlayer || table.status === 'finished') return;

    const seat = table.players.find((player) => player.id === activePlayer);
    if (!seat?.bot) return;
    if (this.botTimers.has(table.id)) return;

    // 假装思考一下，别让对手看到瞬间连走三步
    const delay = 400 + Math.floor(Math.random() * 600);
    const timer = setTimeout(() => {
      this.botTimers.delete(table.id);
      void this.playBotTurn(table.id).catch((error) => this.onError(error, table.id));
    }, delay);
    timer.unref?.();
    this.botTimers.set(table.id, timer);
  }

  private async playBotTurn(tableId: string): Promise<void> {
    const table = await this.store.getTable(tableId);
    if (!table || table.status === 'finished' || !table.state) return;

    const runtime = await this.runtimeOf(table);
    const level = typeof table.options.botLevel === 'string' ? table.options.botLevel : 'normal';
    const decision = await runtime.botMove(table.state, level);
    if (!decision) return;

    const seat = table.players.find((player) => player.id === decision.actor);
    if (!seat?.bot) return;

    // 和真人完全相同的提交路径
    await this.act(tableId, decision.actor, decision.action);
  }

  /** 关服时清掉还没触发的机器人定时器 */
  stopBots(): void {
    for (const timer of this.botTimers.values()) clearTimeout(timer);
    this.botTimers.clear();
  }

  private appendLogs(table: TableRecord, effects: Effect[], now: number): void {
    this.pushLogs(table.log, effects, now);
    if (table.log.length > MAX_LOG) table.log.splice(0, table.log.length - MAX_LOG);
  }

  private refreshDeadline(table: TableRecord, activePlayer: string | null, now: number): void {
    if (!table.state || table.status !== 'playing' || !activePlayer) {
      table.deadlineAt = null;
      return;
    }

    // turnMs === 0 表示不限时房间：不设截止时间，也就不会被超时托管
    if (table.options.turnMs === 0) {
      table.deadlineAt = null;
      return;
    }

    const raw = table.options.turnMs;
    const turnMs = typeof raw === 'number' && raw >= 5_000 && raw <= 600_000 ? raw : DEFAULT_TURN_MS;
    table.deadlineAt = now + turnMs;
  }

  private settle(table: TableRecord, activePlayer: string | null, now: number): void {
    if (table.state?.finished) {
      table.status = 'finished';
      table.finishedAt = now;
      table.deadlineAt = null;
      return;
    }
    this.refreshDeadline(table, activePlayer, now);
  }
}
