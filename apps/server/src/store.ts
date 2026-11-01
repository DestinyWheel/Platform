import { randomUUID } from 'node:crypto';
import type {
  AdminRatingRow,
  BaseState,
  ChatMessage,
  GameManifest,
  LogEntry,
  TableMode,
  TableStatus,
} from '@platform/sdk';
import { INVITE_CODE_LENGTH, randomCode } from './codes.js';
import type { Db } from './db/types.js';

export interface UserRecord {
  id: string;
  /** 原始昵称（可以重复） */
  name: string;
  /** 4–6 位数字编号，全局唯一：`名字#编号` 才是完整的称呼 */
  tag: string;
  createdAt: number;
  /** 第一个注册的人自动成为管理员（私人平台够用，M3 再加角色表） */
  isAdmin: boolean;
  /** false = 旧版昵称登录留下的账号，还没设过密码 */
  hasPassword: boolean;
  /** 令牌版本；和 JWT 里的 ver 对不上就说明这次会话已被作废 */
  tokenVersion: number;
  lastLoginAt: number | null;
  /** 个人邀请码：注册时自动生成；老账号是 null，可以在用户中心生成一次 */
  inviteCode: string | null;
  inviteCodeAt: number | null;
  /** 用谁的邀请码注册的 */
  invitedBy: string | null;
  /** 上次点开「消息」的时间：新关注、新私聊都按它算未读 */
  socialSeenAt: number;
}

/** 展示名：`张三#4821`。拼名字的地方都走它，别各拼各的 */
export function displayName(user: { name: string; tag?: string | null }): string {
  return user.tag ? `${user.name}#${user.tag}` : user.name;
}

/** 4–6 位随机数字编号；不用前导 0，念出来不别扭 */
export function randomTag(digits: number): string {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  return String(min + Math.floor(Math.random() * (max - min)));
}

/** 只在登录校验时用；命名上带 secret，避免被顺手塞进接口返回值 */
export interface UserWithSecret extends UserRecord {
  passwordHash: string | null;
}

export interface TablePlayer {
  id: string;
  name: string;
  seat: number;
  bot: boolean;
  /** 中途认负退出：还留在名单里（要算战绩），但「再来一局」不会再拖上他 */
  forfeited?: boolean;
}

export interface TableRecord {
  id: string;
  /** 6 位房间码；迁移前建的老桌是 null */
  code: string | null;
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
  /** 即时制 / 回合制 */
  mode: TableMode;
  /** 节奏档位（见迁移 008 的注释） */
  pace: string;
  /** 每步给多少毫秒；null = 不限时 */
  turnMs: number | null;
  /** 每日可行动时段，UTC 当天的第几分钟；null = 全天 */
  windowStart: number | null;
  windowEnd: number | null;
  /** 连续超时次数，满 3 次判负 */
  timeoutStreak: number;
  /** 无限时长 = 友谊赛，不计分 */
  friendly: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * 平台自己算出来的结算结果（认负、房主解散这类插件没算过 ranking 的情形）。
   * recordResult 优先读它，读不到才回落到插件状态里的 ranking。
   */
  result: TableResult | null;
}

export interface TableResult {
  /** 和 BaseState.ranking 同构：并列的放同一子数组，靠前的名次更高 */
  ranking: string[][];
  reason: 'forfeit' | 'abandon';
  /** 认负 / 解散的责任人 */
  by?: string;
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
  /** 每 50 步存一份回放快照，和状态更新放在同一个事务里 */
  snapshot?: { state: unknown; hash: string };
}

export interface Store {
  /** 昵称可以重复，所以返回的是一个列表；登录时靠它判断要不要让人选 */
  findUsersByName(name: string): Promise<UserRecord[]>;
  /** 带密码材料的登录查询；给了 tag 就精确到人 */
  findUserWithSecret(name: string, tag?: string): Promise<UserWithSecret | undefined>;
  findUserSecretById(id: string): Promise<UserWithSecret | undefined>;
  createUser(
    name: string,
    passwordHash: string | null,
    invitedBy?: string | null,
  ): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | undefined>;
  getUsersByIds(ids: string[]): Promise<UserRecord[]>;
  /** 按昵称片段 / #编号 检索人 */
  searchUsers(query: string, limit: number): Promise<UserRecord[]>;
  countUsers(): Promise<number>;
  /** 按邀请码找人；注册时用它确认"这个码是谁的" */
  findUserByInviteCode(code: string): Promise<UserRecord | undefined>;
  /**
   * 生成个人邀请码，**只能生成一次**：
   * 已经有了就返回 null（调用方转成 409），不会覆盖。
   */
  setInviteCode(id: string): Promise<UserRecord | null>;
  /** 我用邀请码拉进来的人（新的在前） */
  listInvited(
    userId: string,
    limit?: number,
  ): Promise<{ id: string; name: string; tag: string; createdAt: number }[]>;
  /** 设密码（注册后补设 / 认领 / 管理员重置）并作废所有旧令牌，返回新的 token_version */
  setPassword(id: string, passwordHash: string): Promise<number>;
  /** 退出登录：作废所有旧令牌 */
  bumpTokenVersion(id: string): Promise<number>;
  touchLogin(id: string): Promise<void>;
  /** 点开「消息」：之前的关注和私聊都算读过了 */
  markSocialSeen(id: string): Promise<void>;

  /* ------------------------- 关注 / 拉黑 ------------------------- */
  /** 我的分组；第一次调用会自动建一个「默认分组」 */
  listFollowGroups(userId: string): Promise<FollowGroupRecord[]>;
  createFollowGroup(userId: string, name: string): Promise<FollowGroupRecord>;
  renameFollowGroup(userId: string, groupId: string, name: string): Promise<boolean>;
  /** 删分组：组里的人回默认分组，关注关系本身不删 */
  deleteFollowGroup(userId: string, groupId: string): Promise<boolean>;

  listFollowing(userId: string): Promise<FollowRow[]>;
  listFollowers(userId: string): Promise<FollowRow[]>;
  follow(followerId: string, followeeId: string, groupId: string | null, special: boolean): Promise<FollowRow>;
  unfollow(followerId: string, followeeId: string): Promise<void>;
  updateFollow(
    followerId: string,
    followeeId: string,
    patch: { groupId?: string | null; special?: boolean },
  ): Promise<FollowRow | undefined>;
  countFollows(userId: string): Promise<{ following: number; followers: number }>;

  listBlocks(userId: string): Promise<{ id: string; name: string; tag: string; at: number }[]>;
  block(blockerId: string, blockedId: string): Promise<void>;
  unblock(blockerId: string, blockedId: string): Promise<void>;
  /** a 拉黑了 b，或者 b 拉黑了 a */
  hasBlockBetween(a: string, b: string): Promise<boolean>;
  /** 双向拉黑：我要不要显示「已拉黑」，对面是不是把我挡了 */
  blockInfo(
    me: string,
    other: string,
  ): Promise<{ iBlocked: boolean; blockedMe: boolean }>;
  isFollowing(followerId: string, followeeId: string): Promise<boolean>;
  /** 单条关注关系；拿这条是为了知道分组和特别关注 */
  getFollow(followerId: string, followeeId: string): Promise<FollowRow | undefined>;

  /* ------------------------- 私聊 ------------------------- */
  saveDirectMessage(
    from: string,
    to: string,
    body: string,
    now: number,
  ): Promise<DirectMessageRecord>;
  listDirectMessages(me: string, peer: string, limit: number): Promise<DirectMessageRecord[]>;
  /** 把对方发给我的消息标记成已读 */
  markThreadRead(me: string, peer: string): Promise<number>;
  listDirectThreads(me: string): Promise<DirectThreadRecord[]>;
  countUnreadMessages(me: string): Promise<number>;
  countNewFollowers(me: string, since: number): Promise<number>;
  unreadFrom(me: string, peer: string): Promise<number>;

  createTable(record: TableRecord): Promise<void>;
  getTable(id: string): Promise<TableRecord | undefined>;
  /**
   * 乐观并发写入：只有库里的 seq 仍等于 expectedSeq 时才成功。
   * 返回 false 表示被别人抢先改了，调用方应重新读取后重试。
   */
  updateTable(write: TableWrite): Promise<boolean>;
  listTables(): Promise<TableRecord[]>;
  /** 按房间码找桌（6 位，大小写不敏感） */
  findTableByCode(code: string): Promise<TableRecord | undefined>;
  /** 随机加入：找一张等待中、还坐得下人的桌 */
  findOpenTable(gameId?: string): Promise<TableRecord | undefined>;
  /** 我参与的、还没结束的桌 */
  listMyTables(userId: string, limit: number): Promise<TableRecord[]>;
  /** 已到期需要代走的桌（只取 status='playing'） */
  listExpired(now: number): Promise<TableRecord[]>;

  /* ------------------------- 回放快照 / 公告 ------------------------- */
  /** 取 seq <= at 的最近一份快照 */
  latestSnapshot(
    tableId: string,
    at: number,
  ): Promise<{ seq: number; state: unknown } | undefined>;
  hasAckedVersion(userId: string, gameId: string, version: string): Promise<boolean>;
  ackVersion(userId: string, gameId: string, version: string): Promise<void>;

  /* ------------------------- 插件版本 ------------------------- */
  getGameVersion(gameId: string, version: string): Promise<GameVersionRecord | undefined>;
  listGameVersions(): Promise<GameVersionRecord[]>;
  /** 写入/更新一行版本记录；status 由激活流程单独维护，这里不动它 */
  upsertGameVersion(record: GameVersionRecord): Promise<void>;
  markVersionFailed(gameId: string, version: string, error: string): Promise<void>;
  /** 事务：把该游戏原 active 版本降级为 retired，再激活指定版本 */
  setActiveVersion(gameId: string, version: string): Promise<void>;
  /** 只改状态（禁用 / 恢复），不涉及 worker 加载 */
  setVersionStatus(
    gameId: string,
    version: string,
    status: GameVersionRecord['status'],
  ): Promise<void>;
  /** 还有进行中牌桌在用的版本（`gameId@version`），用于判断能否卸载 */
  listInUseVersions(): Promise<Set<string>>;

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
  /** 管理端：含被隐藏的行 */
  listAdminRatings(gameId: string, limit: number): Promise<AdminRatingRow[]>;
  /** 从某个游戏的榜上隐藏 / 恢复某人 */
  setRatingHidden(gameId: string, userId: string, hidden: boolean, by: string): Promise<boolean>;

  /* ------------------------- 备份 / 恢复 ------------------------- */
  exportAll(): Promise<Record<string, Record<string, unknown>[]>>;
  importAll(dump: Record<string, Record<string, unknown>[]>): Promise<Record<string, number>>;
  tableStatusCounts(): Promise<Record<string, number>>;

  /* ------------------------- 管理端 ------------------------- */
  listUsers(limit: number): Promise<AdminUserRecord[]>;
  setUserAdmin(id: string, isAdmin: boolean): Promise<void>;
  countAdmins(): Promise<number>;
}

/** 管理端看到的用户行：纯读模型，不含任何密码材料 */
export interface AdminUserRecord {
  id: string;
  name: string;
  tag: string;
  isAdmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  hasPassword: boolean;
  /** 令牌版本，>0 说明改过密码或退出过 */
  tokenVersion: number;
  /** 打完的局数 */
  games: number;
  wins: number;
}

/* ------------------------- 社交记录 ------------------------- */

export interface FollowGroupRecord {
  id: string;
  name: string;
  sort: number;
}

export interface FollowRow {
  id: string;
  name: string;
  tag: string;
  groupId: string | null;
  special: boolean;
  at: number;
}

export interface DirectMessageRecord {
  id: string;
  from: string;
  to: string;
  body: string;
  at: number;
  readAt: number | null;
}

export interface DirectThreadRecord {
  user: { id: string; name: string; tag: string };
  last: DirectMessageRecord | null;
  unread: number;
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
  status: 'pending' | 'active' | 'retired' | 'failed' | 'disabled';
  error: string | null;
  createdAt: number;
  activatedAt: number | null;
}

interface TableRow {
  id: string;
  code: string | null;
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
  mode: string;
  pace: string;
  turn_ms: number | null;
  window_start: number | null;
  window_end: number | null;
  timeout_streak: number;
  friendly: boolean;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: TableResult | null;
}

function toRecord(row: TableRow): TableRecord {
  return {
    id: row.id,
    code: row.code ?? null,
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
    mode: (row.mode === 'turnbased' ? 'turnbased' : 'realtime') as TableMode,
    pace: row.pace ?? 'normal',
    turnMs: row.turn_ms === null ? null : Number(row.turn_ms),
    windowStart: row.window_start === null ? null : Number(row.window_start),
    windowEnd: row.window_end === null ? null : Number(row.window_end),
    timeoutStreak: Number(row.timeout_streak ?? 0),
    friendly: Boolean(row.friendly),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    result: row.result ?? null,
  };
}

/** 常规查询列；密码哈希**不在**这里，只有 findUserWithSecret 才显式取 */
const USER_COLUMNS =
  'id, name, tag, created_at, is_admin, token_version, last_login_at, password_set_at, invite_code, invite_code_at, invited_by, social_seen_at';

interface UserRow {
  id: string;
  name: string;
  tag: string;
  created_at: number;
  is_admin: boolean;
  password_hash?: string | null;
  token_version: number;
  last_login_at: number | null;
  password_set_at: number | null;
  invite_code: string | null;
  invite_code_at: number | null;
  invited_by: string | null;
  social_seen_at: number | null;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    tag: row.tag,
    createdAt: Number(row.created_at),
    isAdmin: Boolean(row.is_admin),
    hasPassword: row.password_set_at !== null,
    tokenVersion: Number(row.token_version ?? 0),
    lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
    inviteCode: row.invite_code ?? null,
    inviteCodeAt: row.invite_code_at === null ? null : Number(row.invite_code_at),
    invitedBy: row.invited_by ?? null,
    socialSeenAt: Number(row.social_seen_at ?? 0),
  };
}

export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  async findUsersByName(name: string): Promise<UserRecord[]> {
    const rows = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE name = $1 ORDER BY created_at ASC`,
      [name],
    );
    return rows.map(toUser);
  }

  async findUserWithSecret(name: string, tag?: string): Promise<UserWithSecret | undefined> {
    const rows = await this.db.query<UserRow>(
      tag
        ? `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE name = $1 AND tag = $2 LIMIT 1`
        : `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE name = $1 LIMIT 1`,
      tag ? [name, tag] : [name],
    );
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: row.password_hash ?? null } : undefined;
  }

  async findUserSecretById(id: string): Promise<UserWithSecret | undefined> {
    const rows = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: row.password_hash ?? null } : undefined;
  }

  async createUser(
    name: string,
    passwordHash: string | null,
    invitedBy: string | null = null,
  ): Promise<UserRecord | null> {
    // 第一个注册的人自动成为管理员。is_admin 在 SQL 里算，省掉"先 count 再插"的竞态
    const now = Date.now();

    // 编号和邀请码都可能撞车，撞了就换一个重来——不能把注册搞失败。
    // 编号先发 4 位，连续撞说明这个号段挤了，再往 5 位、6 位放。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const digits = attempt < 8 ? 4 : attempt < 10 ? 5 : 6;
      try {
        const rows = await this.db.query<{ id: string }>(
          `INSERT INTO users
             (id, name, tag, created_at, is_admin, password_hash, password_set_at, last_login_at,
              invite_code, invite_code_at, invited_by)
           VALUES ($1, $2, $3, $4, NOT EXISTS (SELECT 1 FROM users), $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            randomUUID(),
            name,
            randomTag(digits),
            now,
            passwordHash,
            passwordHash ? now : null,
            now,
            randomCode(INVITE_CODE_LENGTH),
            now,
            invitedBy,
          ],
        );
        return (await this.getUser(rows[0]!.id)) ?? null;
      } catch (error) {
        // 23505 = 唯一约束冲突：编号或邀请码撞了，换一个再来
        if ((error as { code?: string }).code === '23505') continue;
        throw error;
      }
    }
    throw new Error('分配编号失败，请重试');
  }

  /** 检索人：昵称包含、或者编号以这些数字开头。给关注 / 私聊 / 管理端共用 */
  async searchUsers(query: string, limit: number): Promise<UserRecord[]> {
    const text = query.trim();
    if (!text) return [];

    // 「张三#4821」整串丢进来也能查到
    const [rawName, rawTag] = text.includes('#') ? text.split('#') : [text, ''];
    const exactTag = (rawTag ?? '').trim();

    const rows = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE position(lower($1) in lower(name)) > 0
           OR ($2 <> '' AND tag = $2)
        ORDER BY (lower(name) = lower($1)) DESC, created_at ASC
        LIMIT $3`,
      [rawName, exactTag, limit],
    );
    return rows.map(toUser);
  }

  async getUsersByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ANY($1::text[])`,
      [ids],
    );
    return rows.map(toUser);
  }

  async markSocialSeen(id: string): Promise<void> {
    await this.db.execute('UPDATE users SET social_seen_at = $2 WHERE id = $1', [id, Date.now()]);
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const rows = await this.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? toUser(row) : undefined;
  }

  async countUsers(): Promise<number> {
    const rows = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    return Number(rows[0]?.n ?? 0);
  }

  async findUserByInviteCode(code: string): Promise<UserRecord | undefined> {
    const rows = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE invite_code = $1`,
      [code],
    );
    const row = rows[0];
    return row ? toUser(row) : undefined;
  }

  /**
   * 生成一次个人邀请码。
   *
   * 「只能生成一次」不是靠"先查再写"，而是靠 UPDATE 的 WHERE invite_code IS NULL：
   * 两个请求同时点，也只会有一个真的写进去，另一个拿到 0 行返回 null。
   */
  async setInviteCode(id: string): Promise<UserRecord | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomCode(INVITE_CODE_LENGTH);
      if (await this.findUserByInviteCode(code)) continue;

      try {
        const rows = await this.db.query<{ id: string }>(
          `UPDATE users SET invite_code = $2, invite_code_at = $3
             WHERE id = $1 AND invite_code IS NULL
           RETURNING id`,
          [id, code, Date.now()],
        );
        if (rows.length === 0) return null;
        return (await this.getUser(id)) ?? null;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') continue;
        throw error;
      }
    }
    throw new Error('生成邀请码失败，请重试');
  }

  async listInvited(
    userId: string,
    limit = 100,
  ): Promise<{ id: string; name: string; tag: string; createdAt: number }[]> {
    const rows = await this.db.query<{ id: string; name: string; tag: string; created_at: number }>(
      'SELECT id, name, tag, created_at FROM users WHERE invited_by = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      name: displayName(row),
      tag: row.tag,
      createdAt: Number(row.created_at),
    }));
  }

  async setPassword(id: string, passwordHash: string): Promise<number> {
    const rows = await this.db.query<{ token_version: number }>(
      `UPDATE users SET password_hash = $2, password_set_at = $3, token_version = token_version + 1
        WHERE id = $1 RETURNING token_version`,
      [id, passwordHash, Date.now()],
    );
    return Number(rows[0]?.token_version ?? 0);
  }

  async bumpTokenVersion(id: string): Promise<number> {
    const rows = await this.db.query<{ token_version: number }>(
      'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
      [id],
    );
    return Number(rows[0]?.token_version ?? 0);
  }

  async touchLogin(id: string): Promise<void> {
    await this.db.execute('UPDATE users SET last_login_at = $2 WHERE id = $1', [id, Date.now()]);
  }

  async createTable(record: TableRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO tables
         (id, code, game_id, game_version, host_id, status, players, max_players, options,
          state, seq, log, deadline_at, created_at, started_at, finished_at, result,
          mode, pace, turn_ms, window_start, window_end, timeout_streak, friendly)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17::jsonb,
               $18,$19,$20,$21,$22,$23,$24)`,
      [
        record.id,
        record.code,
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
        record.result === null ? null : JSON.stringify(record.result),
        record.mode,
        record.pace,
        record.turnMs,
        record.windowStart,
        record.windowEnd,
        record.timeoutStreak,
        record.friendly,
      ],
    );
  }

  async getTable(id: string): Promise<TableRecord | undefined> {
    const rows = await this.db.query<TableRow>('SELECT * FROM tables WHERE id = $1', [id]);
    const row = rows[0];
    return row ? toRecord(row) : undefined;
  }

  async updateTable(write: TableWrite): Promise<boolean> {
    const { table, expectedSeq, log, snapshot } = write;

    return this.db.transaction(async (tx) => {
      const updated = await tx.query<{ seq: number }>(
        `UPDATE tables SET
           players = $1::jsonb, status = $2, state = $3::jsonb, seq = $4, log = $5::jsonb,
           deadline_at = $6, started_at = $7, finished_at = $8, result = $9::jsonb,
           host_id = $12, timeout_streak = $13
         WHERE id = $10 AND seq = $11
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
          table.result === null ? null : JSON.stringify(table.result),
          table.id,
          expectedSeq,
          table.hostId,
          table.timeoutStreak,
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

      if (snapshot) {
        await tx.execute(
          `INSERT INTO match_snapshots (table_id, seq, state, state_hash, created_at)
           VALUES ($1,$2,$3::jsonb,$4,$5)
           ON CONFLICT (table_id, seq) DO NOTHING`,
          [table.id, table.seq, JSON.stringify(snapshot.state), snapshot.hash, Date.now()],
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

  async findTableByCode(code: string): Promise<TableRecord | undefined> {
    // 房间码不区分大小写：念出来的东西不该逼人回忆是大写还是小写
    const rows = await this.db.query<TableRow>(
      'SELECT * FROM tables WHERE upper(code) = upper($1) ORDER BY created_at DESC LIMIT 1',
      [code],
    );
    const row = rows[0];
    return row ? toRecord(row) : undefined;
  }

  async findOpenTable(gameId?: string): Promise<TableRecord | undefined> {
    // 只找还能坐人的等待中牌桌；老桌（code 为 null）也算，照样能坐下
    const rows = await this.db.query<TableRow>(
      `SELECT * FROM tables
        WHERE status = 'lobby'
          AND jsonb_array_length(players) < max_players
          AND ($1::text IS NULL OR game_id = $1)
        ORDER BY created_at ASC
        LIMIT 1`,
      [gameId ?? null],
    );
    const row = rows[0];
    return row ? toRecord(row) : undefined;
  }

  async listMyTables(userId: string, limit: number): Promise<TableRecord[]> {
    const rows = await this.db.query<TableRow>(
      `SELECT * FROM tables
        WHERE status <> 'finished' AND players @> $1::jsonb
        ORDER BY created_at DESC
        LIMIT $2`,
      [JSON.stringify([{ id: userId }]), limit],
    );
    return rows.map(toRecord);
  }

  async latestSnapshot(
    tableId: string,
    at: number,
  ): Promise<{ seq: number; state: unknown } | undefined> {
    const rows = await this.db.query<{ seq: number; state: unknown }>(
      `SELECT seq, state FROM match_snapshots
        WHERE table_id = $1 AND seq <= $2
        ORDER BY seq DESC LIMIT 1`,
      [tableId, at],
    );
    const row = rows[0];
    return row ? { seq: Number(row.seq), state: row.state } : undefined;
  }

  async hasAckedVersion(userId: string, gameId: string, version: string): Promise<boolean> {
    const rows = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM version_acks WHERE user_id = $1 AND game_id = $2 AND version = $3',
      [userId, gameId, version],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async ackVersion(userId: string, gameId: string, version: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO version_acks (user_id, game_id, version, acked_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [userId, gameId, version, Date.now()],
    );
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

  async setVersionStatus(
    gameId: string,
    version: string,
    status: GameVersionRecord['status'],
  ): Promise<void> {
    await this.db.execute('UPDATE game_versions SET status = $3 WHERE game_id = $1 AND version = $2', [
      gameId,
      version,
      status,
    ]);
  }

  /* ------------------------- 聊天 / 战绩 ------------------------- */  async listInUseVersions(): Promise<Set<string>> {
    const rows = await this.db.query<{ game_id: string; game_version: string }>(
      `SELECT DISTINCT game_id, game_version FROM tables WHERE status <> 'finished'`,
    );
    return new Set(rows.map((row) => `${row.game_id}@${row.game_version}`));
  }

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
      tag: string;
      rating: number;
      games: number;
    }>(
      `SELECT r.user_id, u.name, u.tag, r.rating, r.games
         FROM ratings r JOIN users u ON u.id = r.user_id
        WHERE r.game_id = $1 AND NOT r.hidden
        ORDER BY r.rating DESC, r.games DESC
        LIMIT $2`,
      [gameId, limit],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      name: displayName(row),
      rating: Number(row.rating),
      games: Number(row.games),
    }));
  }

  /** 管理端：包含被隐藏的行，用于"谁在这个榜上、谁被藏了" */
  async listAdminRatings(gameId: string, limit: number): Promise<AdminRatingRow[]> {
    const rows = await this.db.query<{
      user_id: string;
      name: string;
      tag: string;
      rating: number;
      games: number;
      hidden: boolean;
    }>(
      `SELECT r.user_id, u.name, u.tag, r.rating, r.games, r.hidden
         FROM ratings r JOIN users u ON u.id = r.user_id
        WHERE r.game_id = $1
        ORDER BY r.hidden ASC, r.rating DESC, r.games DESC
        LIMIT $2`,
      [gameId, limit],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      name: displayName(row),
      rating: Number(row.rating),
      games: Number(row.games),
      hidden: Boolean(row.hidden),
    }));
  }

  async setRatingHidden(
    gameId: string,
    userId: string,
    hidden: boolean,
    by: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ user_id: string }>(
      `UPDATE ratings
          SET hidden = $3::boolean,
              hidden_by = CASE WHEN $3::boolean THEN $4::text ELSE NULL END,
              hidden_at = CASE WHEN $3::boolean THEN $4::bigint ELSE NULL END
        WHERE game_id = $1 AND user_id = $2
      RETURNING user_id`,
      [gameId, userId, hidden, hidden ? Date.now() : null],
    );
    return rows.length > 0;
  }

  /* ------------------------- 关注 / 拉黑 ------------------------- */

  async listFollowGroups(userId: string): Promise<FollowGroupRecord[]> {
    await this.ensureDefaultGroup(userId);
    const rows = await this.db.query<{ id: string; name: string; sort: number }>(
      `SELECT id, name, sort FROM follow_groups
        WHERE user_id = $1 ORDER BY sort ASC, created_at ASC`,
      [userId],
    );
    return rows.map((row) => ({ id: row.id, name: row.name, sort: Number(row.sort) }));
  }

  /** 没有分组的人第一次用社交功能时自动给一个，省得前端到处判空 */
  private async ensureDefaultGroup(userId: string): Promise<string> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM follow_groups WHERE user_id = $1 ORDER BY sort ASC, created_at ASC LIMIT 1`,
      [userId],
    );
    if (rows[0]) return rows[0].id;

    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO follow_groups (id, user_id, name, sort, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, userId, '默认分组', 0, Date.now()],
    );
    return id;
  }

  async createFollowGroup(userId: string, name: string): Promise<FollowGroupRecord> {
    const id = randomUUID();
    const rows = await this.db.query<{ sort: number }>(
      `SELECT COALESCE(max(sort), 0) + 1 AS sort FROM follow_groups WHERE user_id = $1`,
      [userId],
    );
    const sort = Number(rows[0]?.sort ?? 1);
    await this.db.execute(
      `INSERT INTO follow_groups (id, user_id, name, sort, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, userId, name, sort, Date.now()],
    );
    return { id, name, sort };
  }

  async renameFollowGroup(userId: string, groupId: string, name: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE follow_groups SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id`,
      [groupId, userId, name],
    );
    return rows.length > 0;
  }

  async deleteFollowGroup(userId: string, groupId: string): Promise<boolean> {
    const defaultId = await this.ensureDefaultGroup(userId);
    // 默认分组不能删：删了之后别人的关注关系无处可放
    if (groupId === defaultId) return false;

    return this.db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE follows SET group_id = $3 WHERE follower_id = $1 AND group_id = $2`,
        [userId, groupId, defaultId],
      );
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM follow_groups WHERE id = $1 AND user_id = $2 RETURNING id`,
        [groupId, userId],
      );
      return rows.length > 0;
    });
  }

  private async followRows(where: 'f.follower_id' | 'f.followee_id', userId: string): Promise<FollowRow[]> {
    const rows = await this.db.query<{
      id: string;
      name: string;
      tag: string;
      group_id: string | null;
      special: boolean;
      created_at: number;
    }>(
      `SELECT u.id, u.name, u.tag, f.group_id, f.special, f.created_at
         FROM follows f JOIN users u
           ON u.id = ${where === 'f.follower_id' ? 'f.followee_id' : 'f.follower_id'}
        WHERE ${where} = $1
        ORDER BY f.special DESC, f.created_at DESC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: displayName(row),
      tag: row.tag,
      groupId: row.group_id,
      special: Boolean(row.special),
      at: Number(row.created_at),
    }));
  }

  async listFollowing(userId: string): Promise<FollowRow[]> {
    return this.followRows('f.follower_id', userId);
  }

  async listFollowers(userId: string): Promise<FollowRow[]> {
    return this.followRows('f.followee_id', userId);
  }

  async follow(
    followerId: string,
    followeeId: string,
    groupId: string | null,
    special: boolean,
  ): Promise<FollowRow> {
    const group = groupId ?? (await this.ensureDefaultGroup(followerId));
    await this.db.execute(
      `INSERT INTO follows (follower_id, followee_id, group_id, special, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (follower_id, followee_id) DO UPDATE
         SET group_id = EXCLUDED.group_id, special = EXCLUDED.special`,
      [followerId, followeeId, group, special, Date.now()],
    );

    const rows = await this.db.query<{
      id: string;
      name: string;
      tag: string;
      group_id: string | null;
      special: boolean;
      created_at: number;
    }>(
      `SELECT u.id, u.name, u.tag, f.group_id, f.special, f.created_at
         FROM follows f JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = $1 AND f.followee_id = $2`,
      [followerId, followeeId],
    );
    const row = rows[0]!;
    return {
      id: row.id,
      name: displayName(row),
      tag: row.tag,
      groupId: row.group_id,
      special: Boolean(row.special),
      at: Number(row.created_at),
    };
  }

  async unfollow(followerId: string, followeeId: string): Promise<void> {
    await this.db.execute('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [
      followerId,
      followeeId,
    ]);
  }

  async updateFollow(
    followerId: string,
    followeeId: string,
    patch: { groupId?: string | null; special?: boolean },
  ): Promise<FollowRow | undefined> {
    const sets: string[] = [];
    const values: unknown[] = [followerId, followeeId];
    if (patch.groupId !== undefined) {
      values.push(patch.groupId ?? (await this.ensureDefaultGroup(followerId)));
      sets.push(`group_id = $${values.length}`);
    }
    if (patch.special !== undefined) {
      values.push(patch.special);
      sets.push(`special = $${values.length}`);
    }
    if (sets.length === 0) return undefined;

    const updated = await this.db.query<{ followee_id: string }>(
      `UPDATE follows SET ${sets.join(', ')}
        WHERE follower_id = $1 AND followee_id = $2 RETURNING followee_id`,
      values,
    );
    if (updated.length === 0) return undefined;

    const rows = await this.db.query<{
      id: string;
      name: string;
      tag: string;
      group_id: string | null;
      special: boolean;
      created_at: number;
    }>(
      `SELECT u.id, u.name, u.tag, f.group_id, f.special, f.created_at
         FROM follows f JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = $1 AND f.followee_id = $2`,
      [followerId, followeeId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      name: displayName(row),
      tag: row.tag,
      groupId: row.group_id,
      special: Boolean(row.special),
      at: Number(row.created_at),
    };
  }

  async countFollows(userId: string): Promise<{ following: number; followers: number }> {
    const rows = await this.db.query<{ following: number; followers: number }>(
      `SELECT
         (SELECT count(*)::int FROM follows WHERE follower_id = $1) AS following,
         (SELECT count(*)::int FROM follows WHERE followee_id = $1) AS followers`,
      [userId],
    );
    return {
      following: Number(rows[0]?.following ?? 0),
      followers: Number(rows[0]?.followers ?? 0),
    };
  }

  async listBlocks(userId: string): Promise<{ id: string; name: string; tag: string; at: number }[]> {
    const rows = await this.db.query<{ id: string; name: string; tag: string; created_at: number }>(
      `SELECT u.id, u.name, u.tag, b.created_at
         FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: displayName(row),
      tag: row.tag,
      at: Number(row.created_at),
    }));
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1,$2,$3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockerId, blockedId, Date.now()],
    );
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.db.execute('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
      blockerId,
      blockedId,
    ]);
  }

  async hasBlockBetween(a: string, b: string): Promise<boolean> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [a, b],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async blockInfo(
    me: string,
    other: string,
  ): Promise<{ iBlocked: boolean; blockedMe: boolean }> {
    const rows = await this.db.query<{ blocker_id: string }>(
      `SELECT blocker_id FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [me, other],
    );
    return {
      iBlocked: rows.some((row) => row.blocker_id === me),
      blockedMe: rows.some((row) => row.blocker_id === other),
    };
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    const rows = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM follows WHERE follower_id = $1 AND followee_id = $2',
      [followerId, followeeId],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async getFollow(followerId: string, followeeId: string): Promise<FollowRow | undefined> {
    const rows = await this.db.query<{
      id: string;
      name: string;
      tag: string;
      group_id: string | null;
      special: boolean;
      created_at: number;
    }>(
      `SELECT u.id, u.name, u.tag, f.group_id, f.special, f.created_at
         FROM follows f JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = $1 AND f.followee_id = $2`,
      [followerId, followeeId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      name: displayName(row),
      tag: row.tag,
      groupId: row.group_id,
      special: Boolean(row.special),
      at: Number(row.created_at),
    };
  }

  /* ------------------------- 私聊 ------------------------- */

  async saveDirectMessage(
    from: string,
    to: string,
    body: string,
    now: number,
  ): Promise<DirectMessageRecord> {
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO direct_messages (id, sender_id, recipient_id, body, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, from, to, body, now],
    );
    return { id, from, to, body, at: now, readAt: null };
  }

  async listDirectMessages(
    me: string,
    peer: string,
    limit: number,
  ): Promise<DirectMessageRecord[]> {
    const rows = await this.db.query<{
      id: string;
      sender_id: string;
      recipient_id: string;
      body: string;
      created_at: number;
      read_at: number | null;
    }>(
      `SELECT id, sender_id, recipient_id, body, created_at, read_at
         FROM direct_messages
        WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
        ORDER BY created_at DESC
        LIMIT $3`,
      [me, peer, limit],
    );
    return rows.reverse().map((row) => ({
      id: row.id,
      from: row.sender_id,
      to: row.recipient_id,
      body: row.body,
      at: Number(row.created_at),
      readAt: row.read_at === null ? null : Number(row.read_at),
    }));
  }

  async markThreadRead(me: string, peer: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE direct_messages SET read_at = $3
        WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL
      RETURNING id`,
      [me, peer, Date.now()],
    );
    return rows.length;
  }

  async listDirectThreads(me: string): Promise<DirectThreadRecord[]> {
    const rows = await this.db.query<{
      peer: string;
      name: string;
      tag: string;
      id: string | null;
      sender_id: string | null;
      recipient_id: string | null;
      body: string | null;
      created_at: number | null;
      read_at: number | null;
      unread: number;
    }>(
      `WITH pairs AS (
         SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS peer,
                max(created_at) AS last_at
           FROM direct_messages
          WHERE sender_id = $1 OR recipient_id = $1
          GROUP BY peer
       )
       SELECT p.peer, u.name, u.tag,
              m.id, m.sender_id, m.recipient_id, m.body, m.created_at, m.read_at,
              COALESCE(unread.n, 0)::int AS unread
         FROM pairs p
         JOIN users u ON u.id = p.peer
         LEFT JOIN LATERAL (
           SELECT id, sender_id, recipient_id, body, created_at, read_at
             FROM direct_messages
            WHERE (sender_id = $1 AND recipient_id = p.peer)
               OR (sender_id = p.peer AND recipient_id = $1)
            ORDER BY created_at DESC LIMIT 1
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS n FROM direct_messages
            WHERE sender_id = p.peer AND recipient_id = $1 AND read_at IS NULL
         ) unread ON true
        ORDER BY p.last_at DESC
        LIMIT 100`,
      [me],
    );

    return rows.map((row) => ({
      user: { id: row.peer, name: displayName(row), tag: row.tag },
      last: row.id
        ? {
            id: row.id,
            from: row.sender_id!,
            to: row.recipient_id!,
            body: row.body!,
            at: Number(row.created_at),
            readAt: row.read_at === null ? null : Number(row.read_at),
          }
        : null,
      unread: Number(row.unread ?? 0),
    }));
  }

  async countUnreadMessages(me: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM direct_messages WHERE recipient_id = $1 AND read_at IS NULL',
      [me],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async unreadFrom(me: string, peer: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM direct_messages
        WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
      [me, peer],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async countNewFollowers(me: string, since: number): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM follows WHERE followee_id = $1 AND created_at > $2`,
      [me, since],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /* ------------------------- 备份 / 恢复 ------------------------- */

  async exportAll(): Promise<Record<string, Record<string, unknown>[]>> {
    const dump: Record<string, Record<string, unknown>[]> = {};
    for (const table of DUMP_TABLES) {
      dump[table] = await this.db.query(`SELECT * FROM ${table}`);
    }
    return dump;
  }

  async importAll(
    dump: Record<string, Record<string, unknown>[]>,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    // 先清空（子表在前，虽然目前没有外键约束）
    for (const table of [...DUMP_TABLES].reverse()) {
      await this.db.execute(`DELETE FROM ${table}`);
    }

    for (const table of DUMP_TABLES) {
      const rows = dump[table] ?? [];
      for (const row of rows) {
        const columns = Object.keys(row);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        const values = columns.map((column) => {
          const value = row[column];
          // jsonb 列直接传对象，驱动序列化行为不一致，统一转成字符串更稳
          return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
        });
        await this.db.execute(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
          values,
        );
      }
      counts[table] = rows.length;
    }

    return counts;
  }

  async tableStatusCounts(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM tables GROUP BY status',
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  /* ------------------------- 管理端 ------------------------- */

  async listUsers(limit: number): Promise<AdminUserRecord[]> {
    const rows = await this.db.query<{
      id: string;
      name: string;
      tag: string;
      is_admin: boolean;
      created_at: number;
      last_login_at: number | null;
      password_set_at: number | null;
      token_version: number;
      games: number;
      wins: number;
    }>(
      `SELECT u.id, u.name, u.tag, u.is_admin, u.created_at, u.last_login_at, u.password_set_at,
              u.token_version,
              count(m.table_id)::int AS games,
              COALESCE(sum(CASE WHEN m.is_win THEN 1 ELSE 0 END), 0)::int AS wins
         FROM users u
         LEFT JOIN match_results m ON m.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at ASC
        LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: row.id,
      name: displayName(row),
      tag: row.tag,
      isAdmin: Boolean(row.is_admin),
      createdAt: Number(row.created_at),
      lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
      hasPassword: row.password_set_at !== null,
      tokenVersion: Number(row.token_version ?? 0),
      games: Number(row.games),
      wins: Number(row.wins),
    }));
  }

  async setUserAdmin(id: string, isAdmin: boolean): Promise<void> {
    await this.db.execute('UPDATE users SET is_admin = $2 WHERE id = $1', [id, isAdmin]);
  }

  async countAdmins(): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM users WHERE is_admin',
    );
    return Number(rows[0]?.n ?? 0);
  }
}

/** 备份时按这个顺序导出；恢复时按反序清空 */
const DUMP_TABLES = [
  'users',
  'game_versions',
  'tables',
  'match_actions',
  'match_snapshots',
  'table_chat',
  'match_results',
  'ratings',
  'version_acks',
  'follow_groups',
  'follows',
  'blocks',
  'direct_messages',
] as const;

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
