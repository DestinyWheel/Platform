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
  mulberry32,
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
  op: 'ready' | 'createState' | 'applyAction' | 'applyTimeout' | 'describe' | 'botMove';
  setup?: SetupContext;
  state?: unknown;
  playerId?: string;
  action?: AnyAction;
  now?: number;
  viewer?: string;
  level?: string;
}

/** 人机的随机数跟局面种子绑死：同一局重放时行为一致 */
function seededRandom(seed: number, salt: string): () => number {
  let hash = seed >>> 0;
  for (let index = 0; index < salt.length; index += 1) {
    hash = (Math.imul(hash, 31) + salt.charCodeAt(index)) >>> 0;
  }
  return mulberry32(hash);
}

function sameAction(a: AnyAction, b: AnyAction): boolean {
  return (
    a.type === b.type && JSON.stringify(a.payload ?? null) === JSON.stringify(b.payload ?? null)
  );
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

        case 'botMove': {
          const state = request.state as any;
          const actor = activePlayerOf(loaded, state);
          if (!actor) {
            result = null;
            break;
          }

          const moves = enumerateLegalMoves(loaded, state, actor);
          if (moves.length === 0) {
            result = null;
            break;
          }

          const level = request.level ?? 'normal';
          const policy = level === 'easy' ? null : (loaded.bots?.[0] ?? null);
          const rng = seededRandom(Number(state.rngSeed ?? 0), actor);

          let chosen: AnyAction | null = null;
          if (policy) {
            try {
              const proposed = policy.choose({
                view: loaded.view(state, actor),
                me: actor,
                legal: moves,
                level: level as any,
                rng,
              });
              // 插件可能返回一个不合法的动作，这里必须校验，不能盲信
              if (proposed && moves.some((move) => sameAction(move, proposed))) {
                chosen = proposed;
              }
            } catch {
              chosen = null;
            }
          }

          // 平台兜底：随机挑一个合法动作
          result = { actor, action: chosen ?? moves[Math.floor(rng() * moves.length)]! };
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
