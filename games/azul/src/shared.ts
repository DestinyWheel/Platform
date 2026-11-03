/**
 * 基础版花砖物语：服务端与客户端共用的颜色、墙、计分和状态类型。
 */
import type { BaseState, PlayerId } from '@platform/sdk';

export const COLORS = ['blue', 'yellow', 'red', 'black', 'white'] as const;
export type AzulColor = (typeof COLORS)[number];
/** 百搭砖是一种砖，不参与颜色奖励 */
export type AzulTile = AzulColor | 'joker';

export const COLOR_NAME: Record<AzulColor, string> = {
  blue: '蓝',
  yellow: '黄',
  red: '红',
  black: '黑',
  white: '白',
};

export const FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3];
/** 马赛克水晶两面都使用更轻的地面线 */
export const MOSAIC_FLOOR_PENALTIES = [-1, 0, -1, -2, -1, -2, -3];

/** 基础版固定墙：行首颜色每行右移一格 */
export const BASE_WALL: readonly (readonly AzulColor[])[] = [
  ['blue', 'yellow', 'red', 'black', 'white'],
  ['white', 'blue', 'yellow', 'red', 'black'],
  ['black', 'white', 'blue', 'yellow', 'red'],
  ['red', 'black', 'white', 'blue', 'yellow'],
  ['yellow', 'red', 'black', 'white', 'blue'],
];

export const EXPANSION = {
  crystalX2: 'crystal-mosaic-x2',
  crystalMosaic: 'crystal-mosaic-mosaic',
  joker: 'joker-tiles',
  specialFactories: 'special-factories',
  doubleMarkers: 'double-score-markers',
} as const;

export type BoardProfileId = 'base' | 'cm-x2' | 'cm-mosaic';

export interface FinalBonus {
  rows: number;
  columns: number;
  colors: number;
  rowPoints: number;
  columnPoints: number;
  colorPoints: number;
  total: number;
}

export interface BoardProfile {
  id: BoardProfileId;
  name: string;
  /** 每格预印颜色；null = 灰墙自由放置 */
  print: (AzulColor | null)[][];
  /** 预印 ×2 格 */
  x2: boolean[][];
  /** true = 完成图案行时可以选该墙行的任意合法空格 */
  freePlacement: boolean;
  final: { row: number; column: number; color: number };
  floor: number[];
}

function emptyGrid<T>(value: T): T[][] {
  return Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => value));
}

/** 马赛克水晶 ×2 面：五个预印 ×2 格，其余为灰墙 */
export const CM_X2_CELLS: { row: number; col: number; color: AzulColor }[] = [
  { row: 0, col: 3, color: 'black' },
  { row: 1, col: 0, color: 'white' },
  { row: 2, col: 2, color: 'yellow' },
  { row: 3, col: 4, color: 'blue' },
  { row: 4, col: 1, color: 'red' },
];

/** 马赛克水晶新图案面：青色居中，另外四色向四角展开 */
export const CM_MOSAIC_CELLS: { row: number; col: number; color: AzulColor }[] = [
  { row: 1, col: 1, color: 'blue' },
  { row: 1, col: 3, color: 'red' },
  { row: 2, col: 2, color: 'white' },
  { row: 3, col: 1, color: 'black' },
  { row: 3, col: 3, color: 'yellow' },
];

function mosaicPrint(cells: { row: number; col: number; color: AzulColor }[]): (AzulColor | null)[][] {
  const grid = emptyGrid<AzulColor | null>(null);
  for (const cell of cells) grid[cell.row]![cell.col] = cell.color;
  return grid;
}

export const PROFILES: Record<BoardProfileId, BoardProfile> = {
  base: {
    id: 'base',
    name: '基础玩家板',
    print: BASE_WALL.map((row) => [...row]),
    x2: emptyGrid(false),
    freePlacement: false,
    final: { row: 2, column: 7, color: 10 },
    floor: FLOOR_PENALTIES,
  },
  'cm-x2': {
    id: 'cm-x2',
    name: '马赛克水晶 · ×2 面',
    print: mosaicPrint(CM_X2_CELLS),
    x2: CM_X2_CELLS.reduce((grid, cell) => {
      grid[cell.row]![cell.col] = true;
      return grid;
    }, emptyGrid(false)),
    freePlacement: true,
    final: { row: 2, column: 7, color: 10 },
    floor: MOSAIC_FLOOR_PENALTIES,
  },
  'cm-mosaic': {
    id: 'cm-mosaic',
    name: '马赛克水晶 · 新图案面',
    print: mosaicPrint(CM_MOSAIC_CELLS),
    x2: emptyGrid(false),
    freePlacement: true,
    final: { row: 3, column: 10, color: 12 },
    floor: MOSAIC_FLOOR_PENALTIES,
  },
};

export function profileForExpansions(expansions: string[]): BoardProfileId {
  if (expansions.includes(EXPANSION.crystalX2)) return 'cm-x2';
  if (expansions.includes(EXPANSION.crystalMosaic)) return 'cm-mosaic';
  return 'base';
}

export function hasExpansion(expansions: string[], id: string): boolean {
  return expansions.includes(id);
}

export function factoryCountFor(players: number): number {
  if (players >= 4) return 9;
  if (players === 3) return 7;
  return 5;
}

/** 基础墙的固定列；灰墙请用 legalColumns */
export function baseColumn(row: number, color: AzulColor): number {
  return BASE_WALL[row]!.indexOf(color);
}

/** 某格预印的颜色（没有就是灰墙自由格） */
export function printedColor(profile: BoardProfile, row: number, col: number): AzulColor | null {
  return profile.print[row]?.[col] ?? null;
}

/** null = 空；'joker' = 百搭占格 */
export type PlacedWall = (AzulColor | 'joker' | null)[][];

function colorInLine(wall: PlacedWall, row: number, color: AzulColor): boolean {
  return wall[row]!.some((cell) => cell === color);
}

function colorInColumn(wall: PlacedWall, col: number, color: AzulColor): boolean {
  return wall.some((row) => row[col] === color);
}

/**
 * 把某个颜色放到 row 行时，哪些列合法。
 * - 基础板：只有预印该颜色的那一列；
 * - 灰墙：任意空格，但同色不能在同一行/列出现第二次；
 * - 预印格只接受对应颜色。
 */
export function legalColumns(
  profile: BoardProfile,
  wall: PlacedWall,
  row: number,
  color: AzulColor,
): number[] {
  if (!profile.freePlacement) {
    const col = baseColumn(row, color);
    return wall[row]?.[col] === null ? [col] : [];
  }
  const out: number[] = [];
  for (let col = 0; col < 5; col += 1) {
    if (wall[row]![col] !== null) continue;
    const printed = printedColor(profile, row, col);
    if (printed !== null && printed !== color) continue;
    if (colorInLine(wall, row, color)) continue;
    if (colorInColumn(wall, col, color)) continue;
    out.push(col);
  }
  return out;
}

/** 百搭上墙：基础板不能选预印其他颜色的格；灰墙任意空格 */
export function legalJokerColumns(
  profile: BoardProfile,
  wall: PlacedWall,
  row: number,
  asColor: AzulColor | null,
): number[] {
  if (asColor !== null) return legalColumns(profile, wall, row, asColor);
  if (!profile.freePlacement) {
    return [0, 1, 2, 3, 4].filter((col) => wall[row]?.[col] === null);
  }
  const out: number[] = [];
  for (let col = 0; col < 5; col += 1) {
    if (wall[row]![col] === null) out.push(col);
  }
  return out;
}

/** 上墙即时分：孤立 1 分，否则横向连续数 + 纵向连续数 */
export function placementScore(wall: PlacedWall, row: number, col: number): number {
  const count = (dr: number, dc: number): number => {
    let total = 1;
    for (const direction of [1, -1]) {
      let r = row + dr * direction;
      let c = col + dc * direction;
      while (r >= 0 && r < 5 && c >= 0 && c < 5 && wall[r]?.[c] != null) {
        total += 1;
        r += dr * direction;
        c += dc * direction;
      }
    }
    return total;
  };
  const horizontal = count(0, 1);
  const vertical = count(1, 0);
  if (horizontal === 1 && vertical === 1) return 1;
  return (horizontal > 1 ? horizontal : 0) + (vertical > 1 ? vertical : 0);
}

export function finalBonusFor(profile: BoardProfile, wall: PlacedWall): FinalBonus {
  let rows = 0;
  let columns = 0;
  let colors = 0;
  for (let row = 0; row < 5; row += 1) {
    if (wall[row]!.every((cell) => cell !== null)) rows += 1;
  }
  for (let col = 0; col < 5; col += 1) {
    if (wall.every((row) => row[col] !== null)) columns += 1;
  }
  for (const color of COLORS) {
    let count = 0;
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (wall[row]![col] === color) count += 1;
      }
    }
    if (count === 5) colors += 1;
  }
  const rowPoints = rows * profile.final.row;
  const columnPoints = columns * profile.final.column;
  const colorPoints = colors * profile.final.color;
  return {
    rows,
    columns,
    colors,
    rowPoints,
    columnPoints,
    colorPoints,
    total: rowPoints + columnPoints + colorPoints,
  };
}

export interface AzulBoard {
  patterns: AzulTile[][];
  wall: (AzulColor | 'joker' | null)[][];
  floor: (AzulTile | 'marker')[];
  score: number;
  usedDouble: boolean;
}

export interface AzulFactory {
  type: 'normal' | 'stay' | 'shift';
  tiles: AzulTile[];
}

export interface TilingNode {
  /** players 下标 */
  player: number;
  /** 图案行 0..4 */
  line: number;
}

export interface AzulState extends BaseState {
  expansions: string[];
  profile: BoardProfileId;
  factories: AzulFactory[];
  center: AzulTile[];
  bag: AzulTile[];
  lid: AzulTile[];
  boards: Record<PlayerId, AzulBoard>;
  /** 本轮先手（上墙顺序从它开始） */
  starter: number;
  /** 首玩家标记持有者 / 下轮先手 */
  firstPlayer: number;
  markerInCenter: boolean;
  /** 特殊工厂剩余的五色 ×2 标记 */
  doubleMarkers: AzulColor[];
  /** 需要玩家做上墙选择时的节点；null = 没有待决策 */
  tiling: TilingNode | null;
  endReason: 'row' | 'exhausted' | null;
  finalBonuses: Record<PlayerId, FinalBonus> | null;
}

export function emptyBoard(): AzulBoard {
  return {
    patterns: Array.from({ length: 5 }, () => []),
    wall: emptyGrid<AzulColor | 'joker' | null>(null),
    floor: [],
    score: 0,
    usedDouble: false,
  };
}

export function patternLineColor(pattern: AzulTile[]): AzulColor | null {
  return pattern.find((tile): tile is AzulColor => tile !== 'joker') ?? null;
}

export function countTiles(state: AzulState): number {
  let total = state.bag.length + state.lid.length + state.center.length;
  for (const factory of state.factories) total += factory.tiles.length;
  for (const board of Object.values(state.boards)) {
    for (const line of board.patterns) total += line.length;
    for (const row of board.wall) total += row.filter((cell) => cell !== null).length;
    total += board.floor.filter((tile) => tile !== 'marker').length;
  }
  return total;
}
