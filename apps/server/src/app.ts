import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { bearerFrom, signToken, verifyToken } from './auth.js';
import { EventBus } from './bus.js';
import { createDb, migrate, type Db } from './db/index.js';
import { PluginHost } from './pluginHost/host.js';
import { publishDirectory, publishLocalGames } from './pluginHost/publish.js';
import { PluginError } from './pluginHost/types.js';
import { extractPackage } from './pluginHost/upload.js';
import { ServiceError, TableService } from './service.js';
import { PgStore, type UserRecord } from './store.js';
import { registerWebSocket } from './ws.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const loginSchema = z.object({
  name: z.string().trim().min(2, '昵称至少 2 个字符').max(20, '昵称最多 20 个字符'),
});

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
  /** 启动时把 games/ 下的源码发一遍（开发用）；默认开，设 AUTO_PUBLISH_GAMES=0 关 */
  autoPublish?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // 插件上传包可能几百 KB，放宽一点
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  const ownsDb = options.db === undefined;
  const db = options.db ?? (await createDb());
  await migrate(db);

  const storageRoot = path.resolve(
    options.storageRoot ?? process.env.PLUGIN_DIR ?? path.join(REPO_ROOT, 'storage', 'plugins'),
  );
  await mkdir(storageRoot, { recursive: true });

  const store = new PgStore(db);
  const host = new PluginHost(store, storageRoot);
  const bus = new EventBus();
  const service = new TableService(store, host, bus, (error, tableId) => {
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

  /* ---------------------- 插件产物静态托管 ---------------------- */
  // URL 里带版本号，所以可以放心长缓存：发新版换 URL，老桌继续用老 URL
  await app.register(fastifyStatic, {
    root: storageRoot,
    prefix: '/plugins/',
    setHeaders: (response) => {
      response.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });

  const requireUser = async (request: FastifyRequest): Promise<UserRecord> => {
    const auth = verifyToken(bearerFrom(request.headers.authorization));
    if (!auth) throw new ServiceError('unauthorized', '请先登录');
    const user = await store.getUser(auth.id);
    if (!user) throw new ServiceError('unauthorized', '用户不存在，请重新登录');
    return user;
  };

  const requireAdmin = async (request: FastifyRequest): Promise<UserRecord> => {
    const user = await requireUser(request);
    if (!user.isAdmin) throw new ServiceError('forbidden', '需要管理员权限');
    return user;
  };

  /* ----------------------------- REST ----------------------------- */

  app.get('/api/health', async () => ({ ok: true, db: db.kind, uptime: process.uptime() }));

  app.post('/api/auth/login', async (request) => {
    const { name } = loginSchema.parse(request.body);
    const user = await store.findOrCreateUser(name);
    return {
      token: signToken({ id: user.id, name: user.name }),
      user: { id: user.id, name: user.name, isAdmin: user.isAdmin },
    };
  });

  app.get('/api/me', async (request) => {
    const user = await requireUser(request);
    return { user: { id: user.id, name: user.name, isAdmin: user.isAdmin } };
  });

  app.get('/api/games', async () => ({ games: host.listActive() }));

  app.get('/api/tables', async () => ({ tables: await service.summaries() }));

  app.post('/api/tables', async (request) => {
    const user = await requireUser(request);
    const input = createTableSchema.parse(request.body);
    return { id: await service.createTable(user, input) };
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
    return { ok: true };
  });

  /* --------------------------- 插件管理 --------------------------- */

  app.get('/api/admin/plugins', async (request) => {
    await requireAdmin(request);
    const versions = await store.listGameVersions();
    return {
      versions: versions.map((version) => ({
        gameId: version.gameId,
        version: version.version,
        status: version.status,
        hash: version.hash,
        error: version.error,
        createdAt: version.createdAt,
        activatedAt: version.activatedAt,
        name: version.manifest?.name ?? version.gameId,
      })),
    };
  });

  app.post('/api/admin/plugins', async (request) => {
    const admin = await requireAdmin(request);
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
      return { gameId: record.gameId, version: record.version, status: record.status };
    } finally {
      await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.post('/api/admin/plugins/:gameId/:version/activate', async (request) => {
    await requireAdmin(request);
    const { gameId, version } = request.params as { gameId: string; version: string };
    const record = await host.setActive(gameId, version);
    return { ok: true, activatedAt: record.activatedAt };
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
    if (error instanceof ServiceError) {
      const status =
        error.code === 'unauthorized' ? 401 : error.code === 'forbidden' ? 403 : 400;
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

  await registerWebSocket(app, service, bus);

  /* ----------------------------- 超时调度 ----------------------------- */

  const timer = setInterval(() => {
    service.tick(Date.now()).catch((err) => app.log.error(err));
  }, 1000);
  timer.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    if (ownsDb) await db.close();
  });

  return app;
}
