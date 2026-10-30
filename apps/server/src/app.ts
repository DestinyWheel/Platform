import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { AuthError, bearerFrom, signToken, verifyToken } from './auth.js';
import { checkPasswordInput, generatePassword, hashPassword, verifyPassword } from './password.js';
import { EventBus } from './bus.js';
import { createDb, migrate, type Db } from './db/index.js';
import { Limiters, RateLimiter, RateLimitExceeded, checkLimit } from './limits.js';
import { Metrics } from './metrics.js';
import { PluginHost } from './pluginHost/host.js';
import { publishDirectory, publishLocalGames } from './pluginHost/publish.js';
import { PluginError } from './pluginHost/types.js';
import { extractPackage } from './pluginHost/upload.js';
import { ServiceError, TableService } from './service.js';
import { PgStore, type UserRecord } from './store.js';
import { Presence } from './presence.js';
import { registerWebSocket } from './ws.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 备份保留份数：超过就删最旧的，免得盘被慢慢吃满 */
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14) || 14);

interface BackupEntry {
  name: string;
  bytes: number;
  createdAt: number;
}

async function listBackups(dir: string): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json.gz')) continue;
    try {
      const info = await stat(path.join(dir, name));
      entries.push({ name, bytes: info.size, createdAt: info.mtimeMs });
    } catch {
      // 刚好被别的进程删掉，跳过
    }
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

async function pruneBackups(dir: string): Promise<string[]> {
  const stale = (await listBackups(dir)).slice(BACKUP_KEEP);
  const removed: string[] = [];
  for (const entry of stale) {
    try {
      await unlink(path.join(dir, entry.name));
      removed.push(entry.name);
    } catch {
      // 删不掉就留着，下次再试，不能因为清理失败让备份本身失败
    }
  }
  return removed;
}

/**
 * 昵称就是登录名，所以长度和字符要收一收：
 * - 去掉首尾空格后 2–20 字
 * - 不允许控制字符（会把日志和终端搞乱）
 */
const nameField = z
  .string()
  .trim()
  .min(2, '昵称至少 2 个字符')
  .max(20, '昵称最多 20 个字符')
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), '昵称里有非法字符');

const credentialsSchema = z.object({
  name: nameField,
  // 登录时不校验强度，否则将来收紧规则会把老用户锁在门外；只在注册/改密时校验
  password: z.string().min(1, '请输入密码').max(200, '密码太长了'),
  remember: z.boolean().optional(),
});

const registerSchema = credentialsSchema.extend({
  confirm: z.string().optional(),
  code: z.string().optional(),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入原密码').max(200),
  newPassword: z.string().min(1, '请输入新密码').max(200),
});

/** 邀请码：设了 REGISTER_CODE 就变成"凭码注册"，不设就是开放注册 */
const REGISTER_CODE = process.env.REGISTER_CODE?.trim() || null;

const createTableSchema = z.object({
  gameId: z.string().min(1),
  maxPlayers: z.number().int().optional(),
  options: z.record(z.unknown()).optional(),
});

export interface AppOptions {
  /** 注入外部数据库（测试用）；不传则按 DATABASE_URL / PGlite 自动创建 */
  db?: Db;
  /** 插件产物目录；默认 <repo>/storage/plugins */
  storageRoot?: string;
  /** 前端构建产物目录；默认 <repo>/apps/web/dist，存在就直接由本进程托管 */
  webRoot?: string;
  /** 启动时把 games/ 下的源码发一遍（开发用）；默认开，设 AUTO_PUBLISH_GAMES=0 关 */
  autoPublish?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // 每个请求一个 id，日志里能串起一次完整调用
    genReqId: () => randomUUID(),
    // 插件上传包可能几百 KB，放宽一点
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  const ownsDb = options.db === undefined;
  const db = options.db ?? (await createDb());
  await migrate(db);

  const limits = new Limiters();
  const metrics = new Metrics();
  /** 兜底：按 IP 的粗粒度限流，防止有人在别的接口上刷 */
  const ipLimiter = new RateLimiter(300, 5);

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    // 静态插件产物和健康检查不算
    if (url.startsWith('/plugins/') || url === '/api/health' || url === '/api/metrics') return;

    const result = ipLimiter.take(request.ip);
    if (!result.ok) {
      metrics.inc('http.rate_limited');
      return reply
        .code(429)
        .header('retry-after', Math.ceil(result.retryAfterMs / 1000))
        .send({ code: 'rate_limited', message: '请求太频繁了，慢一点' });
    }
  });

  app.addHook('onResponse', async (_request, reply) => {
    metrics.inc('http.requests');
    if (reply.statusCode >= 500) metrics.inc('http.errors');
    if (reply.statusCode === 401) metrics.inc('http.unauthorized');
    if (reply.statusCode === 429) metrics.inc('http.rate_limited');
  });

  const storageRoot = path.resolve(
    options.storageRoot ?? process.env.PLUGIN_DIR ?? path.join(REPO_ROOT, 'storage', 'plugins'),
  );
  await mkdir(storageRoot, { recursive: true });

  const store = new PgStore(db);
  const host = new PluginHost(store, storageRoot);
  const bus = new EventBus();
  const presence = new Presence();
  const service = new TableService(store, host, bus, presence, (error, tableId) => {
    app.log.error({ err: error, tableId }, '超时处理失败');
  });

  await host.refresh();

  const autoPublish = options.autoPublish ?? process.env.AUTO_PUBLISH_GAMES !== '0';
  if (autoPublish) {
    await publishLocalGames(
      { store, host, storageRoot, log: (message) => app.log.info(message) },
      path.join(REPO_ROOT, 'games'),
    );
    await host.refresh();
  }

  /** 卸载"既不是 active、也没有进行中牌桌在用"的版本 worker */
  const collectGarbage = async (): Promise<string[]> => {
    const inUse = await store.listInUseVersions();
    return host.releaseIdle(inUse);
  };

  /* ---------------------- 插件产物静态托管 ---------------------- */
  // URL 里带版本号，所以可以放心长缓存：发新版换 URL，老桌继续用老 URL
  await app.register(fastifyStatic, {
    root: storageRoot,
    prefix: '/plugins/',
    setHeaders: (response) => {
      response.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });

  /* ---------------------- 前端产物静态托管 ---------------------- */
  // 有就托管，没有就通知运维去 build，仅此而已。
  // 注意：API / WS / 插件产物不参与回落，否则打错的接口路径会返回 index.html，
  // 客户端拿到一坨 HTML 去 JSON.parse，报错会离谱到查不出原因。
  const webRoot = path.resolve(
    options.webRoot ?? process.env.WEB_DIR ?? path.join(REPO_ROOT, 'apps', 'web', 'dist'),
  );
  const indexFile = path.join(webRoot, 'index.html');
  if (existsSync(indexFile)) {
    const indexHtml = await readFile(indexFile, 'utf8');
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      decorateReply: false,
      maxAge: '1h',
    });

    app.setNotFoundHandler((request, reply) => {
      const url = request.url;
      if (url.startsWith('/api') || url.startsWith('/ws') || url.startsWith('/plugins')) {
        return reply.code(404).send({ code: 'not_found', message: '接口不存在' });
      }
      // 前端是 hash 路由，任何非静态路径都回 index.html
      return reply.type('text/html; charset=utf-8').send(indexHtml);
    });
  } else {
    app.log.warn(
      `前端产物不存在（${indexFile}），只提供 API。开发时用 pnpm dev，上线前先跑 pnpm build`,
    );
  }

  const requireUser = async (request: FastifyRequest): Promise<UserRecord> => {
    const auth = verifyToken(bearerFrom(request.headers.authorization));
    if (!auth) throw new ServiceError('unauthorized', '请先登录');
    const user = await store.getUser(auth.id);
    if (!user) throw new ServiceError('unauthorized', '用户不存在，请重新登录');
    // 改密码 / 退出登录会把 token_version +1，这里一比就让旧令牌失效
    if (auth.ver !== user.tokenVersion) {
      throw new ServiceError('unauthorized', '登录状态已失效，请重新登录');
    }
    return user;
  };

  const requireAdmin = async (request: FastifyRequest): Promise<UserRecord> => {
    const user = await requireUser(request);
    if (!user.isAdmin) throw new ServiceError('forbidden', '需要管理员权限');
    return user;
  };

  /* ----------------------------- REST ----------------------------- */

  app.get('/api/health', async () => ({
    ok: true,
    db: db.kind,
    uptime: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    workers: host.loadedVersions().length,
    tables: await store.tableStatusCounts(),
  }));

  /** Prometheus 风格指标，管理员可见 */
  app.get('/api/metrics', async (request, reply) => {
    await requireAdmin(request);
    const tables = await store.tableStatusCounts();
    const memory = process.memoryUsage();

    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.toPrometheus({
      uptime_seconds: Math.round(process.uptime()),
      memory_rss_bytes: memory.rss,
      memory_heap_used_bytes: memory.heapUsed,
      workers_loaded: host.loadedVersions().length,
      tables_playing: tables.playing ?? 0,
      tables_lobby: tables.lobby ?? 0,
      tables_finished: tables.finished ?? 0,
      limit_buckets: ipLimiter.size,
    });
  });

  /** 备份：整库导出成 gzip JSON，落到 storage/backups/；只保留最近 N 份 */
  app.post('/api/admin/backup', async (request) => {
    await requireAdmin(request);
    const dump = await store.exportAll();
    const payload = { version: 1, createdAt: Date.now(), db: db.kind, tables: dump };

    const backupDir = path.join(path.dirname(storageRoot), 'backups');
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `${stamp}.json.gz`);
    const buffer = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    await writeFile(file, buffer);

    const pruned = await pruneBackups(backupDir);

    metrics.inc('backup.created');
    return {
      file,
      bytes: buffer.length,
      pruned,
      counts: Object.fromEntries(Object.entries(dump).map(([table, rows]) => [table, rows.length])),
    };
  });

  /** 备份列表（管理后台展示用），顺带告诉运维总共占了多少盘 */
  app.get('/api/admin/backups', async (request) => {
    await requireAdmin(request);
    const backupDir = path.join(path.dirname(storageRoot), 'backups');
    const files = await listBackups(backupDir);
    return {
      keep: BACKUP_KEEP,
      bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
      files: files.map(({ name, bytes, createdAt }) => ({ name, bytes, createdAt })),
    };
  });

  /* ------------------------------ 账号 ------------------------------ */

  const publicUser = (user: UserRecord): { id: string; name: string; isAdmin: boolean } => ({
    id: user.id,
    name: user.name,
    isAdmin: user.isAdmin,
  });

  const issue = (
    user: UserRecord,
    remember: boolean,
    tokenVersion = user.tokenVersion,
  ): { token: string; user: { id: string; name: string; isAdmin: boolean } } => ({
    token: signToken(user, { remember, tokenVersion }),
    user: publicUser(user),
  });

  /** 登录页要知道"要不要填邀请码"，这一步必须在未登录时就能问 */
  app.get('/api/auth/config', async () => ({
    registration: REGISTER_CODE ? 'code' : 'open',
    /** 老账号可以自助认领密码；管理员补完密码后可以设 AUTH_ALLOW_CLAIM=0 关掉 */
    allowClaim: process.env.AUTH_ALLOW_CLAIM !== '0',
  }));

  app.post('/api/auth/register', async (request) => {
    checkLimit(limits.login.take(request.ip));
    const input = registerSchema.parse(request.body);

    if (REGISTER_CODE && input.code !== REGISTER_CODE) {
      throw new AuthError('bad_code', '邀请码不对', 403);
    }
    if (input.confirm !== undefined && input.confirm !== input.password) {
      throw new AuthError('password_mismatch', '两次输入的密码不一样', 400);
    }
    const problem = checkPasswordInput(input.password, input.name);
    if (problem) throw new AuthError('weak_password', problem, 400);

    const hash = await hashPassword(input.password);
    const user = await store.createUser(input.name, hash);
    if (!user) throw new AuthError('name_taken', '这个昵称已经被占用了', 409);

    request.log.info({ userId: user.id, name: user.name, isAdmin: user.isAdmin }, '注册');
    metrics.inc('auth.registered');
    return issue(user, input.remember ?? false);
  });

  app.post('/api/auth/login', async (request) => {
    checkLimit(limits.login.take(request.ip));
    const input = credentialsSchema.parse(request.body);

    // 按账号名限流：IP 限流挡不住换 IP 撞同一个账号
    const failureKey = input.name.toLowerCase();

    const record = await store.findUserWithSecret(input.name);
    if (!record) throw new AuthError('invalid_credentials', '昵称或密码不对', 401);

    // 老账号（旧版昵称登录留下的）还没密码，引导前端走"认领"。
    // 这一步放在失败计数之前：用户还没输密码，不该让他先被锁一次
    if (!record.hasPassword) {
      throw new AuthError('password_not_set', '这个账号还没设密码，先设一个', 409);
    }

    checkLimit(limits.loginFailure.take(failureKey));
    if (!(await verifyPassword(input.password, record.passwordHash))) {
      metrics.inc('auth.login_failed');
      throw new AuthError('invalid_credentials', '昵称或密码不对', 401);
    }

    limits.loginFailure.reset(failureKey);
    await store.touchLogin(record.id);
    metrics.inc('auth.login');
    return issue(record, input.remember ?? false);
  });

  /**
   * 认领：给"旧版昵称登录"创建的账号补一个密码。
   *
   * 这确实意味着知道昵称的人可以先占位——但那正是升级前整个平台的安全水位，
   * 不算退步。管理员把自己关心的账号都设上密码之后，AUTH_ALLOW_CLAIM=0 关掉即可。
   */
  app.post('/api/auth/claim', async (request) => {
    checkLimit(limits.login.take(request.ip));
    if (process.env.AUTH_ALLOW_CLAIM === '0') {
      throw new AuthError('claim_disabled', '认领通道已关闭，请联系管理员重置密码', 403);
    }
    const input = credentialsSchema.parse(request.body);

    const record = await store.findUserWithSecret(input.name);
    if (!record || record.hasPassword) {
      throw new AuthError('claim_unavailable', '这个昵称没有待认领的账号', 409);
    }

    const problem = checkPasswordInput(input.password, input.name);
    if (problem) throw new AuthError('weak_password', problem, 400);

    const tokenVersion = await store.setPassword(record.id, await hashPassword(input.password));
    request.log.info({ userId: record.id, name: record.name }, '账号认领');

    return issue(record, input.remember ?? false, tokenVersion);
  });

  /** 改密码：验原密码，成功后作废所有旧令牌并下发新令牌 */
  app.post('/api/auth/password', async (request) => {
    const user = await requireUser(request);
    const input = changePasswordSchema.parse(request.body);

    checkLimit(limits.loginFailure.take(`pw:${user.id}`));
    const record = await store.findUserWithSecret(user.name);
    if (!record || !(await verifyPassword(input.oldPassword, record.passwordHash))) {
      throw new AuthError('invalid_credentials', '原密码不对', 401);
    }
    if (input.oldPassword === input.newPassword) {
      throw new AuthError('same_password', '新密码和原密码一样', 400);
    }
    const problem = checkPasswordInput(input.newPassword, user.name);
    if (problem) throw new AuthError('weak_password', problem, 400);

    limits.loginFailure.reset(`pw:${user.id}`);
    const tokenVersion = await store.setPassword(user.id, await hashPassword(input.newPassword));
    request.log.info({ userId: user.id }, '修改密码');
    metrics.inc('auth.password_changed');

    return issue(user, false, tokenVersion);
  });

  /** 退出登录：令牌版本 +1，所有设备上的旧令牌立刻失效 */
  app.post('/api/auth/logout', async (request) => {
    const user = await requireUser(request);
    await store.bumpTokenVersion(user.id);
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const user = await requireUser(request);
    return { user: publicUser(user) };
  });

  /** 版本公告已读：一个人对（游戏, 版本）只会读一次 */
  app.post('/api/notices/ack', async (request) => {
    const user = await requireUser(request);
    const input = z
      .object({ gameId: z.string().min(1), version: z.string().min(1) })
      .parse(request.body);
    await store.ackVersion(user.id, input.gameId, input.version);
    return { ok: true };
  });

  app.get('/api/games', async () => ({ games: host.listActive() }));

  app.get('/api/tables', async () => ({ tables: await service.summaries() }));

  /** 首页的「我的对局」：我参与的、还没结束的桌 */
  app.get('/api/tables/mine', async (request) => {
    const user = await requireUser(request);
    return { tables: await service.listMine(user.id) };
  });

  app.post('/api/tables', async (request) => {
    const user = await requireUser(request);
    checkLimit(limits.createTable.take(user.id));
    const input = createTableSchema.parse(request.body);
    const id = await service.createTable(user, input);
    metrics.inc('tables.created');
    request.log.info({ userId: user.id, tableId: id, gameId: input.gameId }, '建桌');
    return { id };
  });

  /** 随机加入：没桌就现开一张，所以一定会给你一个牌桌 */
  app.post<{ Body: { gameId?: string } }>('/api/tables/quick-match', async (request) => {
    const user = await requireUser(request);
    checkLimit(limits.createTable.take(user.id));
    const gameId = typeof request.body?.gameId === 'string' ? request.body.gameId : undefined;
    const result = await service.quickMatch(user, gameId);
    metrics.inc(result.created ? 'tables.created' : 'tables.quick_matched');
    return result;
  });

  app.post<{ Body: { code?: string } }>('/api/tables/join-by-code', async (request) => {
    const user = await requireUser(request);
    checkLimit(limits.createTable.take(user.id));
    const code = String(request.body?.code ?? '').trim();
    const id = await service.joinByCode(code, user);
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/tables/:id', async (request) => {
    const user = await requireUser(request);
    return { snapshot: await service.snapshot(request.params.id, user.id) };
  });

  app.post<{ Params: { id: string } }>('/api/tables/:id/join', async (request) => {
    const user = await requireUser(request);
    await service.joinTable(request.params.id, user);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/tables/:id/start', async (request) => {
    const user = await requireUser(request);
    await service.startTable(request.params.id, user.id);
    metrics.inc('tables.started');
    request.log.info({ userId: user.id, tableId: request.params.id }, '开局');
    return { ok: true };
  });

  /** 未开局时离开（房主走了会把房主交给下一个人） */
  app.post<{ Params: { id: string } }>('/api/tables/:id/leave', async (request) => {
    const user = await requireUser(request);
    await service.leave(request.params.id, user.id);
    metrics.inc('tables.left');
    return { ok: true };
  });

  /** 已开局时退出 = 认负：这一局立刻结束，判负方算法照算 */
  app.post<{ Params: { id: string } }>('/api/tables/:id/forfeit', async (request) => {
    const user = await requireUser(request);
    await service.forfeit(request.params.id, user.id);
    metrics.inc('tables.forfeited');
    request.log.info({ userId: user.id, tableId: request.params.id }, '认负');
    return { ok: true };
  });

  /** 再来一局：原班人马、**原版本**、原设置，开一张新桌 */
  app.post<{ Params: { id: string } }>('/api/tables/:id/rematch', async (request) => {
    const user = await requireUser(request);
    checkLimit(limits.createTable.take(user.id));
    const id = await service.rematch(request.params.id, user);
    metrics.inc('tables.created');
    request.log.info({ userId: user.id, from: request.params.id, to: id }, '再来一局');
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/tables/:id/replay', async (request) => {
    await requireUser(request);
    return { replay: await service.replay(request.params.id) };
  });

  app.get('/api/stats/me', async (request) => {
    const user = await requireUser(request);
    return await service.stats(user.id);
  });

  app.get<{ Querystring: { gameId?: string } }>('/api/leaderboard', async (request) => {
    await requireUser(request);
    const gameId = request.query.gameId;
    if (!gameId) throw new ServiceError('invalid_input', '需要 gameId 参数');
    return { gameId, entries: await service.leaderboard(gameId) };
  });

  /* --------------------------- 管理后台 --------------------------- */

  /** 概览：一个请求拿全，管理页不用并发打五个接口 */
  app.get('/api/admin/overview', async (request) => {
    await requireAdmin(request);
    const [tables, users, admins, versions, inUse] = await Promise.all([
      store.tableStatusCounts(),
      store.countUsers(),
      store.countAdmins(),
      store.listGameVersions(),
      store.listInUseVersions(),
    ]);
    const memory = process.memoryUsage();

    return {
      uptime: Math.round(process.uptime()),
      db: db.kind,
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
      workers: host.loadedVersions(),
      /** 有进行中牌桌在用的版本，GC 不会动它们 */
      inUse: [...inUse],
      tables,
      users: { total: users, admins },
      versions: {
        total: versions.length,
        active: versions.filter((version) => version.status === 'active').length,
        failed: versions.filter((version) => version.status === 'failed').length,
      },
      games: host.listActive().map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
      })),
      limits: { ipBuckets: ipLimiter.size },
    };
  });

  app.get('/api/admin/users', async (request) => {
    await requireAdmin(request);
    return { users: await store.listUsers(500) };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/admin', async (request) => {
    const admin = await requireAdmin(request);
    const { isAdmin } = z.object({ isAdmin: z.boolean() }).parse(request.body);

    const target = await store.getUser(request.params.id);
    if (!target) throw new ServiceError('not_found', '用户不存在');

    // 两个人同时点"取消管理员"时可能各自都以为还有别人才是管理员，所以两道检查都留着
    if (!isAdmin && target.id === admin.id) {
      throw new AuthError('cannot_demote_self', '不能取消自己的管理员权限', 400);
    }
    if (!isAdmin && target.isAdmin && (await store.countAdmins()) <= 1) {
      throw new AuthError('last_admin', '至少要留一个管理员', 400);
    }

    await store.setUserAdmin(target.id, isAdmin);
    request.log.info({ admin: admin.name, userId: target.id, isAdmin }, '管理员权限变更');
    return { ok: true };
  });

  /**
   * 重置密码：不给密码就生成一个临时口令，**只在这一次响应里返回**。
   * 服务端不存明文、不写日志——管理员抄下来告诉对方，让对方自己再改。
   */
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/password', async (request) => {
    const admin = await requireAdmin(request);
    const target = await store.getUser(request.params.id);
    if (!target) throw new ServiceError('not_found', '用户不存在');

    const input = z
      .object({ password: z.string().max(200).optional() })
      .parse(request.body ?? {});
    const password = input.password?.trim() ? input.password.trim() : generatePassword();

    const problem = checkPasswordInput(password, target.name);
    if (problem) throw new AuthError('weak_password', problem, 400);

    await store.setPassword(target.id, await hashPassword(password));
    request.log.info({ admin: admin.name, userId: target.id }, '管理员重置密码');
    metrics.inc('auth.password_reset');

    return { ok: true, password };
  });

  /* --------------------------- 插件管理 --------------------------- */

  app.get('/api/admin/plugins', async (request) => {
    await requireAdmin(request);
    const [versions, inUse] = await Promise.all([store.listGameVersions(), store.listInUseVersions()]);
    return {
      loaded: host.loadedVersions(),
      inUse: [...inUse],
      versions: versions.map((version) => ({
        gameId: version.gameId,
        version: version.version,
        status: version.status,
        hash: version.hash,
        error: version.error,
        createdAt: version.createdAt,
        activatedAt: version.activatedAt,
        name: version.manifest?.name ?? version.gameId,
        loaded: host.loadedVersions().includes(`${version.gameId}@${version.version}`),
      })),
    };
  });

  app.post('/api/admin/plugins', async (request) => {
    const admin = await requireAdmin(request);
    checkLimit(limits.upload.take(admin.id));
    const body = request.body;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ServiceError('bad_package', '请求体必须是 zip 包');
    }

    const sourceDir = await extractPackage(body, path.join(storageRoot, '.tmp'));
    try {
      const record = await publishDirectory(
        { store, host, storageRoot, log: (message) => app.log.info(message) },
        sourceDir,
        { activate: true },
      );
      app.log.info({ admin: admin.name, game: record.gameId, version: record.version }, '插件已上传');
      metrics.inc('plugin.published');
      return { gameId: record.gameId, version: record.version, status: record.status };
    } finally {
      await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.post('/api/admin/plugins/:gameId/:version/activate', async (request) => {
    await requireAdmin(request);
    const { gameId, version } = request.params as { gameId: string; version: string };
    const record = await host.setActive(gameId, version);
    await collectGarbage();
    return { ok: true, activatedAt: record.activatedAt };
  });

  /**
   * 回收：把"不是 active、也没有进行中牌桌在用"的插件 worker 卸载掉。
   * 卸载后如果有人还要看回放，会按需重新加载。
   */
  app.post('/api/admin/plugins/gc', async (request) => {
    await requireAdmin(request);
    const released = await collectGarbage();
    return { released, loaded: host.loadedVersions() };
  });

  /** 开发便利：重新扫描 games/ 并发布，不用重启服务 */
  app.post('/api/admin/plugins/republish', async (request) => {
    await requireAdmin(request);
    await publishLocalGames(
      { store, host, storageRoot, log: (message) => app.log.info(message) },
      path.join(REPO_ROOT, 'games'),
    );
    await host.refresh();
    return { games: host.listActive().map((manifest) => `${manifest.id}@${manifest.version}`) };
  });

  /* ----------------------------- 错误处理 ----------------------------- */

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RateLimitExceeded) {
      const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      return reply
        .code(429)
        .header('retry-after', seconds)
        .send({ code: 'rate_limited', message: `操作太频繁，${seconds} 秒后再试` });
    }
    if (error instanceof AuthError) {
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    if (error instanceof ServiceError) {
      const status =
        error.code === 'unauthorized'
          ? 401
          : error.code === 'forbidden'
            ? 403
            : error.code === 'not_found'
              ? 404
              : 400;
      return reply.code(status).send({ code: error.code, message: error.message });
    }
    if (error instanceof PluginError) {
      return reply.code(400).send({ code: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ code: 'invalid_input', message: error.issues[0]?.message ?? '参数不合法' });
    }
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = fastifyError.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        code: fastifyError.code ?? 'bad_request',
        message: fastifyError.message ?? '请求不合法',
      });
    }
    request.log.error(error);
    return reply.code(500).send({ code: 'internal', message: '服务器内部错误' });
  });

  /* ----------------------------- 上传包解析 ----------------------------- */

  // 直接把 zip 当请求体发，省掉 multipart 这一层
  app.addContentTypeParser(
    'application/zip',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  /* ----------------------------- WebSocket ----------------------------- */

  await registerWebSocket(app, service, bus, presence, { limits, metrics, store });

  /* ----------------------------- 超时调度 ----------------------------- */

  const timer = setInterval(() => {
    service.tick(Date.now()).catch((err) => app.log.error(err));
  }, 1000);
  timer.unref?.();

  // 定期清掉闲置的限流桶，避免长期运行后内存缓慢上涨
  const sweeper = setInterval(() => limits.sweep(), 5 * 60_000);
  sweeper.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(sweeper);
    service.stopBots();
    await host.closeAll();
    if (ownsDb) await db.close();
  });

  return app;
}
