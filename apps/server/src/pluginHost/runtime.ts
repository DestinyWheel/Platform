import { Worker } from 'node:worker_threads';
import type {
  AnyAction,
  Effect,
  GameManifest,
  PlayerId,
  PublicView,
  SetupContext,
} from '@platform/sdk';
import { RuleError } from '@platform/engine';
import { PluginError } from './types.js';

export interface ApplyResult {
  state: unknown;
  effects: Effect[];
  /** 落子之后的当前行动者。插件在 worker 里，主线程拿不到插件，只能连带算好 */
  activePlayer: PlayerId | null;
}

export interface TimeoutResult extends ApplyResult {
  action: AnyAction;
  actor: PlayerId;
}

export interface DescribeResult {
  view: PublicView;
  activePlayer: PlayerId | null;
  legal: string[];
  legalMoves: AnyAction[];
}

/** 人机决定要走的动作；actor 是它替哪个座位走 */
export interface BotDecision {
  actor: PlayerId;
  action: AnyAction;
}

/**
 * 一个版本在内存里的实体。
 *
 * 主线程只通过它跟插件打交道，插件永远跑在 worker 里 —— 所以旧版本可以被真正卸载。
 */
export interface PluginRuntime {
  readonly gameId: string;
  readonly version: string;
  readonly manifest: GameManifest;
  createState(setup: SetupContext): Promise<ApplyResult>;
  applyAction(
    state: unknown,
    playerId: PlayerId,
    action: AnyAction,
    now: number,
  ): Promise<ApplyResult>;
  applyTimeout(state: unknown, now: number): Promise<TimeoutResult | null>;
  describe(state: unknown, viewer: PlayerId | 'spectator', playerId?: PlayerId): Promise<DescribeResult>;
  /** 让插件决定一步（内部跑策略 + 平台兜底），主线程只负责把它当普通动作提交 */
  botMove(state: unknown, level: string): Promise<BotDecision | null>;
  terminate(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { name: string; code: string; message: string };
}

const CALL_TIMEOUT_MS = 5000;

export class WorkerPluginRuntime implements PluginRuntime {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(
    readonly gameId: string,
    readonly version: string,
    readonly manifest: GameManifest,
    entry: string,
    hash: string,
  ) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { entry, hash },
      // 开发态直接用 tsx 跑 TS，worker 也需要同一套 loader
      execArgv: process.execArgv,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });

    this.worker.on('message', (reply: WorkerReply) => this.handleReply(reply));
    this.worker.on('error', (error: Error) => this.failAll(error));
    this.worker.on('exit', () => {
      this.disposed = true;
      this.failAll(new PluginError('worker_exited', `${this.gameId}@${this.version} 的 worker 已退出`));
    });
  }

  private handleReply(reply: WorkerReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);

    if (reply.ok) {
      pending.resolve(reply.result);
      return;
    }

    const error = reply.error ?? { name: 'Error', code: 'plugin_error', message: '未知错误' };
    if (error.name === 'RuleError') {
      pending.reject(new RuleError(error.code, error.message));
    } else {
      pending.reject(new PluginError(error.code, error.message));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new PluginError('worker_down', `${this.gameId}@${this.version} 的 worker 已停止`),
      );
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError('worker_timeout', `${this.gameId}@${this.version} 执行超时`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.worker.postMessage({ id, op, ...payload });
    });
  }

  async ready(): Promise<void> {
    await this.call('ready');
  }

  createState(setup: SetupContext): Promise<ApplyResult> {
    return this.call<ApplyResult>('createState', { setup });
  }

  applyAction(
    state: unknown,
    playerId: PlayerId,
    action: AnyAction,
    now: number,
  ): Promise<ApplyResult> {
    return this.call<ApplyResult>('applyAction', { state, playerId, action, now });
  }

  applyTimeout(state: unknown, now: number): Promise<TimeoutResult | null> {
    return this.call<TimeoutResult | null>('applyTimeout', { state, now });
  }

  describe(
    state: unknown,
    viewer: PlayerId | 'spectator',
    playerId?: PlayerId,
  ): Promise<DescribeResult> {
    return this.call<DescribeResult>('describe', { state, viewer, playerId });
  }

  botMove(state: unknown, level: string): Promise<BotDecision | null> {
    return this.call<BotDecision | null>('botMove', { state, level });
  }

  async terminate(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new PluginError('worker_terminated', '插件 worker 已卸载'));
    await this.worker.terminate();
  }
}
