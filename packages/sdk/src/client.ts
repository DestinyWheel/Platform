/// <reference lib="dom" />
/**
 * 前端插件契约。
 *
 * 刻意做成"框架无关"：宿主只认 mount / update / unmount 三个方法，
 * 插件内部用原生 DOM、Canvas 还是自己带的框架都行。
 * 这样宿主不需要 import map、不需要共享 React、也不会被插件锁死版本。
 */
import type { AnyAction, LogEntry, PublicView } from './index.js';

export interface ClientPlayer {
  id: string;
  name: string;
}

export interface GameClientContext {
  /** 宿主提供的容器，插件把 DOM 挂到这里 */
  root: HTMLElement;
  /** 当前观看者（观战者时是 spectator id） */
  me: string;
  players: ClientPlayer[];
  /** 唯一合法的动作出口：交给宿主，宿主再走 WS */
  send(action: AnyAction): void;
}

export interface ClientSnapshot {
  status: 'lobby' | 'playing' | 'finished';
  view: PublicView | null;
  /** 当前你有哪些动作可用（非权威，仅用于按钮可点性） */
  legal: string[];
  /** 具体可执行动作（带参数），用于精确高亮"哪张牌能打去哪" */
  legalMoves: AnyAction[];
  deadlineAt: number | null;
}

export interface GameClient {
  mount(context: GameClientContext): void;
  update(snapshot: ClientSnapshot): void;
  /** 视图被销毁时调用：解绑监听、清定时器 */
  unmount?(): void;
  /**
   * 可选：右侧栏（挂在聊天上方）。棋盘之外还想常驻一块信息时用，
   * 比如这个游戏的牌型顺序。不实现就不占位置。
   */
  sidePanel?: {
    mount(context: GameClientContext): void;
    update(snapshot: ClientSnapshot): void;
    unmount?(): void;
  };
  /**
   * 把一条日志记录渲染成文字。返回 null 表示"我不认识这条"，宿主会退回显示 key。
   * 放在插件里而不是宿主里，宿主才不会认识任何具体游戏。
   */
  formatLog?(entry: LogEntry): string | null;
}
