/**
 * 纯函数引擎：状态机推进、动作校验、视图裁剪。
 *
 * 这一层不允许 import 任何 DB / socket / 进程相关模块 —— 它只处理内存里的 JSON。
 * 正因为如此，同一段代码可以同时用于：线上对局、回放、AI 自对弈、插件冒烟测试。
 */
import type {
  ActionContext,
  AnyAction,
  BaseState,
  Effect,
  GamePlugin,
  PlayerId,
  SetupContext,
  StateDef,
} from '@platform/sdk';

export class RuleError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'RuleError';
  }
}

export interface ApplyResult<S extends BaseState> {
  state: S;
  effects: Effect[];
}

/** 确定性伪随机（32 位），返回 [0, 1) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

function resolveNext<S extends BaseState>(def: StateDef<S>, state: S): string | undefined {
  if (!def.next) return undefined;
  return typeof def.next === 'function' ? def.next(state) : def.next;
}

function makeContext<S extends BaseState>(
  state: S,
  playerId: PlayerId,
  now: number,
  effects: Effect[],
  onGoTo: (phase: string) => void,
): ActionContext<S> {
  const rng = mulberry32(state.rngSeed);
  return {
    playerId,
    players: state.players,
    now,
    rng,
    emit: (effect) => effects.push(effect),
    goTo: onGoTo,
    get state() {
      return state;
    },
  };
}

/**
 * 进入某阶段并沿 next 链自动推进，直到停在一个"等待输入"的阶段。
 */
function enterPhase<S extends BaseState>(
  plugin: GamePlugin<S>,
  state: S,
  target: string,
  ctx: ActionContext<S>,
): void {
  let current = target;

  for (let guard = 0; guard < 32; guard += 1) {
    if (current === 'finished') {
      state.phase = 'finished';
      plugin.states.finished?.onEnter?.(state, ctx);
      return;
    }

    const def = plugin.states[current];
    if (!def) throw new RuleError('unknown_phase', `阶段 "${current}" 未定义`);

    state.phase = current;
    def.onEnter?.(state, ctx);

    if (state.finished) {
      state.phase = 'finished';
      plugin.states.finished?.onEnter?.(state, ctx);
      return;
    }

    const next = resolveNext(def, state);
    if (!next || next === current) return;
    current = next;
  }

  throw new RuleError('transition_loop', '状态机在阶段间循环，疑似规则写错');
}

/**
 * 建局。返回初始状态 + 开局产生的副作用。
 */
export function createInitialState<S extends BaseState>(
  plugin: GamePlugin<S>,
  setup: SetupContext,
): ApplyResult<S> {
  const state = plugin.createState(setup);
  if (!state.players.length) throw new RuleError('no_players', '没有玩家');

  const effects: Effect[] = [];
  const ctx = makeContext(state, state.players[0]!, setup.now, effects, () => {});
  enterPhase(plugin, state, state.phase, ctx);
  return { state, effects };
}

/**
 * 执行一个动作。输入状态不会被修改（内部克隆一份草稿）。
 * 规则不合法时抛 RuleError，其 code 会原样返回给客户端。
 */
export function applyAction<S extends BaseState>(
  plugin: GamePlugin<S>,
  state: S,
  playerId: PlayerId,
  action: AnyAction,
  now: number,
): ApplyResult<S> {
  const def = plugin.actions[action.type];
  if (!def) throw new RuleError('unknown_action', `未知动作：${action.type}`);
  if (!def.allowedIn.includes(state.phase)) {
    throw new RuleError('wrong_phase', `阶段 ${state.phase} 不接受动作 ${action.type}`);
  }

  const draft = structuredClone(state) as S;
  const effects: Effect[] = [];
  let target: string | null = null;

  const ctx = makeContext(draft, playerId, now, effects, (phase) => {
    target = phase;
  });

  const parsed = def.schema.safeParse(action.payload ?? {});
  if (!parsed.success) {
    throw new RuleError('invalid_payload', parsed.error.issues[0]?.message ?? '参数不合法');
  }
  const normalized: AnyAction = { type: action.type, payload: parsed.data };

  if (def.validate) {
    const result = def.validate(draft, normalized, ctx);
    if (!result.ok) throw new RuleError(result.reason);
  }

  def.reduce(draft, normalized, ctx);
  draft.rngSeed = nextSeed(draft.rngSeed);

  if (draft.finished && !target) target = 'finished';

  if (target) {
    enterPhase(plugin, draft, target, ctx);
  } else {
    const currentDef = plugin.states[draft.phase];
    const next = currentDef ? resolveNext(currentDef, draft) : undefined;
    if (next && next !== draft.phase) enterPhase(plugin, draft, next, ctx);
  }

  return { state: draft, effects };
}

/**
 * 超时兜底：交给插件自己决定替玩家走哪一步，然后复用同一条 applyAction 通道。
 *
 * 注意：onTimeout 里的 state 修改会被丢弃（它只负责"决定动作"），
 * 真正的状态推进由 applyAction 重新执行一遍 reducer 完成 —— 这样超时和真人落子
 * 走的是完全相同的代码路径，回放也一致。
 */
export function applyTimeout<S extends BaseState>(
  plugin: GamePlugin<S>,
  state: S,
  now: number,
): (ApplyResult<S> & { action: AnyAction; actor: PlayerId }) | null {
  const def = plugin.states[state.phase];
  if (!def?.onTimeout) return null;

  const playerId = activePlayerOf(plugin, state);
  if (!playerId) return null;

  const probe: Effect[] = [];
  const probeCtx = makeContext(structuredClone(state) as S, playerId, now, probe, () => {});
  const action = def.onTimeout(probeCtx.state, probeCtx);
  if (!action) return null;

  // 把"决定了什么动作"一并返回：超时也能写进动作日志，回放才完整
  return { ...applyAction(plugin, state, playerId, action, now), action, actor: playerId };
}

/** 当前该谁动；非 activePlayer 阶段或已结束返回 null */
export function activePlayerOf<S extends BaseState>(plugin: GamePlugin<S>, state: S): PlayerId | null {
  if (state.finished) return null;
  const def = plugin.states[state.phase];
  if (!def || def.type !== 'activePlayer') return null;
  return state.players[state.turn] ?? null;
}

/**
 * 给 UI 的可用动作提示（非权威）。validate 必须是纯函数，否则这里会有副作用。
 */
export function legalActions<S extends BaseState>(
  plugin: GamePlugin<S>,
  state: S,
  playerId: PlayerId,
): string[] {
  if (state.finished) return [];
  const def = plugin.states[state.phase];
  if (!def) return [];

  const ctx = makeContext(state, playerId, 0, [], () => {});
  const out: string[] = [];

  for (const [type, actionDef] of Object.entries(plugin.actions)) {
    if (!actionDef.allowedIn.includes(state.phase)) continue;
    if (actionDef.validate) {
      try {
        if (!actionDef.validate(state, { type }, ctx).ok) continue;
      } catch {
        continue;
      }
    }
    out.push(type);
  }
  return out;
}

/**
 * 枚举具体可执行动作。
 *
 * 插件实现了 legalMoves 就用它（能带参数，UI 可以精确高亮）；
 * 没实现就退回"只给类型"，保持老插件兼容。
 */
export function enumerateLegalMoves<S extends BaseState>(
  plugin: GamePlugin<S>,
  state: S,
  playerId: PlayerId,
): AnyAction[] {
  if (state.finished) return [];

  if (plugin.legalMoves) {
    try {
      return plugin.legalMoves(state, playerId) ?? [];
    } catch {
      return [];
    }
  }

  return legalActions(plugin, state, playerId).map((type) => ({ type }));
}

export { mulberry32 };
