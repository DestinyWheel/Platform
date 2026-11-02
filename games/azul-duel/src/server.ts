/**
 * 花砖物语：对决（Azul Duel）—— 服务端规则。
 *
 * 规则来源：根目录 EN_AzulDuel_Rulebook_compressed.pdf。
 * 18 块穹顶板先用平衡的可玩数据，板面细节待素材核对。
 */
import { z } from 'zod';
import type {
  ActionContext,
  ActionDef,
  AnyAction,
  BaseState,
  GamePlugin,
  PlayerId,
  PublicView,
  SetupContext,
  StateDef,
} from '@platform/sdk';
import {
  AZUL_COLORS,
  BEGINNER_GOALS,
  CHIP_BY_ID,
  CHIPS,
  FULL_GOALS,
  PLATE_BY_ID,
  PLATES,
  SCORING_GOALS,
  SPECIAL_TILE_COUNT,
  chipMatches,
  rotatedCells,
  type AzulColor,
  type PlateCell,
  type ScoringGoalId,
} from './plates';

const SMALL_FACTORIES = 4;
const PLATE_SLOTS = 9;
const BOARD_SIZE = 6;

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

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

function zeroed<T>(players: PlayerId[], make: () => T): Record<PlayerId, T> {
  return Object.fromEntries(players.map((player) => [player, make()]));
}

interface SmallFactory {
  sun: AzulColor[];
  /** 末尾是堆顶 */
  moon: AzulColor[];
  chipId: string | null;
  chipRevealed: boolean;
}

interface LargeFactory {
  sun: AzulColor[];
  moon: (AzulColor | null)[];
}

interface PlacedPlate {
  plateId: string;
  rotation: number;
}

interface PlayerBoard {
  /** 6 条图案行，下标 0 对应容量 1 */
  patterns: AzulColor[][];
  /** 9 个板槽，3×3 */
  plates: (PlacedPlate | null)[];
  /** 6×6 已放砖；'special' 表示特殊砖 */
  dome: (AzulColor | 'special' | null)[];
  broken: AzulColor[];
  chips: string[];
  usedChips: string[];
  score: number;
  tokensUsed: number;
  chipsTaken: number;
}

interface RoundSummary {
  round: number;
  scores: Record<PlayerId, number>;
}

export interface AzulDuelState extends BaseState {
  bag: AzulColor[];
  tower: AzulColor[];
  factories: {
    small: SmallFactory[];
    large: LargeFactory;
  };
  chipSupply: string[];
  plateDisplay: string[];
  platePile: string[];
  specialTiles: number;
  /** 'factory' 或持有先手砖的玩家 */
  startTile: string;
  startingPlayer: PlayerId;
  setupPicks: number;
  boards: Record<PlayerId, PlayerBoard>;
  scoringGoals: ScoringGoalId[];
  tilingDone: Record<PlayerId, boolean>;
  lastRound: RoundSummary | null;
}

function currentPlayer(state: AzulDuelState): PlayerId {
  return state.players[state.turn]!;
}

function otherPlayer(state: AzulDuelState, player: PlayerId): PlayerId {
  return state.players.find((item) => item !== player) ?? state.players[0]!;
}

function boardOf(state: AzulDuelState, player: PlayerId): PlayerBoard {
  return state.boards[player]!;
}

function lineCapacity(line: number): number {
  return line + 1;
}

function plateRow(line: number): number {
  return Math.floor(line / 2);
}

function emptyBoard(): PlayerBoard {
  return {
    patterns: Array.from({ length: 6 }, () => []),
    plates: Array.from({ length: PLATE_SLOTS }, () => null),
    dome: Array.from({ length: 36 }, () => null),
    broken: [],
    chips: [],
    usedChips: [],
    score: 0,
    tokensUsed: 0,
    chipsTaken: 0,
  };
}

function domeCellColor(
  board: PlayerBoard,
  row: number,
  col: number,
): PlateCell | null {
  const slotRow = Math.floor(row / 2);
  const slotCol = Math.floor(col / 2);
  const slot = slotRow * 3 + slotCol;
  const placed = board.plates[slot];
  if (!placed) return null;
  const plate = PLATE_BY_ID[placed.plateId];
  if (!plate) return null;
  const local = (row % 2) * 2 + (col % 2);
  return rotatedCells(plate, placed.rotation)[local] ?? null;
}

function domeIndex(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

function drawTiles(state: AzulDuelState, count: number, rng: () => number): AzulColor[] {
  const result: AzulColor[] = [];
  for (let index = 0; index < count; index += 1) {
    if (state.bag.length === 0) {
      if (state.tower.length === 0) break;
      state.bag = shuffle(state.tower, rng);
      state.tower = [];
    }
    const tile = state.bag.pop();
    if (tile) result.push(tile);
  }
  return result;
}

function fillLargeSun(state: AzulDuelState, rng: () => number): AzulColor[] {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tiles = drawTiles(state, 5, rng);
    if (tiles.length < 5) return tiles;
    if (new Set(tiles).size === 1 && state.bag.length + state.tower.length >= 5) {
      state.bag.push(...tiles);
      state.bag = shuffle(state.bag, rng);
      continue;
    }
    return tiles;
  }
  return drawTiles(state, 5, rng);
}

function refillFactories(state: AzulDuelState, rng: () => number): void {
  state.factories.large.sun = fillLargeSun(state, rng);
  state.factories.large.moon = Array.from({ length: 5 }, () => null);
  for (const factory of state.factories.small) {
    factory.sun = drawTiles(state, 4, rng);
    factory.moon = [];
    factory.chipId = state.chipSupply.pop() ?? null;
    factory.chipRevealed = factory.sun.length === 0 && factory.moon.length === 0;
  }
}

function refillPlateDisplay(state: AzulDuelState): void {
  while (state.plateDisplay.length < 3 && state.platePile.length > 0) {
    state.plateDisplay.push(state.platePile.pop()!);
  }
}

function revealChips(state: AzulDuelState): void {
  for (const factory of state.factories.small) {
    if (factory.sun.length === 0 && factory.moon.length === 0) factory.chipRevealed = true;
  }
}

function factoriesEmpty(state: AzulDuelState): boolean {
  if (state.factories.large.sun.length > 0) return false;
  if (state.factories.large.moon.some((tile) => tile != null)) return false;
  return state.factories.small.every(
    (factory) =>
      factory.sun.length === 0 && factory.moon.length === 0 && factory.chipId == null,
  );
}

function tokensReady(state: AzulDuelState): boolean {
  if (state.round >= 5) return true;
  return state.players.every((player) => (boardOf(state, player).tokensUsed ?? 0) >= 2);
}

function addTilesToPattern(
  board: PlayerBoard,
  line: number,
  color: AzulColor,
  picked: AzulColor[],
): AzulColor[] {
  const pattern = board.patterns[line]!;
  const capacity = lineCapacity(line);
  if (pattern.length > 0 && pattern[0] !== color) return [...picked];
  if (pattern.length >= capacity) return [...picked];
  const room = capacity - pattern.length;
  const placed = picked.slice(0, room);
  const broken = picked.slice(room);
  pattern.push(...placed);
  return broken;
}

function addBroken(state: AzulDuelState, board: PlayerBoard, tiles: AzulColor[]): void {
  for (const tile of tiles) {
    if (board.broken.length < 4) board.broken.push(tile);
    else state.tower.push(tile);
  }
}

function hasMatchingCell(state: AzulDuelState, player: PlayerId, line: number): boolean {
  const board = boardOf(state, player);
  const pattern = board.patterns[line]!;
  if (pattern.length === 0) return false;
  const color = pattern[0]!;
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    if (board.dome[domeIndex(line, col)] != null) continue;
    const cell = domeCellColor(board, line, col);
    if (cell === color || cell === 'joker') return true;
  }
  return false;
}

function plateRowFilled(board: PlayerBoard, line: number): boolean {
  const row = plateRow(line);
  return [0, 1, 2].every((col) => board.plates[row * 3 + col] != null);
}

function firstTileableLine(state: AzulDuelState, player: PlayerId): number | null {
  const board = boardOf(state, player);
  for (let line = 0; line < 6; line += 1) {
    const pattern = board.patterns[line]!;
    if (pattern.length !== lineCapacity(line)) continue;
    if (hasMatchingCell(state, player, line)) return line;
    // 没有可放位置且这一行三块板都放满了：等 endTiling 时进破损，不阻塞下面的行
    if (plateRowFilled(board, line)) continue;
  }
  return null;
}

function breakUnplaceable(state: AzulDuelState, player: PlayerId): void {
  const board = boardOf(state, player);
  for (let line = 0; line < 6; line += 1) {
    const pattern = board.patterns[line]!;
    if (pattern.length !== lineCapacity(line)) continue;
    if (hasMatchingCell(state, player, line)) continue;
    if (!plateRowFilled(board, line)) continue;
    addBroken(state, board, pattern);
    board.patterns[line] = [];
  }
}

function linkedCount(board: PlayerBoard, row: number, col: number, dr: number, dc: number): number {
  let count = 1;
  for (const direction of [1, -1]) {
    let nextRow = row + dr * direction;
    let nextCol = col + dc * direction;
    while (
      nextRow >= 0 &&
      nextRow < BOARD_SIZE &&
      nextCol >= 0 &&
      nextCol < BOARD_SIZE &&
      board.dome[domeIndex(nextRow, nextCol)] != null
    ) {
      count += 1;
      nextRow += dr * direction;
      nextCol += dc * direction;
    }
  }
  return count;
}

function tilePlacementScore(board: PlayerBoard, row: number, col: number): number {
  const horizontal = linkedCount(board, row, col, 0, 1);
  const vertical = linkedCount(board, row, col, 1, 0);
  if (horizontal === 1 && vertical === 1) return 1;
  return (horizontal > 1 ? horizontal : 0) + (vertical > 1 ? vertical : 0);
}

function maybePlaceSpecial(
  state: AzulDuelState,
  player: PlayerId,
  row: number,
  col: number,
): number {
  const board = boardOf(state, player);
  const slotRow = Math.floor(row / 2);
  const slotCol = Math.floor(col / 2);
  const slot = slotRow * 3 + slotCol;
  const placed = board.plates[slot];
  if (!placed) return 0;
  const plate = PLATE_BY_ID[placed.plateId];
  if (!plate || plate.kind !== 'special') return 0;
  const cells = rotatedCells(plate, placed.rotation);
  const specialLocal = cells.findIndex((cell) => cell === 'special');
  if (specialLocal < 0) return 0;
  const specialRow = slotRow * 2 + Math.floor(specialLocal / 2);
  const specialCol = slotCol * 2 + (specialLocal % 2);
  const specialIndex = domeIndex(specialRow, specialCol);
  if (board.dome[specialIndex] != null) return 0;
  const colorLocals = cells
    .map((cell, index) => (cell !== 'special' && cell !== 'joker' ? index : -1))
    .filter((index) => index >= 0);
  const completed = colorLocals.every((local) => {
    const cellRow = slotRow * 2 + Math.floor(local / 2);
    const cellCol = slotCol * 2 + (local % 2);
    return board.dome[domeIndex(cellRow, cellCol)] != null;
  });
  if (!completed || state.specialTiles <= 0) return 0;
  board.dome[specialIndex] = 'special';
  state.specialTiles -= 1;
  return specialRow + 1;
}

function checkPhaseEnd(state: AzulDuelState, ctx: ActionContext<AzulDuelState>): boolean {
  if (!factoriesEmpty(state) || !tokensReady(state)) return false;
  state.tilingDone = zeroed(state.players, () => false);
  state.turn = state.players.indexOf(state.startingPlayer);
  ctx.goTo('tiling');
  return true;
}

function advanceTurn(state: AzulDuelState): void {
  state.turn = (state.turn + 1) % state.players.length;
}

function playersWithScore(state: AzulDuelState): Record<PlayerId, number> {
  return Object.fromEntries(state.players.map((player) => [player, boardOf(state, player).score]));
}

function domeFilled(board: PlayerBoard, row: number, col: number): boolean {
  return board.dome[domeIndex(row, col)] != null;
}

function specialCellIndexes(board: PlayerBoard): number[] {
  const result: number[] = [];
  for (let slot = 0; slot < PLATE_SLOTS; slot += 1) {
    const placed = board.plates[slot];
    if (!placed) continue;
    const plate = PLATE_BY_ID[placed.plateId];
    if (!plate || plate.kind !== 'special') continue;
    const cells = rotatedCells(plate, placed.rotation);
    cells.forEach((cell, local) => {
      if (cell !== 'special') return;
      const row = Math.floor(slot / 3) * 2 + Math.floor(local / 2);
      const col = (slot % 3) * 2 + (local % 2);
      result.push(domeIndex(row, col));
    });
  }
  return result;
}

function scoreGoals(state: AzulDuelState, player: PlayerId): { total: number; lines: string[] } {
  const board = boardOf(state, player);
  let total = 0;
  const lines: string[] = [];
  const add = (label: string, value: number): void => {
    if (value === 0) return;
    total += value;
    lines.push(`${label} ${value > 0 ? '+' : ''}${value}`);
  };

  const isRowFull = (row: number): boolean => [0, 1, 2, 3, 4, 5].every((col) => domeFilled(board, row, col));
  const isColFull = (col: number): boolean => [0, 1, 2, 3, 4, 5].every((row) => domeFilled(board, row, col));

  if (state.scoringGoals.includes('row')) {
    const count = [0, 1, 2, 3, 4, 5].filter(isRowFull).length;
    add('完整横线', count * 3);
  }
  if (state.scoringGoals.includes('column')) {
    const count = [0, 1, 2, 3, 4, 5].filter(isColFull).length;
    add('完整竖线', count * 7);
  }
  if (state.scoringGoals.includes('diagonal')) {
    const main = [0, 1, 2, 3, 4, 5].every((index) => domeFilled(board, index, index));
    const anti = [0, 1, 2, 3, 4, 5].every((index) => domeFilled(board, index, 5 - index));
    add('完整对角线', (Number(main) + Number(anti)) * 10);
  }

  const jokerCells: number[] = [];
  const specialCells: number[] = [];
  for (let slot = 0; slot < PLATE_SLOTS; slot += 1) {
    const placed = board.plates[slot];
    if (!placed) continue;
    const plate = PLATE_BY_ID[placed.plateId];
    if (!plate) continue;
    const cells = rotatedCells(plate, placed.rotation);
    for (let local = 0; local < 4; local += 1) {
      const row = Math.floor(slot / 3) * 2 + Math.floor(local / 2);
      const col = (slot % 3) * 2 + (local % 2);
      const index = domeIndex(row, col);
      if (cells[local] === 'joker') jokerCells.push(index);
      if (cells[local] === 'special') specialCells.push(index);
    }
  }

  if (state.scoringGoals.includes('joker') && jokerCells.length > 0) {
    if (jokerCells.every((index) => board.dome[index] != null)) {
      add('万能格全满', jokerCells.length * 2);
    }
  }

  if (state.scoringGoals.includes('fiveColorRow')) {
    let count = 0;
    for (let row = 0; row < 6; row += 1) {
      if (!isRowFull(row)) continue;
      const colors = new Set<string>();
      for (let col = 0; col < 6; col += 1) {
        const tile = board.dome[domeIndex(row, col)];
        if (tile != null) colors.add(tile);
      }
      if (colors.size >= 5) count += 1;
    }
    add('五色横线', count * 4);
  }

  if (state.scoringGoals.includes('outer')) {
    let count = 0;
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        if (row === 0 || row === 5 || col === 0 || col === 5) {
          if (domeFilled(board, row, col)) count += 1;
        }
      }
    }
    add('外圈', count);
  }

  if (state.scoringGoals.includes('corner')) {
    let count = 0;
    for (const slot of [0, 2, 6, 8]) {
      const placed = board.plates[slot];
      if (!placed) continue;
      const slotRow = Math.floor(slot / 3);
      const slotCol = slot % 3;
      const full = [0, 1, 2, 3].every((local) => {
        const row = slotRow * 2 + Math.floor(local / 2);
        const col = slotCol * 2 + (local % 2);
        return domeFilled(board, row, col);
      });
      if (full) count += 1;
    }
    add('四角板', count * 3);
  }

  if (state.scoringGoals.includes('emptySpecial')) {
    const empty = specialCells.filter((index) => board.dome[index] == null).length;
    add('空特殊格', -3 * empty);
  }

  return { total, lines };
}

function finishGame(state: AzulDuelState, ctx: ActionContext<AzulDuelState>): void {
  for (const player of state.players) {
    const board = boardOf(state, player);
    const goals = scoreGoals(state, player);
    board.score = Math.max(0, board.score + goals.total);
    if (goals.lines.length > 0) {
      ctx.emit({
        type: 'log',
        key: 'ad.finalScore',
        args: { player, lines: goals.lines, score: board.score },
      });
    }
  }
  const scores = playersWithScore(state);
  const tieHolder = state.startTile !== 'factory' ? state.startTile : state.startingPlayer;
  const sorted = [...state.players].sort((left, right) => {
    const diff = (scores[right] ?? 0) - (scores[left] ?? 0);
    if (diff !== 0) return diff;
    if (left === tieHolder) return -1;
    if (right === tieHolder) return 1;
    return 0;
  });
  const winner = sorted[0]!;
  state.finished = true;
  state.ranking = [[winner], [otherPlayer(state, winner)]];
  ctx.emit({ type: 'log', key: 'ad.gameEnd', args: { winner, scores } });
  ctx.emit({ type: 'achievement', player: winner, key: 'first-win' });
  for (const player of state.players) {
    if ((scores[player] ?? 0) >= 100) {
      ctx.emit({ type: 'achievement', player, key: 'dome-master' });
    }
    const board = boardOf(state, player);
    const specials = specialCellIndexes(board);
    if (specials.length > 0 && specials.every((index) => board.dome[index] != null)) {
      ctx.emit({ type: 'achievement', player, key: 'specialist' });
    }
  }
  ctx.goTo('finished');
}

function resolveTiling(state: AzulDuelState, ctx: ActionContext<AzulDuelState>): void {
  for (const player of state.players) {
    const board = boardOf(state, player);
    if (board.broken.length > 0) {
      const penalty = [0, 1, 3, 6, 10][Math.min(4, board.broken.length)] ?? 10;
      board.score = Math.max(0, board.score - penalty);
      state.tower.push(...board.broken);
      ctx.emit({
        type: 'log',
        key: 'ad.broken',
        args: { player, tiles: board.broken.length, penalty },
      });
      board.broken = [];
    }
    if (state.startTile === player) {
      board.score = Math.max(0, board.score - 2);
      ctx.emit({ type: 'log', key: 'ad.startPenalty', args: { player } });
    }
  }

  if (state.round >= 5) {
    finishGame(state, ctx);
    return;
  }

  if (state.startTile !== 'factory') state.startingPlayer = state.startTile;
  state.startTile = 'factory';
  state.lastRound = { round: state.round, scores: playersWithScore(state) };
  state.round += 1;
  for (const player of state.players) {
    const board = boardOf(state, player);
    board.tokensUsed = 0;
    board.chipsTaken = 0;
    board.broken = [];
  }
  refillPlateDisplay(state);
  refillFactories(state, ctx.rng);
  state.tilingDone = zeroed(state.players, () => false);
  state.turn = state.players.indexOf(state.startingPlayer);
  ctx.emit({ type: 'log', key: 'ad.round', args: { round: state.round } });
  ctx.goTo('playing');
}

function afterPlayingAction(state: AzulDuelState, ctx: ActionContext<AzulDuelState>): void {
  if (checkPhaseEnd(state, ctx)) return;
  advanceTurn(state);
}

function availableMoves(state: AzulDuelState, player: PlayerId): AnyAction[] {
  const moves: AnyAction[] = [];
  if (state.phase === 'setup') {
    if (currentPlayer(state) !== player) return [];
    for (const plateId of state.plateDisplay) {
      for (let rotation = 0; rotation < 4; rotation += 1) {
        for (let slot = 0; slot < PLATE_SLOTS; slot += 1) {
          if (!boardOf(state, player).plates[slot]) {
            moves.push({ type: 'placeSetupPlate', payload: { plateId, rotation, slot } });
          }
        }
      }
    }
    return moves;
  }

  if (state.phase === 'tiling') {
    if (currentPlayer(state) !== player) return [];
    const board = boardOf(state, player);
    const first = firstTileableLine(state, player);
    if (first != null) {
      const color = board.patterns[first]![0]!;
      for (let col = 0; col < 6; col += 1) {
        const index = domeIndex(first, col);
        if (board.dome[index] != null) continue;
        const cell = domeCellColor(board, first, col);
        if (cell === color || cell === 'joker') {
          moves.push({ type: 'placeDomeTile', payload: { line: first, row: first, col } });
        }
      }
    }
    for (let line = 0; line < 6; line += 1) {
      const pattern = board.patterns[line]!;
      if (pattern.length === 0 || pattern.length === lineCapacity(line)) continue;
      const color = pattern[0]!;
      const matching = board.chips.filter((chipId) => {
        const chip = CHIP_BY_ID[chipId];
        return chip ? chipMatches(chip, color) : false;
      });
      if (matching.length >= 2 || board.chips.length >= 3) {
        moves.push({ type: 'spendBonus', payload: { line } });
      }
    }
    if (first == null) moves.push({ type: 'endTiling', payload: {} });
    return moves;
  }

  if (state.phase !== 'playing') return [];
  if (currentPlayer(state) !== player) return [];
  const board = boardOf(state, player);

  if (state.round < 5 && board.tokensUsed < 2) {
    for (const plateId of state.plateDisplay) {
      for (let rotation = 0; rotation < 4; rotation += 1) {
        for (let slot = 0; slot < PLATE_SLOTS; slot += 1) {
          if (!board.plates[slot]) {
            moves.push({ type: 'takePlate', payload: { plateId, rotation, slot } });
          }
        }
      }
    }
    if (state.platePile.length > 0 && board.score > 0) {
      for (let rotation = 0; rotation < 4; rotation += 1) {
        for (let slot = 0; slot < PLATE_SLOTS; slot += 1) {
          if (!board.plates[slot]) {
            moves.push({ type: 'drawPlate', payload: { rotation, slot } });
          }
        }
      }
    }
  }

  for (let factoryIndex = 0; factoryIndex < SMALL_FACTORIES; factoryIndex += 1) {
    const factory = state.factories.small[factoryIndex]!;
    for (const color of new Set(factory.sun)) {
      for (let line = 0; line < 6; line += 1) {
        moves.push({ type: 'takeTiles', payload: { factory: factoryIndex, mode: 'sun', color, line } });
      }
    }
  }
  for (const color of new Set(state.factories.large.sun)) {
    for (let line = 0; line < 6; line += 1) {
      moves.push({ type: 'takeTiles', payload: { factory: 4, mode: 'sun', color, line } });
    }
  }

  const moonColors = new Set<AzulColor>();
  for (const factory of state.factories.small) {
    const top = factory.moon[factory.moon.length - 1];
    if (top) moonColors.add(top);
  }
  for (const tile of state.factories.large.moon) if (tile) moonColors.add(tile);
  for (const color of moonColors) {
    for (let line = 0; line < 6; line += 1) {
      moves.push({ type: 'takeTiles', payload: { factory: 0, mode: 'moon', color, line } });
    }
  }

  state.factories.small.forEach((factory, index) => {
    if (factory.chipRevealed && factory.chipId && board.chipsTaken < 2) {
      moves.push({ type: 'takeBonus', payload: { factory: index } });
    }
  });

  if (moves.length === 0) moves.push({ type: 'pass', payload: {} });
  return moves;
}

const setupPlate: ActionDef<AzulDuelState> = {
  allowedIn: ['setup'],
  schema: z.object({
    plateId: z.string().min(1),
    rotation: z.number().int().min(0).max(3),
    slot: z.number().int().min(0).max(8),
  }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你选板' };
    const payload = action.payload as { plateId: string; slot: number };
    if (!state.plateDisplay.includes(payload.plateId)) return { ok: false, reason: '这张板不在展示区' };
    if (boardOf(state, ctx.playerId).plates[payload.slot]) return { ok: false, reason: '这个位置已经有板了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { plateId, rotation, slot } = action.payload as {
      plateId: string;
      rotation: number;
      slot: number;
    };
    const board = boardOf(state, ctx.playerId);
    board.plates[slot] = { plateId, rotation };
    state.plateDisplay = state.plateDisplay.filter((id) => id !== plateId);
    refillPlateDisplay(state);
    state.setupPicks += 1;
    const startIndex = state.players.indexOf(state.startingPlayer);
    if (state.setupPicks >= 2) {
      state.turn = startIndex;
      ctx.goTo('playing');
    } else {
      state.turn = startIndex;
    }
    ctx.emit({ type: 'log', key: 'ad.setupPlate', args: { player: ctx.playerId } });
  },
};

const takePlate: ActionDef<AzulDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({
    plateId: z.string().min(1),
    rotation: z.number().int().min(0).max(3),
    slot: z.number().int().min(0).max(8),
  }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.round >= 5) return { ok: false, reason: '第五轮不再拿穹顶板' };
    const board = boardOf(state, ctx.playerId);
    if (board.tokensUsed >= 2) return { ok: false, reason: '这一轮的两个棋子都用完了' };
    const payload = action.payload as { plateId: string; slot: number };
    if (!state.plateDisplay.includes(payload.plateId)) return { ok: false, reason: '这张板不在展示区' };
    if (board.plates[payload.slot]) return { ok: false, reason: '这个位置已经有板了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { plateId, rotation, slot } = action.payload as {
      plateId: string;
      rotation: number;
      slot: number;
    };
    const board = boardOf(state, ctx.playerId);
    board.plates[slot] = { plateId, rotation };
    board.tokensUsed += 1;
    state.plateDisplay = state.plateDisplay.filter((id) => id !== plateId);
    ctx.emit({ type: 'log', key: 'ad.takePlate', args: { player: ctx.playerId } });
    afterPlayingAction(state, ctx);
  },
};

const drawPlate: ActionDef<AzulDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({
    rotation: z.number().int().min(0).max(3),
    slot: z.number().int().min(0).max(8),
  }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.round >= 5) return { ok: false, reason: '第五轮不再拿穹顶板' };
    const board = boardOf(state, ctx.playerId);
    if (board.tokensUsed >= 2) return { ok: false, reason: '这一轮的两个棋子都用完了' };
    if (board.score < 1) return { ok: false, reason: '分数不足 1，不能抽背面板' };
    if (state.platePile.length === 0) return { ok: false, reason: '背面板堆已经空了' };
    const payload = action.payload as { slot: number };
    if (board.plates[payload.slot]) return { ok: false, reason: '这个位置已经有板了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { rotation, slot } = action.payload as { rotation: number; slot: number };
    const board = boardOf(state, ctx.playerId);
    const plateId = state.platePile.pop();
    if (!plateId) return;
    board.plates[slot] = { plateId, rotation };
    board.tokensUsed += 1;
    board.score = Math.max(0, board.score - 1);
    ctx.emit({ type: 'log', key: 'ad.drawPlate', args: { player: ctx.playerId } });
    afterPlayingAction(state, ctx);
  },
};

const takeTiles: ActionDef<AzulDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({
    factory: z.number().int().min(0).max(4),
    mode: z.enum(['sun', 'moon']),
    color: z.enum(['navy', 'turquoise', 'yellow', 'red', 'black']),
    line: z.number().int().min(0).max(5),
    order: z.array(z.number().int().min(0).max(20)).optional(),
  }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const payload = action.payload as {
      factory: number;
      mode: 'sun' | 'moon';
      color: AzulColor;
      line: number;
    };
    if (payload.mode === 'sun') {
      const factory =
        payload.factory < SMALL_FACTORIES
          ? state.factories.small[payload.factory]
          : payload.factory === 4
            ? state.factories.large
            : null;
      if (!factory) return { ok: false, reason: '没有这个工厂' };
      if (!factory.sun.includes(payload.color)) return { ok: false, reason: '这个工厂太阳上没有这种颜色' };
      return { ok: true };
    }
    const available =
      state.factories.small.some(
        (factory) => factory.moon[factory.moon.length - 1] === payload.color,
      ) || state.factories.large.moon.some((tile) => tile === payload.color);
    if (!available) return { ok: false, reason: '所有月亮顶部都没有这种颜色' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as {
      factory: number;
      mode: 'sun' | 'moon';
      color: AzulColor;
      line: number;
      order?: number[];
    };
    const board = boardOf(state, ctx.playerId);
    const picked: AzulColor[] = [];
    let tookLargeMoon = false;

    if (payload.mode === 'sun') {
      if (payload.factory < SMALL_FACTORIES) {
        const factory = state.factories.small[payload.factory]!;
        picked.push(...factory.sun.filter((tile) => tile === payload.color));
        const remaining = factory.sun.filter((tile) => tile !== payload.color);
        factory.sun = [];
        const order = payload.order;
        const ordered =
          order && order.length === remaining.length && new Set(order).size === remaining.length
            ? order.map((index) => remaining[index]!)
            : remaining;
        factory.moon.push(...ordered);
        revealChips(state);
      } else {
        const factory = state.factories.large;
        picked.push(...factory.sun.filter((tile) => tile === payload.color));
        const remaining = factory.sun.filter((tile) => tile !== payload.color);
        factory.sun = [];
        const emptySlots = factory.moon
          .map((tile, index) => (tile == null ? index : -1))
          .filter((index) => index >= 0);
        const order = payload.order;
        const ordered =
          order && order.length === remaining.length && new Set(order).size === remaining.length
            ? order.map((index) => remaining[index]!)
            : remaining;
        ordered.forEach((tile, index) => {
          if (emptySlots[index] != null) factory.moon[emptySlots[index]!] = tile;
        });
      }
    } else {
      for (const factory of state.factories.small) {
        const top = factory.moon[factory.moon.length - 1];
        if (top === payload.color) picked.push(factory.moon.pop()!);
      }
      for (let index = 0; index < state.factories.large.moon.length; index += 1) {
        if (state.factories.large.moon[index] === payload.color) {
          picked.push(state.factories.large.moon[index]!);
          state.factories.large.moon[index] = null;
          tookLargeMoon = true;
        }
      }
      revealChips(state);
    }

    if (tookLargeMoon && state.startTile === 'factory') state.startTile = ctx.playerId;

    const broken = addTilesToPattern(board, payload.line, payload.color, picked);
    addBroken(state, board, broken);

    ctx.emit({
      type: 'log',
      key: 'ad.takeTiles',
      args: { player: ctx.playerId, color: payload.color, count: picked.length, line: payload.line + 1, broken: broken.length },
    });
    afterPlayingAction(state, ctx);
  },
};

const takeBonus: ActionDef<AzulDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({ factory: z.number().int().min(0).max(3) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const board = boardOf(state, ctx.playerId);
    if (board.chipsTaken >= 2) return { ok: false, reason: '这一轮已经拿过 2 个奖励片了' };
    const { factory } = action.payload as { factory: number };
    const target = state.factories.small[factory];
    if (!target) return { ok: false, reason: '没有这个工厂' };
    if (!target.chipRevealed || !target.chipId) return { ok: false, reason: '这个工厂的奖励片还没翻开' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { factory } = action.payload as { factory: number };
    const target = state.factories.small[factory]!;
    const chipId = target.chipId;
    if (!chipId) return;
    const board = boardOf(state, ctx.playerId);
    board.chips.push(chipId);
    board.chipsTaken += 1;
    target.chipId = null;
    target.chipRevealed = false;
    ctx.emit({ type: 'log', key: 'ad.takeBonus', args: { player: ctx.playerId } });
    afterPlayingAction(state, ctx);
  },
};

const pass: ActionDef<AzulDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const others = availableMoves(state, ctx.playerId).filter((move) => move.type !== 'pass');
    if (others.length > 0) return { ok: false, reason: '还有可以执行的动作，不能跳过' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    ctx.emit({ type: 'log', key: 'ad.pass', args: { player: ctx.playerId } });
    afterPlayingAction(state, ctx);
  },
};

const spendBonus: ActionDef<AzulDuelState> = {
  allowedIn: ['tiling'],
  schema: z.object({ line: z.number().int().min(0).max(5) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你铺砖' };
    const board = boardOf(state, ctx.playerId);
    const { line } = action.payload as { line: number };
    const pattern = board.patterns[line]!;
    if (pattern.length === 0) return { ok: false, reason: '这条图案行还没有砖' };
    if (pattern.length === lineCapacity(line)) return { ok: false, reason: '这条图案行已经满了' };
    const color = pattern[0]!;
    const matching = board.chips.filter((chipId) => {
      const chip = CHIP_BY_ID[chipId];
      return chip ? chipMatches(chip, color) : false;
    });
    if (matching.length < 2 && board.chips.length < 3) {
      return { ok: false, reason: '没有足够的奖励片（需要 2 片同色或任意 3 片）' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { line } = action.payload as { line: number };
    const board = boardOf(state, ctx.playerId);
    const pattern = board.patterns[line]!;
    const color = pattern[0]!;
    const matching = board.chips.filter((chipId) => {
      const chip = CHIP_BY_ID[chipId];
      return chip ? chipMatches(chip, color) : false;
    });
    const use = matching.length >= 2 ? matching.slice(0, 2) : board.chips.slice(0, 3);
    for (const chipId of use) {
      board.chips = board.chips.filter((id) => id !== chipId);
      board.usedChips.push(chipId);
    }
    pattern.push(color);
    ctx.emit({
      type: 'log',
      key: 'ad.spendBonus',
      args: { player: ctx.playerId, line: line + 1, chips: use.length },
    });
  },
};

const placeDomeTile: ActionDef<AzulDuelState> = {
  allowedIn: ['tiling'],
  schema: z.object({
    line: z.number().int().min(0).max(5),
    row: z.number().int().min(0).max(5),
    col: z.number().int().min(0).max(5),
  }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你铺砖' };
    const board = boardOf(state, ctx.playerId);
    const payload = action.payload as { line: number; row: number; col: number };
    if (payload.row !== payload.line) return { ok: false, reason: '图案行只能铺到对应行' };
    const pattern = board.patterns[payload.line]!;
    if (pattern.length !== lineCapacity(payload.line)) return { ok: false, reason: '这条图案行还没满' };
    const first = firstTileableLine(state, ctx.playerId);
    if (first !== payload.line) return { ok: false, reason: '要按从上到下顺序处理完整图案行' };
    const index = domeIndex(payload.row, payload.col);
    if (board.dome[index] != null) return { ok: false, reason: '这个穹顶格已经有砖了' };
    const cell = domeCellColor(board, payload.row, payload.col);
    if (cell == null) return { ok: false, reason: '这个格还没有穹顶板' };
    if (cell !== 'joker' && cell !== pattern[0]) return { ok: false, reason: '颜色不匹配' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { line, row, col } = action.payload as { line: number; row: number; col: number };
    const board = boardOf(state, ctx.playerId);
    const pattern = board.patterns[line]!;
    const color = pattern[0]!;
    const index = domeIndex(row, col);
    board.dome[index] = color;
    const residual = pattern.slice(1);
    state.tower.push(...residual);
    board.patterns[line] = [];
    let gained = tilePlacementScore(board, row, col);
    const specialPoints = maybePlaceSpecial(state, ctx.playerId, row, col);
    gained += specialPoints;
    board.score += gained;
    ctx.emit({
      type: 'log',
      key: 'ad.placeTile',
      args: { player: ctx.playerId, line: line + 1, points: gained, special: specialPoints > 0 },
    });
  },
};

const endTiling: ActionDef<AzulDuelState> = {
  allowedIn: ['tiling'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (firstTileableLine(state, ctx.playerId) != null) {
      return { ok: false, reason: '还有完整图案行可以铺到穹顶上' };
    }
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    breakUnplaceable(state, ctx.playerId);
    state.tilingDone[ctx.playerId] = true;
    ctx.emit({ type: 'log', key: 'ad.endTiling', args: { player: ctx.playerId } });
    const other = otherPlayer(state, ctx.playerId);
    if (state.tilingDone[other]) {
      resolveTiling(state, ctx);
      return;
    }
    state.turn = state.players.indexOf(other);
  },
};

const states: Record<string, StateDef<AzulDuelState>> = {
  setup: {
    type: 'activePlayer',
    onTimeout(state) {
      const player = currentPlayer(state);
      const board = boardOf(state, player);
      const plateId = state.plateDisplay[0];
      const slot = board.plates.findIndex((item) => item == null);
      return plateId && slot >= 0
        ? { type: 'placeSetupPlate', payload: { plateId, rotation: 0, slot } }
        : null;
    },
  },
  playing: {
    type: 'activePlayer',
    onTimeout(state) {
      const moves = availableMoves(state, currentPlayer(state));
      return moves[0] ?? { type: 'pass', payload: {} };
    },
  },
  tiling: {
    type: 'activePlayer',
    onTimeout(state) {
      const moves = availableMoves(state, currentPlayer(state));
      return moves[0] ?? { type: 'endTiling', payload: {} };
    },
  },
  finished: { type: 'global' },
};

function playerView(state: AzulDuelState, player: PlayerId) {
  const board = boardOf(state, player);
  return {
    id: player,
    patterns: board.patterns,
    plates: board.plates,
    dome: board.dome,
    broken: board.broken,
    chips: board.chips,
    usedChips: board.usedChips,
    score: board.score,
    tokensUsed: board.tokensUsed,
    chipsTaken: board.chipsTaken,
  };
}

const azulDuel: GamePlugin<AzulDuelState> = {
  manifest: {
    id: 'azul-duel',
    name: '花砖物语：对决',
    version: '0.1.0',
    apiVersion: '^1.0.0',
    players: { min: 2, max: 2 },
    modes: ['realtime', 'turnbased'],
    tags: ['板块', '策略', '双人'],
    estimatedMinutes: 30,
    realtime: { fast: 45, normal: 90, slow: 180 },
    description:
      '从工厂抢花砖，把它们排进图案行，再铺到自己的穹顶上；五轮后分数最高的人赢。',
    intro:
      '双人版花砖物语，30 分钟五轮。\n\n## 每回合\n\n四选一：用玩家棋子拿一块穹顶板、拿一个工厂太阳上某色全部砖、拿所有工厂月亮顶部某色砖、或拿一个已翻开的奖励片。\n\n## 计分\n\n五轮后比较分数；入门计分板是完整横线 3 分、完整竖线 7 分、完整对角线 10 分。平局由先手砖持有者获胜。',
    options: [
      {
        key: 'scoring',
        label: '计分板',
        default: 'beginner',
        choices: [
          { value: 'beginner', label: '入门', hint: '横线 3 / 竖线 7 / 对角线 10' },
          { value: 'full', label: '完整', hint: '使用全部 8 个计分目标' },
        ],
      },
    ],
    achievements: [
      { id: 'first-win', name: '首胜', description: '在花砖物语：对决里赢下第一局', icon: '🏆', color: '#1f3f4a' },
      { id: 'dome-master', name: '穹顶大师', description: '单局拿到 100 分以上', icon: '🏛️', color: '#3a4a63' },
      { id: 'specialist', name: '特殊砖收藏家', description: '一局把穹顶上的特殊格全部填满', icon: '✨', color: '#4a3a1f' },
    ],
  },

  createState({ players, options, seed }: SetupContext): AzulDuelState {
    const rng = mulberry32(seed);
    const bag: AzulColor[] = [];
    for (const color of AZUL_COLORS) for (let index = 0; index < 13; index += 1) bag.push(color);
    const shuffledBag = shuffle(bag, rng);
    const chipDeck = shuffle(CHIPS.map((chip) => chip.id), rng);
    const plates = shuffle(PLATES.map((plate) => plate.id), rng);
    const display = plates.splice(0, 3);

    const startIndex = rng() < 0.5 ? 0 : 1;
    const startingPlayer = players[startIndex]!;

    const state: AzulDuelState = {
      players: [...players],
      turn: 1 - startIndex,
      round: 1,
      phase: 'setup',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      bag: [],
      tower: [],
      factories: {
        small: Array.from({ length: SMALL_FACTORIES }, () => ({
          sun: [],
          moon: [],
          chipId: null,
          chipRevealed: false,
        })),
        large: { sun: [], moon: Array.from({ length: 5 }, () => null) },
      },
      chipSupply: chipDeck,
      plateDisplay: display,
      platePile: plates,
      specialTiles: SPECIAL_TILE_COUNT,
      startTile: 'factory',
      startingPlayer,
      setupPicks: 0,
      boards: zeroed(players, emptyBoard),
      scoringGoals: options.scoring === 'full' ? [...FULL_GOALS] : [...BEGINNER_GOALS],
      tilingDone: zeroed(players, () => false),
      lastRound: null,
    };

    state.bag = shuffledBag;
    refillFactories(state, rng);
    return state;
  },

  states,
  actions: {
    placeSetupPlate: setupPlate,
    takePlate,
    drawPlate,
    takeTiles,
    takeBonus,
    pass,
    spendBonus,
    placeDomeTile,
    endTiling,
  },

  view(state): PublicView {
    return {
      phase: state.phase,
      players: state.players,
      turn: state.finished ? null : currentPlayer(state),
      round: state.round,
      finished: state.finished,
      ranking: state.ranking,
      data: {
        round: state.round,
        bagCount: state.bag.length,
        towerCount: state.tower.length,
        platePileCount: state.platePile.length,
        plateDisplay: state.plateDisplay,
        specialTiles: state.specialTiles,
        startTile: state.startTile,
        startingPlayer: state.startingPlayer,
        setupPicks: state.setupPicks,
        factories: {
          small: state.factories.small.map((factory) => ({
            sun: factory.sun,
            moon: factory.moon,
            chipPresent: factory.chipId != null,
            chipRevealed: factory.chipRevealed,
            chipId: factory.chipRevealed ? factory.chipId : null,
          })),
          large: state.factories.large,
        },
        chipSupplyCount: state.chipSupply.length,
        players: state.players.map((player) => playerView(state, player)),
        scoringGoals: state.scoringGoals.map((goal) => SCORING_GOALS[goal]),
        tilingDone: state.tilingDone,
        lastRound: state.lastRound,
      },
    };
  },

  legalMoves(state, playerId) {
    if (state.finished) return [];
    const moves = availableMoves(state, playerId);
    if (moves.length === 0 && state.phase === 'playing' && currentPlayer(state) === playerId) {
      return [{ type: 'pass', payload: {} }];
    }
    return moves;
  },
};

export default azulDuel;
export { azulDuel };
