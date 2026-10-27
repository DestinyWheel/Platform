import { EventEmitter } from 'node:events';

/**
 * 单机用的广播实现（进程内 EventEmitter）。
 *
 * 多实例时换成 Redis pub/sub 的实现即可，业务代码只依赖这个类的方法签名。
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  subscribe(tableId: string, listener: () => void): () => void {
    this.emitter.on(tableId, listener);
    return () => {
      this.emitter.off(tableId, listener);
    };
  }

  publish(tableId: string): void {
    this.emitter.emit(tableId);
  }
}
