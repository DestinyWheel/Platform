/**
 * 基础版花砖物语 —— 服务端。
 *
 * 状态机：playing（选砖）→ tiling（需要选择上墙位置/双倍时）→ finished。
 * 没有选择的回合结算会自动瞬间完成，不额外要求玩家点击。
 */
import { z } from 'zod';
import type {
  ActionDef,
  ActionContext,
  AnyAction,
  BaseState,
  GameManifest,
  GamePlugin,
  PlayerId,
  PublicView,
  StateDef,
  ValidationResult,
} from '@platform/sdk';
import rawManifest from '../manifest.json';
import {
  COLORS,
  EXPANSION,
  PROFILES,
  baseColumn,
  emptyBoard,
  factoryCountFor,
  finalBonusFor,
  hasExpansion,
  legalColumns,
  legalJokerColumns,
  patternLineColor,
  placementScore,
  profileForExpansions,
  type AzulBoard,
  type AzulColor,
  type AzulFactory,
  type AzulState,
  type AzulTile,
  type BoardProfile,
  type FinalBonus,
} from './shared';

const manifest = rawManifest as GameManifest;

/* ------------------------------------------------------------------ */
/* 确定性随机                                                          */
/* ------------------------------------------------------------------ */

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

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

function drawTiles(state: AzulState, count: number, rng: () => number): AzulTile[] {
  const out: AzulTile[] = [];
  while (out.length < count) {
    if (state.bag.length === 0) {
      if (state.lid.length === 0) break;
      state.bag = shuffle(state.lid, rng);
      state.lid = [];
    }
    out.push(state.bag.pop()!);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 通用助手                                                            */
/* ------------------------------------------------------------------ */

function currentPlayer(state: AzulState): PlayerId {
  return state.players[state.turn]!;
}

function boardOf(state: AzulState, player: PlayerId): AzulBoard {
  return state.boards[player]!;
}

function profileOf(state: AzulState): BoardProfile {
  return PROFILES[state.profile];
}

function lineCapacity(line: number): number {
  return line + 1;
}

function hasJokerTiles(expansions: string[]): boolean {
  return hasExpansion(expansions, EXPANSION.joker);
}

function isDoubleMarkers(state: AzulState): boolean {
  return hasExpansion(state.expansions, EXPANSION.doubleMarkers);
}

function addFloor(state: AzulState, board: AzulBoard, tiles: AzulTile[]): number {
  let added = 0;
  for (const tile of tiles) {
    if (board.floor.length < 7) {
      board.floor.push(tile);
      added += 1;
    } else {
      state.lid.push(tile);
    }
  }
  return added;
}

function addMarker(state: AzulState, board: AzulBoard): void {
  if (board.floor.length < 7) board.floor.push('marker');
}

/** 把某来源中选中的砖取走；返回实际拿到的砖 */
function takeFromSource(
  state: AzulState,
  source: number | null,
  color: AzulColor | null,
  includeJokers: boolean,
): { taken: AzulTile[]; leftovers: AzulTile[]; isCenter: boolean; marker: boolean } {
  const wantJokers = color === null || includeJokers;
  if (source === null) {
    const taken = state.center.filter(
      (tile) => (color !== null && tile === color) || (wantJokers && tile === 'joker'),
    );
    state.center = state.center.filter((tile) => !taken.includes(tile));
    const marker = state.markerInCenter;
    if (marker) state.markerInCenter = false;
    return { taken, leftovers: [], isCenter: true, marker };
  }

  const factory = state.factories[source]!;
  const taken = factory.tiles.filter(
    (tile) => (color !== null && tile === color) || (wantJokers && tile === 'joker'),
  );
  const leftovers = factory.tiles.filter((tile) => !taken.includes(tile));
  factory.tiles = [];
  return { taken, leftovers, isCenter: false, marker: false };
}

function moveLeftovers(
  state: AzulState,
  source: number,
  leftovers: AzulTile[],
  shift: Record<string, 'left' | 'right'> | undefined,
): void {
  if (leftovers.length === 0) return;
  const factory = state.factories[source]!;
  if (factory.type === 'normal') {
    state.center.push(...leftovers);
    return;
  }
  if (factory.type === 'stay') {
    factory.tiles = leftovers;
    return;
  }

  const n = state.factories.length;
  const groups = new Map<string, AzulTile[]>();
  for (const tile of leftovers) {
    const group = groups.get(tile) ?? [];
    group.push(tile);
    groups.set(tile, group);
  }
  for (const [tile, group] of groups) {
    const direction = shift?.[tile] ?? 'left';
    const target = direction === 'left' ? (source - 1 + n) % n : (source + 1) % n;
    state.factories[target]!.tiles.push(...group);
  }
}

function patternAccepts(
  profile: BoardProfile,
  board: AzulBoard,
  line: number,
  color: AzulColor | null,
): boolean {
  const pattern = board.patterns[line]!;
  if (pattern.length >= lineCapacity(line)) return false;
  const lineColor = patternLineColor(pattern);
  if (color === null) return true;
  if (lineColor !== null && lineColor !== color) return false;
  if (!profile.freePlacement) {
    const col = baseColumn(line, color);
    if (board.wall[line]![col] !== null) return false;
  }
  return true;
}

/** 上墙决策节点：可选的列、哪些列能触发 ×2/双倍标记 */
interface TilingOptions {
  player: PlayerId;
  line: number;
  tile: AzulTile;
  color: AzulColor | null;
  joker: boolean;
  columns: number[];
  doubleColumns: number[];
  x2Columns: number[];
}

function tilingOptions(state: AzulState): TilingOptions | null {
  if (!state.tiling) return null;
  const player = state.players[state.tiling.player]!;
  const board = boardOf(state, player);
  const line = state.tiling.line;
  const pattern = board.patterns[line]!;
  const profile = profileOf(state);
  const color = patternLineColor(pattern);
  const joker = pattern.includes('joker');
  const wall = board.wall;
  const columns = joker
    ? legalJokerColumns(profile, wall, line, color)
    : legalColumns(profile, wall, line, color!);
  const x2Columns = columns.filter((col) => profile.x2[line]![col]);
  const doubleColumns =
    isDoubleMarkers(state) &&
    !board.usedDouble &&
    !joker &&
    color !== null &&
    state.doubleMarkers.includes(color)
      ? columns.filter((col) => !profile.x2[line]![col])
      : [];
  return {
    player,
    line,
    tile: joker ? 'joker' : color!,
    color,
    joker,
    columns,
    doubleColumns,
    x2Columns,
  };
}

function clearPattern(pattern: AzulTile[], state: AzulState, placed: AzulTile): void {
  let removed = false;
  const keep: AzulTile[] = [];
  for (const tile of pattern) {
    if (!removed && tile === placed) {
      removed = true;
      continue;
    }
    keep.push(tile);
  }
  if (!removed) keep.pop();
  state.lid.push(...keep);
  pattern.length = 0;
}

function placeWall(
  state: AzulState,
  ctx: ActionContext<AzulState>,
  playerIndex: number,
  line: number,
  col: number,
  useDouble: boolean,
): void {
  const player = state.players[playerIndex]!;
  const board = boardOf(state, player);
  const profile = profileOf(state);
  const pattern = board.patterns[line]!;
  const color = patternLineColor(pattern);
  const joker = pattern.includes('joker');
  const placed: AzulTile = joker ? 'joker' : color!;

  board.wall[line]![col] = placed;
  let points = placementScore(board.wall, line, col);
  const x2 = profile.x2[line]![col] && placed !== 'joker';
  if (x2) points *= 2;
  if (useDouble) {
    points *= 2;
    board.usedDouble = true;
    state.doubleMarkers = state.doubleMarkers.filter((item) => item !== color);
  }
  board.score += points;
  clearPattern(pattern, state, placed);
  ctx.emit({
    type: 'log',
    key: 'az.place',
    args: {
      player,
      line,
      color: placed,
      points,
      doubled: x2 || useDouble,
      joker: placed === 'joker',
    },
  });
}

function moveLineToFloor(
  state: AzulState,
  ctx: ActionContext<AzulState>,
  playerIndex: number,
  line: number,
): void {
  const player = state.players[playerIndex]!;
  const board = boardOf(state, player);
  const pattern = board.patterns[line]!;
  const tiles = [...pattern];
  pattern.length = 0;
  addFloor(state, board, tiles);
  ctx.emit({ type: 'log', key: 'az.blocked', args: { player, line, count: tiles.length } });
}

/**
 * 从本轮先手开始按顺序处理所有完成行。
 * 遇到需要选择（多列 / 双倍标记）就停在 tiling，等待 placeWall。
 */
function continueTiling(state: AzulState, ctx: ActionContext<AzulState>): void {
  const n = state.players.length;
  const profile = profileOf(state);
  for (let offset = 0; offset < n; offset += 1) {
    const playerIndex = (state.starter + offset) % n;
    const board = boardOf(state, state.players[playerIndex]!);
    for (let line = 0; line < 5; line += 1) {
      const pattern = board.patterns[line]!;
      if (pattern.length !== lineCapacity(line)) continue;

      const options = tilingOptionsFor(state, playerIndex, line, board, profile);
      if (options.columns.length === 0) {
        moveLineToFloor(state, ctx, playerIndex, line);
        continue;
      }
      const needsChoice = options.columns.length > 1 || options.doubleColumns.length > 0;
      if (needsChoice) {
        state.tiling = { player: playerIndex, line };
        state.turn = playerIndex;
        state.phase = 'tiling';
        ctx.goTo('tiling');
        return;
      }
      placeWall(state, ctx, playerIndex, line, options.columns[0]!, false);
    }
  }
  finishRound(state, ctx);
}

function tilingOptionsFor(
  state: AzulState,
  playerIndex: number,
  line: number,
  board: AzulBoard,
  profile: BoardProfile,
): TilingOptions {
  const player = state.players[playerIndex]!;
  const pattern = board.patterns[line]!;
  const color = patternLineColor(pattern);
  const joker = pattern.includes('joker');
  const columns = joker
    ? legalJokerColumns(profile, board.wall, line, color)
    : legalColumns(profile, board.wall, line, color!);
  const x2Columns = columns.filter((col) => profile.x2[line]![col]);
  const doubleColumns =
    isDoubleMarkers(state) &&
    !board.usedDouble &&
    !joker &&
    color !== null &&
    state.doubleMarkers.includes(color)
      ? columns.filter((col) => !profile.x2[line]![col])
      : [];
  return {
    player,
    line,
    tile: joker ? 'joker' : color!,
    color,
    joker,
    columns,
    doubleColumns,
    x2Columns,
  };
}

function rankingOf(
  state: AzulState,
  rowsByPlayer: Record<PlayerId, number>,
): PlayerId[][] {
  const sorted = [...state.players].sort((a, b) => {
    const scoreDiff = boardOf(state, b).score - boardOf(state, a).score;
    if (scoreDiff !== 0) return scoreDiff;
    return (rowsByPlayer[b] ?? 0) - (rowsByPlayer[a] ?? 0);
  });
  const groups: PlayerId[][] = [];
  let lastScore: number | null = null;
  let lastRows: number | null = null;
  for (const player of sorted) {
    const score = boardOf(state, player).score;
    const rows = rowsByPlayer[player] ?? 0;
    if (lastScore !== null && score === lastScore && rows === lastRows) {
      groups[groups.length - 1]!.push(player);
    } else {
      groups.push([player]);
      lastScore = score;
      lastRows = rows;
    }
  }
  return groups;
}

function finishGame(
  state: AzulState,
  ctx: ActionContext<AzulState>,
  reason: 'row' | 'exhausted',
): void {
  if (state.finished) return;
  const profile = profileOf(state);
  const bonuses: Record<PlayerId, FinalBonus> = {};
  const rowsByPlayer: Record<PlayerId, number> = {};
  for (const player of state.players) {
    const board = boardOf(state, player);
    const bonus = finalBonusFor(profile, board.wall);
    bonuses[player] = bonus;
    rowsByPlayer[player] = bonus.rows;
    board.score += bonus.total;
    ctx.emit({
      type: 'log',
      key: 'az.finalScore',
      args: {
        player,
        bonus: bonus.total,
        rows: bonus.rows,
        columns: bonus.columns,
        colors: bonus.colors,
        score: board.score,
      },
    });
  }
  state.finalBonuses = bonuses;
  state.ranking = rankingOf(state, rowsByPlayer);
  state.finished = true;
  state.endReason = reason;
  state.tiling = null;
  ctx.emit({ type: 'log', key: 'az.gameEnd', args: { ranking: state.ranking } });
  for (const winner of state.ranking[0] ?? []) {
    ctx.emit({ type: 'achievement', player: winner, key: 'first-win' });
  }
  for (const player of state.players) {
    if (boardOf(state, player).score >= 100) {
      ctx.emit({ type: 'achievement', player, key: 'hundred' });
    }
  }
  ctx.goTo('finished');
}

function finishRound(state: AzulState, ctx: ActionContext<AzulState>): void {
  const profile = profileOf(state);
  for (const player of state.players) {
    const board = boardOf(state, player);
    const penalty = board.floor.reduce(
      (sum, _item, index) => sum + (profile.floor[index] ?? 0),
      0,
    );
    board.score = Math.max(0, board.score + penalty);
    for (const tile of board.floor) {
      if (tile !== 'marker') state.lid.push(tile);
    }
    board.floor = [];
    ctx.emit({
      type: 'log',
      key: 'az.floor',
      args: { player, penalty, score: board.score },
    });
  }

  const gameOver = state.players.some((player) =>
    boardOf(state, player).wall.some((row) => row.every((cell) => cell !== null)),
  );
  if (gameOver) {
    finishGame(state, ctx, 'row');
    return;
  }

  state.round += 1;
  state.starter = state.firstPlayer;
  state.turn = state.firstPlayer;
  state.markerInCenter = true;
  state.tiling = null;
  for (const factory of state.factories) {
    factory.tiles = drawTiles(state, 4, ctx.rng);
  }
  if (
    state.factories.every((factory) => factory.tiles.length === 0) &&
    state.center.length === 0
  ) {
    finishGame(state, ctx, 'exhausted');
    return;
  }
  state.phase = 'playing';
  ctx.emit({ type: 'log', key: 'az.round', args: { round: state.round } });
  ctx.goTo('playing');
}

/* ------------------------------------------------------------------ */
/* 创建状态                                                            */
/* ------------------------------------------------------------------ */

function createState(ctx: {
  players: PlayerId[];
  expansions?: string[];
  seed: number;
}): AzulState {
  const players = [...ctx.players];
  const expansions = [...(ctx.expansions ?? [])].filter((id) =>
    Object.values(EXPANSION).includes(id as (typeof EXPANSION)[keyof typeof EXPANSION]),
  );
  const profile = profileForExpansions(expansions);
  const rng = mulberry32(ctx.seed);

  const tiles: AzulTile[] = [];
  const joker = hasJokerTiles(expansions);
  const removePerColor = players.length <= 2 ? 1 : 2;
  const jokerCount = players.length <= 2 ? 5 : 10;
  for (const color of COLORS) {
    for (let index = 0; index < 20 - (joker ? removePerColor : 0); index += 1) {
      tiles.push(color);
    }
  }
  if (joker) {
    for (let index = 0; index < jokerCount; index += 1) tiles.push('joker');
  }
  const bag = shuffle(tiles, rng);

  const factoryCount = factoryCountFor(players.length);
  const special = expansions.includes(EXPANSION.specialFactories);
  const factories: AzulFactory[] = Array.from({ length: factoryCount }, (_, index) => ({
    type: special && index === 0 ? 'stay' : special && index === 1 ? 'shift' : 'normal',
    tiles: [],
  }));

  const firstPlayer = Math.floor(rng() * players.length);
  const boards = Object.fromEntries(players.map((player) => [player, emptyBoard()])) as Record<
    PlayerId,
    AzulBoard
  >;

  const state: AzulState = {
    players,
    turn: firstPlayer,
    round: 1,
    phase: 'playing',
    finished: false,
    ranking: null,
    rngSeed: nextSeed(ctx.seed),
    expansions,
    profile,
    factories,
    center: [],
    bag,
    lid: [],
    boards,
    starter: firstPlayer,
    firstPlayer,
    markerInCenter: true,
    doubleMarkers: expansions.includes(EXPANSION.doubleMarkers) ? [...COLORS] : [],
    tiling: null,
    endReason: null,
    finalBonuses: null,
  };

  for (const factory of state.factories) {
    factory.tiles = drawTiles(state, 4, rng);
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

interface TakePayload {
  factory: number | null;
  color: AzulColor | null;
  includeJokers?: boolean;
  line: number;
  shift?: Record<string, 'left' | 'right'>;
}

interface PlacePayload {
  line: number;
  col?: number;
  useDouble?: boolean;
}

function sourceHas(
  state: AzulState,
  source: number | null,
  color: AzulColor | null,
  includeJokers: boolean,
): { ok: boolean; reason?: string; count: number; leftovers: AzulTile[]; type: AzulFactory['type'] } {
  const tiles = source === null ? state.center : state.factories[source]?.tiles;
  if (!tiles) return { ok: false, reason: '工厂不存在', count: 0, leftovers: [], type: 'normal' };
  const wantJokers = color === null || includeJokers;
  if (color === null && !tiles.includes('joker')) {
    return { ok: false, reason: '这里没有百搭砖', count: 0, leftovers: [], type: 'normal' };
  }
  if (color !== null && !tiles.includes(color)) {
    return { ok: false, reason: '这里没有这种颜色', count: 0, leftovers: [], type: 'normal' };
  }
  if (includeJokers && !tiles.includes('joker')) {
    return { ok: false, reason: '这里没有百搭砖', count: 0, leftovers: [], type: 'normal' };
  }
  const taken = tiles.filter(
    (tile) => (color !== null && tile === color) || (wantJokers && tile === 'joker'),
  );
  const leftovers = tiles.filter((tile) => !taken.includes(tile));
  const type = source === null ? 'normal' : state.factories[source]!.type;
  return { ok: true, count: taken.length, leftovers, type };
}

function shiftGroups(leftovers: AzulTile[]): string[] {
  return [...new Set(leftovers)];
}

function validShift(
  state: AzulState,
  source: number | null,
  leftovers: AzulTile[],
  shift: Record<string, 'left' | 'right'> | undefined,
): ValidationResult {
  if (leftovers.length === 0) return { ok: true };
  if (source === null) return { ok: true };
  const type = state.factories[source]?.type ?? 'normal';
  if (type !== 'shift') {
    if (shift) return { ok: false, reason: '这个工厂不需要分配余砖' };
    return { ok: true };
  }
  const groups = shiftGroups(leftovers);
  if (!shift) return { ok: false, reason: '请选择剩余砖移向左边还是右边' };
  const keys = Object.keys(shift);
  if (keys.length !== groups.length) return { ok: false, reason: '剩余砖要全部分配' };
  for (const group of groups) {
    if (shift[group] !== 'left' && shift[group] !== 'right') {
      return { ok: false, reason: '剩余砖方向不合法' };
    }
  }
  for (const key of keys) {
    if (!groups.includes(key)) return { ok: false, reason: '分配了不存在的剩余砖' };
  }
  return { ok: true };
}

const takeTiles: ActionDef<AzulState> = {
  allowedIn: ['playing'],
  schema: z.object({
    factory: z.number().int().min(0).max(8).nullable(),
    color: z.enum(COLORS).nullable(),
    includeJokers: z.boolean().optional(),
    line: z.number().int().min(-1).max(4),
    shift: z.record(z.enum(['left', 'right'])).optional(),
  }),
  validate(state, action, ctx) {
    if (state.finished) return { ok: false, reason: '对局已结束' };
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    // legalActions 会以 { type } 调 validate，没有 payload；只做类型可用性提示
    if (!action.payload || typeof action.payload !== 'object') return { ok: true };
    const payload = action.payload as TakePayload;
    if (payload.factory !== null) {
      if (payload.factory >= state.factories.length) return { ok: false, reason: '工厂不存在' };
    }
    const source = sourceHas(state, payload.factory, payload.color, payload.includeJokers === true);
    if (!source.ok) return { ok: false, reason: source.reason ?? '不能从这里拿砖' };
    if (source.count === 0) return { ok: false, reason: '没有可拿的砖' };

    if (payload.line >= 0) {
      const profile = profileOf(state);
      const board = boardOf(state, ctx.playerId);
      if (!patternAccepts(profile, board, payload.line, payload.color)) {
        return { ok: false, reason: '这条图案行不能放这种砖' };
      }
    }

    const shift = validShift(state, payload.factory, source.leftovers, payload.shift);
    if (!shift.ok) return shift;
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as TakePayload;
    const playerIndex = state.turn;
    const board = boardOf(state, ctx.playerId);
    const source = takeFromSource(
      state,
      payload.factory,
      payload.color,
      payload.includeJokers === true,
    );

    if (source.marker) {
      state.firstPlayer = playerIndex;
      addMarker(state, board);
      ctx.emit({ type: 'log', key: 'az.marker', args: { player: ctx.playerId } });
    }

    if (payload.factory !== null) {
      moveLeftovers(state, payload.factory, source.leftovers, payload.shift);
    }

    if (payload.line === -1) {
      addFloor(state, board, source.taken);
    } else {
      const row = board.patterns[payload.line]!;
      const free = lineCapacity(payload.line) - row.length;
      row.push(...source.taken.slice(0, free));
      addFloor(state, board, source.taken.slice(free));
    }

    ctx.emit({
      type: 'log',
      key: 'az.take',
      args: {
        player: ctx.playerId,
        factory: payload.factory,
        color: payload.color ?? 'joker',
        jokers: payload.includeJokers === true,
        count: source.taken.length,
        line: payload.line,
        marker: source.marker,
        shift: payload.shift ?? null,
      },
    });

    const empty =
      state.factories.every((factory) => factory.tiles.length === 0) &&
      state.center.length === 0;
    if (empty) {
      continueTiling(state, ctx);
    } else {
      state.turn = (state.turn + 1) % state.players.length;
    }
  },
};

const placeWallAction: ActionDef<AzulState> = {
  allowedIn: ['tiling'],
  schema: z.object({
    line: z.number().int().min(0).max(4),
    col: z.number().int().min(0).max(4).optional(),
    useDouble: z.boolean().optional(),
  }),
  validate(state, action, ctx) {
    if (!state.tiling) return { ok: false, reason: '现在不需要上墙选择' };
    const node = state.tiling;
    if (state.players[node.player] !== ctx.playerId) return { ok: false, reason: '还没轮到你上墙' };
    if (!action.payload || typeof action.payload !== 'object') return { ok: true };
    const payload = action.payload as PlacePayload;
    if (payload.line !== node.line) return { ok: false, reason: '不是这一行' };
    const options = tilingOptions(state)!;
    if (payload.col === undefined || !options.columns.includes(payload.col)) {
      return { ok: false, reason: '这个位置不能放' };
    }
    if (payload.useDouble && !options.doubleColumns.includes(payload.col)) {
      return { ok: false, reason: '这一格不能使用双倍标记' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as PlacePayload;
    const options = tilingOptions(state)!;
    const useDouble = payload.useDouble === true;
    placeWall(state, ctx, state.tiling!.player, options.line, payload.col!, useDouble);
    state.tiling = null;
    continueTiling(state, ctx);
  },
};

/* ------------------------------------------------------------------ */
/* 合法动作                                                            */
/* ------------------------------------------------------------------ */

function lineTargets(
  state: AzulState,
  player: PlayerId,
  color: AzulColor | null,
): number[] {
  const profile = profileOf(state);
  const board = boardOf(state, player);
  const out: number[] = [];
  for (let line = 0; line < 5; line += 1) {
    if (patternAccepts(profile, board, line, color)) out.push(line);
  }
  out.push(-1);
  return out;
}

function shiftCombinations(groups: string[]): Record<string, 'left' | 'right'>[] {
  if (groups.length === 0) return [];
  const out: Record<string, 'left' | 'right'>[] = [];
  const total = 2 ** groups.length;
  for (let mask = 0; mask < total; mask += 1) {
    const value: Record<string, 'left' | 'right'> = {};
    groups.forEach((group, index) => {
      value[group] = (mask & (1 << index)) === 0 ? 'left' : 'right';
    });
    out.push(value);
  }
  return out;
}

function availableMoves(state: AzulState, playerId: PlayerId): AnyAction[] {
  if (state.finished) return [];
  if (state.phase === 'tiling') {
    if (!state.tiling || state.players[state.tiling.player] !== playerId) return [];
    const options = tilingOptions(state);
    if (!options) return [];
    const out: AnyAction[] = [];
    for (const col of options.columns) {
      out.push({ type: 'placeWall', payload: { line: options.line, col } });
      if (options.doubleColumns.includes(col)) {
        out.push({ type: 'placeWall', payload: { line: options.line, col, useDouble: true } });
      }
    }
    return out;
  }
  if (state.phase !== 'playing' || currentPlayer(state) !== playerId) return [];

  const out: AnyAction[] = [];
  const sources: (number | null)[] = [null, ...state.factories.map((_factory, index) => index)];
  for (const source of sources) {
    const tiles = source === null ? state.center : state.factories[source]!.tiles;
    if (tiles.length === 0) continue;
    const colors = [...new Set(tiles.filter((tile): tile is AzulColor => tile !== 'joker'))];
    const hasJoker = tiles.includes('joker');
    const selections: { color: AzulColor | null; includeJokers: boolean }[] = [];
    for (const color of colors) {
      selections.push({ color, includeJokers: false });
      if (hasJoker) selections.push({ color, includeJokers: true });
    }
    if (hasJoker) selections.push({ color: null, includeJokers: false });

    for (const selection of selections) {
      const sourceInfo = sourceHas(state, source, selection.color, selection.includeJokers);
      if (!sourceInfo.ok) continue;
      const groups =
        source !== null && state.factories[source]!.type === 'shift'
          ? shiftGroups(sourceInfo.leftovers)
          : [];
      const shifts = groups.length > 0 ? shiftCombinations(groups) : [undefined];
      for (const line of lineTargets(state, playerId, selection.color)) {
        for (const shift of shifts) {
          out.push({
            type: 'takeTiles',
            payload: {
              factory: source,
              color: selection.color,
              ...(selection.includeJokers ? { includeJokers: true } : {}),
              line,
              ...(shift ? { shift } : {}),
            },
          });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function playerView(state: AzulState, player: PlayerId) {
  const board = boardOf(state, player);
  return {
    id: player,
    patterns: board.patterns,
    wall: board.wall,
    floor: board.floor,
    score: board.score,
    usedDouble: board.usedDouble,
  };
}

function view(state: AzulState): PublicView {
  const options = tilingOptions(state);
  return {
    phase: state.phase,
    players: state.players,
    turn: state.finished ? null : state.players[state.turn] ?? null,
    round: state.round,
    finished: state.finished,
    ranking: state.ranking,
    data: {
      expansions: state.expansions,
      profile: state.profile,
      factories: state.factories,
      center: state.center,
      bagCount: state.bag.length,
      lidCount: state.lid.length,
      markerInCenter: state.markerInCenter,
      starter: state.players[state.starter] ?? null,
      firstPlayer: state.players[state.firstPlayer] ?? null,
      doubleMarkers: state.doubleMarkers,
      tiling: options,
      players: state.players.map((player) => playerView(state, player)),
      finalBonuses: state.finalBonuses,
      endReason: state.endReason,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

const states: Record<string, StateDef<AzulState>> = {
  playing: {
    type: 'activePlayer',
    onTimeout(state) {
      const moves = availableMoves(state, currentPlayer(state));
      return moves.find((move) => (move.payload as { line?: number }).line !== -1) ?? moves[0] ?? null;
    },
  },
  tiling: {
    type: 'activePlayer',
    onTimeout(state) {
      const player = state.tiling ? state.players[state.tiling.player] : null;
      if (!player) return null;
      return availableMoves(state, player)[0] ?? null;
    },
  },
  finished: { type: 'global' },
};

const plugin: GamePlugin<AzulState> = {
  manifest,
  createState(ctx) {
    return createState({
      players: ctx.players,
      expansions: ctx.expansions,
      seed: ctx.seed,
    });
  },
  states,
  actions: {
    takeTiles,
    placeWall: placeWallAction,
  },
  view(state) {
    return view(state);
  },
  legalMoves(state, playerId) {
    return availableMoves(state, playerId);
  },
};

export default plugin;
export { plugin, createState };
export type { AzulState, AzulColor, AzulTile, AzulBoard };
