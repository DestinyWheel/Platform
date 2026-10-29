/**
 * 插件 worker 入口。
 *
 * 每个 (游戏, 版本) 一个 worker：插件代码、引擎、状态都在这个线程里，
 * 主线程只通过消息传递交换 JSON。退役时 `terminate()` 能真正把模块图从内存卸载。
 *
 * 注意：这里同时承载了引擎（applyAction / applyTimeout），
 * 所以一次用户动作只产生一次跨线程往返，而不是每个插件方法各来一次。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { GamePlugin, SetupContext, AnyAction } from '@platform/sdk';
import {
  activePlayerOf,
  applyAction,
  applyTimeout,
  createInitialState,
  enumerateLegalMoves,
  legalActions,
} from '@platform/engine';

interface WorkerInit {
  entry: string;
  hash: string;
}

const init = workerData as WorkerInit;
let plugin: GamePlugin<any> | null = null;

async function ensurePlugin(): Promise<GamePlugin<any>> {
  if (plugin) return plugin;

  const module = (await import(`${pathToFileURL(init.entry).href}?v=${init.hash}`)) as Record<
    string,
    unknown
  >;
  const loaded = (module.default ?? module.plugin) as GamePlugin<any> | undefined;
  if (!loaded) throw new Error('插件没有默认导出');
  plugin = loaded;
  return loaded;
}

function serializeError(error: unknown): { name: string; code: string; message: string } {
  const err = error as { name?: string; code?: string; message?: string };
  return {
    name: err?.name ?? 'Error',
    code: err?.code ?? 'plugin_error',
    message: err?.message ?? String(error),
  };
}

interface Request {
  id: number;
  op: 'ready' | 'createState' | 'applyAction' | 'applyTimeout' | 'describe';
  setup?: SetupContext;
  state?: unknown;
  playerId?: string;
  action?: AnyAction;
  now?: number;
  viewer?: string;
}

parentPort?.on('message', (request: Request) => {
  void (async () => {
    try {
      const loaded = await ensurePlugin();
      let result: unknown;

      switch (request.op) {
        case 'ready':
          result = { gameId: loaded.manifest.id, version: loaded.manifest.version };
          break;

        case 'createState': {
          const applied = createInitialState(loaded, request.setup!);
          result = { ...applied, activePlayer: activePlayerOf(loaded, applied.state as any) };
          break;
        }

        case 'applyAction': {
          const applied = applyAction(
            loaded,
            request.state as any,
            request.playerId!,
            request.action!,
            request.now ?? 0,
          );
          result = { ...applied, activePlayer: activePlayerOf(loaded, applied.state as any) };
          break;
        }

        case 'applyTimeout': {
          const applied = applyTimeout(loaded, request.state as any, request.now ?? 0);
          result = applied
            ? { ...applied, activePlayer: activePlayerOf(loaded, applied.state as any) }
            : null;
          break;
        }

        case 'describe': {
          const state = request.state as any;
          const viewer = (request.viewer ?? 'spectator') as any;
          result = {
            view: loaded.view(state, viewer),
            activePlayer: activePlayerOf(loaded, state),
            legal: request.playerId ? legalActions(loaded, state, request.playerId) : [],
            legalMoves: request.playerId
              ? enumerateLegalMoves(loaded, state, request.playerId)
              : [],
          };
          break;
        }

        default:
          throw new Error(`未知操作：${String(request.op)}`);
      }

      parentPort?.postMessage({ id: request.id, ok: true, result });
    } catch (error) {
      parentPort?.postMessage({ id: request.id, ok: false, error: serializeError(error) });
    }
  })();
});
