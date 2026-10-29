/**
 * 在线人数统计（单实例内存实现）。
 *
 * 多实例时换成 Redis 即可 —— 只依赖这三个方法，业务代码不用动。
 */
export class Presence {
  /** tableId -> (connectionId -> userId) */
  private readonly byTable = new Map<string, Map<string, string>>();

  join(tableId: string, connectionId: string, userId: string): void {
    let connections = this.byTable.get(tableId);
    if (!connections) {
      connections = new Map();
      this.byTable.set(tableId, connections);
    }
    connections.set(connectionId, userId);
  }

  leave(tableId: string, connectionId: string): void {
    const connections = this.byTable.get(tableId);
    if (!connections) return;
    connections.delete(connectionId);
    if (connections.size === 0) this.byTable.delete(tableId);
  }

  /** 同一用户开多个标签页只算一个人 */
  viewers(tableId: string): number {
    const connections = this.byTable.get(tableId);
    if (!connections) return 0;
    return new Set(connections.values()).size;
  }
}
