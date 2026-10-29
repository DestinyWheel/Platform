import type { GamePlugin } from '@platform/sdk';
import {
  activePlayerOf,
  applyAction,
  createInitialState,
  enumerateLegalMoves,
  RuleError,
} from '@platform/engine';
import { hashState } from '../hash.js';
import { PluginError } from './types.js';

export interface SmokeReport {
  steps: number;
  finished: boolean;
  settled: boolean;
}

const MAX_STEPS = 120;

interface RunResult {
  hashes: string[];
  steps: number;
  finished: boolean;
  settled: boolean;
}

/**
 * 同一个种子跑两遍，必须得到完全相同的哈希序列。
 *
 * 这一条同时验证了三件事：
 *   1. 插件没有引入不确定因素（否则两次结果会分叉）
 *   2. 状态是可 JSON 序列化的（否则哈希算不出来/算出来不一样）
 *   3. 随机动作能推进局面（否则说明动作或状态机写死了）
 */
function runOnce(plugin: GamePlugin<any>, seed: number, players: string[]): RunResult {
  let { state } = createInitialState(plugin, {
    players,
    options: {},
    seed,
    now: 0,
  });

  const hashes: string[] = [hashState(state)];
  let settled = false;

  for (let step = 0; step < MAX_STEPS && !state.finished; step += 1) {
    const player = activePlayerOf(plugin, state);
    if (!player) break;

    const moves = enumerateLegalMoves(plugin, state, player);
    if (moves.length === 0) break;

    let advanced = false;
    // 从不同起点轮着挑，让随机漫步覆盖到更多分支；同一步的结果只依赖状态，可复现
    for (let offset = 0; offset < moves.length; offset += 1) {
      const move = moves[(step + offset) % moves.length]!;
      try {
        const applied = applyAction(plugin, state, player, move, 0);
        state = applied.state;
        hashes.push(hashState(state));
        advanced = true;
        settled = true;
        break;
      } catch (error) {
        if (error instanceof RuleError) continue; // legalMoves 给多了，换下一个
        throw error;
      }
    }
    if (!advanced) break;
  }

  // 状态必须能无损地过一遍 JSON（要落库、要跨进程）
  const roundTripped = JSON.parse(JSON.stringify(state)) as typeof state;
  if (hashState(roundTripped) !== hashState(state)) {
    throw new PluginError('nonserializable', '状态经过 JSON 序列化后发生了变化，无法安全落库');
  }

  return { hashes, steps: hashes.length - 1, finished: state.finished, settled };
}

export function smokePlugin(plugin: GamePlugin<any>, seed = 20260101): SmokeReport {
  const { min } = plugin.manifest.players;
  const players = Array.from({ length: Math.max(2, min) }, (_, index) => `smoke-p${index + 1}`);

  const first = runOnce(plugin, seed, players);
  const second = runOnce(plugin, seed, players);

  if (first.hashes.length !== second.hashes.length) {
    throw new PluginError('nondeterministic', '同样种子跑两遍步数不同，插件存在不确定行为');
  }
  for (let index = 0; index < first.hashes.length; index += 1) {
    if (first.hashes[index] !== second.hashes[index]) {
      throw new PluginError(
        'nondeterministic',
        `同样种子跑两遍在第 ${index} 步分叉，插件存在不确定行为`,
      );
    }
  }
  if (!first.settled) {
    throw new PluginError('stuck', '开局后没有任何动作能推进局面，检查状态机或动作定义');
  }

  return { steps: first.steps, finished: first.finished, settled: first.settled };
}
