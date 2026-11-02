/**
 * 101 Okey 的牌与百搭判定。
 *
 * 106 张 = 4 色 × 1..13 × 2 + 2 张假百搭；指示牌同色 +1 为 Okey（13→1）。
 * 真 Okey 是万能牌；假百搭视为 Okey 本身，不万能。
 */

export type OkeyColor = 'red' | 'yellow' | 'blue' | 'black';

export interface Tile {
  id: string;
  color: OkeyColor;
  number: number;
  fake?: boolean;
}

export interface OkeyDef {
  color: OkeyColor;
  number: number;
}

export const COLORS: OkeyColor[] = ['red', 'yellow', 'blue', 'black'];
export const COLOR_NAME: Record<OkeyColor, string> = {
  red: '红',
  yellow: '黄',
  blue: '蓝',
  black: '黑',
};
const COLOR_PREFIX: Record<OkeyColor, string> = {
  red: 'r',
  yellow: 'y',
  blue: 'b',
  black: 'k',
};

export const REAL_TILES: Tile[] = (() => {
  const tiles: Tile[] = [];
  for (const color of COLORS) {
    for (let number = 1; number <= 13; number += 1) {
      tiles.push({ id: `${COLOR_PREFIX[color]}${number}a`, color, number });
      tiles.push({ id: `${COLOR_PREFIX[color]}${number}b`, color, number });
    }
  }
  return tiles;
})();

export const TILES: Tile[] = [
  ...REAL_TILES,
  { id: 'fake-a', color: 'black', number: 0, fake: true },
  { id: 'fake-b', color: 'black', number: 0, fake: true },
];

export const TILE_BY_ID: Record<string, Tile> = Object.fromEntries(
  TILES.map((tile) => [tile.id, tile]),
);

export function tileOf(id: string): Tile | null {
  return TILE_BY_ID[id] ?? null;
}

export function isFake(tile: Tile): boolean {
  return tile.fake === true;
}

export function isWild(tile: Tile, okey: OkeyDef): boolean {
  return !tile.fake && tile.color === okey.color && tile.number === okey.number;
}

/** 真 Okey + 假百搭都代表 Okey 这张牌 */
export function representsOkey(tile: Tile, okey: OkeyDef): boolean {
  return isFake(tile) || isWild(tile, okey);
}

/** 非万能牌的有效面值：假百搭 = Okey 的点数 */
export function tileNumber(tile: Tile, okey: OkeyDef): number {
  return isFake(tile) ? okey.number : tile.number;
}

export function tileValue(tile: Tile, okey: OkeyDef): number {
  return tileNumber(tile, okey);
}

export function okeyFor(indicator: Tile): OkeyDef | null {
  if (isFake(indicator)) return null;
  return {
    color: indicator.color,
    number: indicator.number === 13 ? 1 : indicator.number + 1,
  };
}

export function tileName(tile: Tile, okey: OkeyDef): string {
  if (isFake(tile)) return `假百搭(${COLOR_NAME[okey.color]}${okey.number})`;
  return `${COLOR_NAME[tile.color]}${tile.number}${isWild(tile, okey) ? '(Okey)' : ''}`;
}

export function sortHand(ids: string[], okey: OkeyDef): string[] {
  return [...ids].sort((leftId, rightId) => {
    const left = tileOf(leftId);
    const right = tileOf(rightId);
    if (!left || !right) return 0;
    const leftWild = representsOkey(left, okey) ? 0 : 1;
    const rightWild = representsOkey(right, okey) ? 0 : 1;
    if (leftWild !== rightWild) return leftWild - rightWild;
    const colorDiff = COLORS.indexOf(left.color) - COLORS.indexOf(right.color);
    if (colorDiff !== 0) return colorDiff;
    return tileNumber(left, okey) - tileNumber(right, okey);
  });
}
