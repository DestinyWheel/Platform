import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z, ZodError } from 'zod';
import type { AuthUser } from '@platform/sdk';
import { bearerFrom, signToken, verifyToken } from './auth.js';
import { EventBus } from './bus.js';
import { createRegistry } from './games.js';
import { ServiceError, TableService } from './service.js';
import { MemoryStore } from './store.js';
import { registerWebSocket } from './ws.js';

const loginSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, '昵称至少 2 个字符')
    .max(20, '昵称最多 20 个字符'),
});

const createTableSchema = z.object({
  gameId: z.string().min(1),
  maxPlayers: z.number().int().optional(),
  options: z.record(z.unknown()).optional(),
});

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors, { origin: true });

  const store = new MemoryStore();
  const games = createRegistry();
  const bus = new EventBus();
  const service = new TableService(store, games, bus);

  const requireUser = (request: FastifyRequest): AuthUser => {
    const user = verifyToken(bearerFrom(request.headers.authorization));
    if (!user) throw new ServiceError('unauthorized', '请先登录');
    return user;
  };

  /* ----------------------------- REST ----------------------------- */

  app.get('/api/health', async () => ({ ok: true, uptime: process.uptime() }));

  app.post('/api/auth/login', async (request) => {
    const { name } = loginSchema.parse(request.body);
    const user = await store.findOrCreateUser(name);
    return {
      token: signToken({ id: user.id, name: user.name }),
      user: { id: user.id, name: user.name },
    };
  });

  app.get('/api/me', async (request) => {
    const user = requireUser(request);
    return { user };
  });

  app.get('/api/games', async () => ({ games: games.list() }));

  app.get('/api/tables', async () => ({ tables: await service.summaries() }));

  app.post('/api/tables', async (request) => {
    const user = requireUser(request);
    const input = createTableSchema.parse(request.body);
    const id = await service.createTable(
      { id: user.id, name: user.name, createdAt: Date.now() },
      input,
    );
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/tables/:id', async (request) => {
    const user = requireUser(request);
    return { snapshot: await service.snapshot(request.params.id, user.id) };
  });

  app.post<{ Params: { id: string } }>('/api/tables/:id/join', async (request) => {
    const user = requireUser(request);
    await service.joinTable(request.params.id, {
      id: user.id,
      name: user.name,
      createdAt: Date.now(),
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/tables/:id/start', async (request) => {
    const user = requireUser(request);
    await service.startTable(request.params.id, user.id);
    return { ok: true };
  });

  /* ----------------------------- 错误处理 ----------------------------- */

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
      const status = error.code === 'unauthorized' ? 401 : 400;
      return reply.code(status).send({ code: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ code: 'invalid_input', message: error.issues[0]?.message ?? '参数不合法' });
    }
    // 透传 Fastify 自己的 4xx（如空 body、非法 JSON），别把它们全变成 500
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

  /* ----------------------------- WebSocket ----------------------------- */

  await registerWebSocket(app, service, bus);

  /* ----------------------------- 超时调度 ----------------------------- */

  const timer = setInterval(() => {
    service.tick(Date.now()).catch((err) => app.log.error(err));
  }, 1000);
  timer.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(timer);
  });

  return app;
}
