/**
 * 花砖物语：对决 的组件数据。
 *
 * 18 块穹顶板按用户核对过的实物板面录入：
 * 每行是「左上 右上 右下 左下」，再转换成 cells 的 [左上, 右上, 左下, 右下]。
 */

export type AzulColor = 'navy' | 'turquoise' | 'yellow' | 'red' | 'black';
export type PlateCell = AzulColor | 'joker' | 'special';

export const AZUL_COLORS: AzulColor[] = ['navy', 'turquoise', 'yellow', 'red', 'black'];
export const COLOR_NAME: Record<AzulColor, string> = {
  navy: '深蓝',
  turquoise: '青绿',
  yellow: '黄',
  red: '红',
  black: '黑',
};

export interface PlateDef {
  id: string;
  kind: 'joker' | 'special';
  /** 2×2，按顺时针 rotation 旋转 */
  cells: [PlateCell, PlateCell, PlateCell, PlateCell];
}

type PlateRow = [
  tl: PlateCell,
  tr: PlateCell,
  br: PlateCell,
  bl: PlateCell,
];

/** 左上/右上/右下/左下；特殊/万能都在左上 */
const SPECIAL_ROWS: PlateRow[] = [
  ['special', 'black', 'navy', 'red'],
  ['special', 'navy', 'turquoise', 'red'],
  ['special', 'black', 'yellow', 'navy'],
  ['special', 'turquoise', 'navy', 'yellow'],
  ['special', 'red', 'turquoise', 'black'],
  ['special', 'black', 'red', 'yellow'],
  ['special', 'navy', 'black', 'turquoise'],
  ['special', 'yellow', 'red', 'navy'],
  ['special', 'turquoise', 'yellow', 'black'],
];

const JOKER_ROWS: PlateRow[] = [
  ['joker', 'turquoise', 'navy', 'yellow'],
  ['joker', 'navy', 'turquoise', 'red'],
  ['joker', 'red', 'black', 'yellow'],
  ['joker', 'yellow', 'red', 'navy'],
  ['joker', 'turquoise', 'yellow', 'black'],
  ['joker', 'black', 'navy', 'red'],
  ['joker', 'red', 'turquoise', 'black'],
  ['joker', 'yellow', 'red', 'turquoise'],
  ['joker', 'navy', 'black', 'turquoise'],
];

function fromRow(id: string, kind: 'special' | 'joker', row: PlateRow): PlateDef {
  // cells 是 [左上, 右上, 左下, 右下]；row 是 [左上, 右上, 右下, 左下]
  return { id, kind, cells: [row[0], row[1], row[3], row[2]] };
}

export const PLATES: PlateDef[] = [
  ...SPECIAL_ROWS.map((row, index) => fromRow(`special-${index + 1}`, 'special', row)),
  ...JOKER_ROWS.map((row, index) => fromRow(`joker-${index + 1}`, 'joker', row)),
];

export const PLATE_BY_ID: Record<string, PlateDef> = Object.fromEntries(
  PLATES.map((plate) => [plate.id, plate]),
);

const ROTATE = [2, 0, 3, 1];

export function rotatedCells(plate: PlateDef, rotation: number): PlateCell[] {
  let cells: PlateCell[] = [...plate.cells];
  for (let step = 0; step < ((rotation % 4) + 4) % 4; step += 1) {
    cells = ROTATE.map((index) => cells[index]!);
  }
  return cells;
}

/** 奖励片的一侧可以是白色半片；白色不匹配任何花砖颜色 */
export type ChipColor = AzulColor | 'white';

export const CHIP_COLOR_NAME: Record<ChipColor, string> = {
  ...COLOR_NAME,
  white: '特殊',
};

export const CHIP_COLOR_HEX: Record<ChipColor, string> = {
  navy: '#2d5f9e',
  turquoise: '#4fb7b0',
  yellow: '#e8c34a',
  red: '#d05050',
  black: '#2a2f36',
  white: '#f4f1e8',
};

export interface ChipDef {
  id: string;
  a: ChipColor;
  b: ChipColor;
}

/** 实物 20 个奖励片：10 组双色，每组 2 张；红色永远放在右半块 */
const CHIP_PAIRS: [ChipColor, ChipColor][] = [
  ['turquoise', 'red'],
  ['turquoise', 'white'],
  ['black', 'white'],
  ['black', 'navy'],
  ['turquoise', 'yellow'],
  ['navy', 'red'],
  ['navy', 'white'],
  ['white', 'red'],
  ['yellow', 'white'],
  ['yellow', 'black'],
];

export const CHIPS: ChipDef[] = CHIP_PAIRS.flatMap(([a, b], index) =>
  [0, 1].map((copy) => ({
    id: `chip-${index}-${copy}`,
    a,
    b,
  })),
);

export const CHIP_BY_ID: Record<string, ChipDef> = Object.fromEntries(
  CHIPS.map((chip) => [chip.id, chip]),
);

export function chipMatches(chip: ChipDef, color: AzulColor): boolean {
  return chip.a === color || chip.b === color;
}

export const SPECIAL_TILE_COUNT = 9;

export type ScoringGoalId =
  | 'row'
  | 'column'
  | 'diagonal'
  | 'joker'
  | 'fiveColorRow'
  | 'outer'
  | 'corner'
  | 'emptySpecial';

export interface ScoringGoal {
  id: ScoringGoalId;
  label: string;
  hint: string;
}

export const SCORING_GOALS: Record<ScoringGoalId, ScoringGoal> = {
  row: { id: 'row', label: '完整横线', hint: '每条 6 个砖的横向线 3 分' },
  column: { id: 'column', label: '完整竖线', hint: '每条 6 个砖的纵向线 7 分' },
  diagonal: { id: 'diagonal', label: '完整对角线', hint: '每条 6 个砖的对角线 10 分（最多两条）' },
  joker: { id: 'joker', label: '万能格全满', hint: '所有万能格填满后每个 2 分' },
  fiveColorRow: { id: 'fiveColorRow', label: '五色横线', hint: '每行至少 5 种不同颜色 4 分' },
  outer: { id: 'outer', label: '外圈', hint: '外圈每个砖 1 分' },
  corner: { id: 'corner', label: '四角板', hint: '左上/右上角每块 3 分，左下/右下角每块 8 分' },
  emptySpecial: { id: 'emptySpecial', label: '空特殊格', hint: '每个空特殊格 -3 分' },
};

/**
 * 4 张双面计分板，按 PDF 参考页排列：
 * 上面一行是正面，下面一行是反面，同一列是一张板的两面。
 */
export interface ScoringTablet {
  id: string;
  front: ScoringGoalId;
  back: ScoringGoalId;
}

export const SCORING_TABLETS: ScoringTablet[] = [
  { id: 'tablet-1', front: 'row', back: 'fiveColorRow' },
  { id: 'tablet-2', front: 'column', back: 'outer' },
  { id: 'tablet-3', front: 'diagonal', back: 'corner' },
  { id: 'tablet-4', front: 'joker', back: 'emptySpecial' },
];

/** 入门局：前 3 张板的正面（横线 / 竖线 / 对角线） */
export const BEGINNER_GOALS: ScoringGoalId[] = SCORING_TABLETS.slice(0, 3).map(
  (tablet) => tablet.front,
);

/** 标准局：4 张板各随机翻一面；用 seeded rng，保证同种子可回放 */
export function scoringGoalsFor(mode: string, rng: () => number): ScoringGoalId[] {
  if (mode !== 'full') return [...BEGINNER_GOALS];
  return SCORING_TABLETS.map((tablet) => (rng() < 0.5 ? tablet.front : tablet.back));
}

export function goalPoints(goal: ScoringGoalId, points: number): string {
  const def = SCORING_GOALS[goal];
  return def ? `${def.label} ${points > 0 ? '+' : ''}${points}` : '';
}
