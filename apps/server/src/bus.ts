import { EventEmitter } from 'node:events';

/**
 * 单机用的广播实现（进程内 EventEmitter）。
 *
 * 多实例时换成 Redis pub/sub 的实现即可，业务代码只依赖这个类的方法签名。
 *
 * channel 有两种：牌桌 id（"这张桌变了，各自去取快照"），以及 `user:<id>`
 * （私聊 / 关注提醒，直接带数据推给那个人的所有连接）。
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  subscribe(channel: string, listener: (payload?: unknown) => void): () => void {
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  publish(channel: string, payload?: unknown): void {
    this.emitter.emit(channel, payload);
  }
}
