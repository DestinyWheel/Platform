/**
 * 花砖物语：对决 的组件数据。
 *
 * 18 块穹顶板先按“9 块特殊 + 9 块万能”做平衡、可玩数据；
 * 精确板面等 PDF 图片/实物素材核对后再替换。
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

function makePlate(
  id: string,
  kind: 'joker' | 'special',
  colors: [AzulColor, AzulColor, AzulColor],
  hole: number,
): PlateDef {
  const cells: PlateCell[] = [];
  let colorIndex = 0;
  for (let index = 0; index < 4; index += 1) {
    cells.push(index === hole ? kind : colors[colorIndex++]!);
  }
  return { id, kind, cells: cells as [PlateCell, PlateCell, PlateCell, PlateCell] };
}

const SPECIAL_BASES: [AzulColor, AzulColor, AzulColor][] = [
  ['navy', 'turquoise', 'yellow'],
  ['turquoise', 'yellow', 'red'],
  ['yellow', 'red', 'black'],
  ['red', 'black', 'navy'],
  ['black', 'navy', 'turquoise'],
  ['navy', 'red', 'yellow'],
  ['turquoise', 'black', 'red'],
  ['yellow', 'navy', 'black'],
  ['red', 'turquoise', 'navy'],
];

const JOKER_BASES: [AzulColor, AzulColor, AzulColor][] = [
  ['navy', 'yellow', 'black'],
  ['turquoise', 'red', 'navy'],
  ['yellow', 'black', 'turquoise'],
  ['red', 'navy', 'yellow'],
  ['black', 'turquoise', 'red'],
  ['navy', 'red', 'turquoise'],
  ['turquoise', 'yellow', 'black'],
  ['yellow', 'navy', 'red'],
  ['black', 'turquoise', 'yellow'],
];

export const PLATES: PlateDef[] = [
  ...SPECIAL_BASES.map((colors, index) => makePlate(`special-${index + 1}`, 'special', colors, index % 4)),
  ...JOKER_BASES.map((colors, index) => makePlate(`joker-${index + 1}`, 'joker', colors, (index + 3) % 4)),
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

export interface ChipDef {
  id: string;
  a: AzulColor;
  b: AzulColor;
}

/** 20 个双色半片：5 色两两组合各 2 张，总出现次数平衡 */
export const CHIPS: ChipDef[] = (() => {
  const chips: ChipDef[] = [];
  for (let left = 0; left < AZUL_COLORS.length; left += 1) {
    for (let right = left + 1; right < AZUL_COLORS.length; right += 1) {
      for (let copy = 0; copy < 2; copy += 1) {
        chips.push({
          id: `chip-${left}-${right}-${copy}`,
          a: AZUL_COLORS[left]!,
          b: AZUL_COLORS[right]!,
        });
      }
    }
  }
  return chips;
})();

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
  corner: { id: 'corner', label: '四角板', hint: '四个角落每块填满的穹顶板 3 分' },
  emptySpecial: { id: 'emptySpecial', label: '空特殊格', hint: '每个空特殊格 -3 分' },
};

export const BEGINNER_GOALS: ScoringGoalId[] = ['row', 'column', 'diagonal'];
export const FULL_GOALS: ScoringGoalId[] = [
  'row',
  'column',
  'diagonal',
  'joker',
  'fiveColorRow',
  'outer',
  'corner',
  'emptySpecial',
];

export function goalPoints(goal: ScoringGoalId, points: number): string {
  const def = SCORING_GOALS[goal];
  return def ? `${def.label} ${points > 0 ? '+' : ''}${points}` : '';
}
