import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { ClientMessage, ServerMessage } from '@platform/sdk';
import { randomUUID } from 'node:crypto';
import { verifyToken } from './auth.js';
import type { EventBus } from './bus.js';
import type { Limiters } from './limits.js';
import type { Metrics } from './metrics.js';
import type { Presence } from './presence.js';
import { ServiceError, type TableService } from './service.js';
import type { Store } from './store.js';

export interface WebSocketDeps {
  limits: Limiters;
  metrics: Metrics;
  /** 鉴权要读一次用户，才能校验令牌版本（改密码/登出后旧连接凭证立刻无效） */
  store: Store;
}

/**
 * WebSocket 网关：一条连接可以订阅多张桌。
 *
 * 状态变化 → bus.publish(tableId) → 每个订阅者各自生成"属于自己视角"的快照。
 *  personalize 在服务端完成，客户端永远拿不到别人的隐藏信息。
 */
export async function registerWebSocket(
  app: FastifyInstance,
  service: TableService,
  bus: EventBus,
  presence: Presence,
  deps: WebSocketDeps,
): Promise<void> {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, async (socket, request: FastifyRequest) => {
    const url = new URL(request.url, 'http://localhost');
    const auth = verifyToken(url.searchParams.get('token'));

    // 光验签名不够：还得确认这个令牌没被作废（改密码、退出登录会把它作废）
    const user = auth ? await deps.store.getUser(auth.id) : undefined;
    if (!auth || !user || user.tokenVersion !== auth.ver) {
      deps.metrics.inc('ws.unauthorized');
      socket.close(4401, 'unauthorized');
      return;
    }


    const { limits, metrics } = deps;
    const subscriptions = new Map<string, () => void>();
    const connectionId = randomUUID();
    metrics.add('ws.connections', 1);
    request.log.info({ userId: user.id, connectionId }, 'ws 连接建立');

    const send = (msg: ServerMessage): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg));
    };

    const pushSnapshot = async (tableId: string): Promise<void> => {
      try {
        const snapshot = await service.snapshot(tableId, user.id);
        send({ t: 'snapshot', snapshot });
      } catch (err) {
        if (err instanceof ServiceError) {
          send({ t: 'error', code: err.code, message: err.message });
        }
      }
    };

    const subscribe = (tableId: string): void => {
      if (subscriptions.has(tableId)) return;
      subscriptions.set(
        tableId,
        bus.subscribe(tableId, () => {
          void pushSnapshot(tableId);
        }),
      );
      // 在线人数：同一用户多标签页只算一个人
      presence.join(tableId, connectionId, user.id);
      void pushSnapshot(tableId);
      bus.publish(tableId);
    };

    const unsubscribe = (tableId: string): void => {
      subscriptions.get(tableId)?.();
      subscriptions.delete(tableId);
      presence.leave(tableId, connectionId);
      bus.publish(tableId);
    };

    const handleAction = async (
      tableId: string,
      type: string,
      payload: unknown,
    ): Promise<void> => {
      if (!limits.action.take(user.id).ok) {
        metrics.inc('ws.rate_limited');
        send({ t: 'error', code: 'rate_limited', message: '操作太频繁，慢一点' });
        return;
      }
      try {
        await service.act(tableId, user.id, { type, payload });
        metrics.inc('ws.actions');
      } catch (err) {
        if (err instanceof ServiceError) {
          send({ t: 'error', code: err.code, message: err.message });
          return;
        }
        request.log.error(err);
        send({ t: 'error', code: 'action_failed', message: '动作执行失败' });
      }
    };

    const handleChat = async (tableId: string, text: string): Promise<void> => {
      if (!limits.chat.take(user.id).ok) {
        metrics.inc('ws.rate_limited');
        send({ t: 'error', code: 'rate_limited', message: '说话太快了，歇一下' });
        return;
      }
      try {
        await service.chat(tableId, user, text);
        metrics.inc('ws.chat');
      } catch (err) {
        if (err instanceof ServiceError) {
          send({ t: 'error', code: err.code, message: err.message });
          return;
        }
        request.log.error(err);
        send({ t: 'error', code: 'chat_failed', message: '消息发送失败' });
      }
    };

    socket.on('message', (raw: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send({ t: 'error', code: 'bad_json', message: '消息不是合法 JSON' });
        return;
      }

      switch (msg.t) {
        case 'subscribe':
          subscribe(msg.tableId);
          break;
        case 'unsubscribe':
          unsubscribe(msg.tableId);
          break;
        case 'ping':
          send({ t: 'pong' });
          break;
        case 'action':
          void handleAction(msg.tableId, msg.type, msg.payload);
          break;
        case 'chat':
          void handleChat(msg.tableId, msg.text);
          break;
        default:
          send({ t: 'error', code: 'unknown_message', message: '未知消息类型' });
      }
    });

    socket.on('close', () => {
      metrics.add('ws.connections', -1);
      request.log.info({ userId: user.id, connectionId }, 'ws 连接关闭');
      for (const tableId of subscriptions.keys()) presence.leave(tableId, connectionId);
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
    });
  });
}
