import type { GameClient, LogEntry } from '@platform/sdk';

/**
 * 日志文案由插件自己渲染（GameClient.formatLog）。
 * 插件不认识这条记录时原样显示 key —— 宿主完全不认识任何具体游戏。
 */
export function renderLog(entry: LogEntry, client: GameClient | null): string {
  try {
    return client?.formatLog?.(entry) ?? entry.key;
  } catch {
    return entry.key;
  }
}
