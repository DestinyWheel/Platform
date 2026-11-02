/**
 * 101 Okey 的牌型校验：set / run / pair，含真 Okey 万能牌。
 *
 * 这套纯函数服务端和客户端共用：客户端开牌/整理时先本地预校验，
 * 服务端仍然用同一套逻辑权威复验。
 */
import {
  isFake,
  isWild,
  tileNumber,
  type OkeyColor,
  type OkeyDef,
  type Tile,
} from './tiles';

export type MeldKind = 'set' | 'run' | 'pair';

export interface MeldCheck {
  kind: MeldKind;
  value: number;
}

interface Face {
  color: OkeyColor;
  number: number;
  fake: boolean;
}

function effectiveFace(tile: Tile, okey: OkeyDef): Face | null {
  if (isWild(tile, okey)) return null;
  if (isFake(tile)) return { color: okey.color, number: okey.number, fake: true };
  return { color: tile.color, number: tile.number, fake: false };
}

function checkPair(tiles: Tile[], okey: OkeyDef): MeldCheck | null {
  if (tiles.length !== 2) return null;
  const faces = tiles
    .map((tile) => effectiveFace(tile, okey))
    .filter((face): face is Face => face != null);
  if (faces.length === 0) return { kind: 'pair', value: okey.number * 2 };
  if (faces.length === 1) return { kind: 'pair', value: faces[0]!.number * 2 };
  if (faces[0]!.color === faces[1]!.color && faces[0]!.number === faces[1]!.number) {
    return { kind: 'pair', value: faces[0]!.number * 2 };
  }
  return null;
}

function checkSet(tiles: Tile[], okey: OkeyDef): MeldCheck | null {
  if (tiles.length < 3 || tiles.length > 4) return null;
  const faces = tiles
    .map((tile) => effectiveFace(tile, okey))
    .filter((face): face is Face => face != null);
  if (faces.length === 0) return null;
  const number = faces[0]!.number;
  if (!faces.every((face) => face.number === number)) return null;
  if (new Set(faces.map((face) => face.color)).size !== faces.length) return null;
  const wilds = tiles.length - faces.length;
  if (faces.length + wilds !== tiles.length) return null;
  if (faces.length + wilds > 4) return null;
  return { kind: 'set', value: number * tiles.length };
}

function checkRun(tiles: Tile[], okey: OkeyDef): MeldCheck | null {
  if (tiles.length < 3) return null;
  const faces = tiles
    .map((tile) => effectiveFace(tile, okey))
    .filter((face): face is Face => face != null);
  if (faces.length === 0) return null;
  const color = faces[0]!.color;
  if (!faces.every((face) => face.color === color)) return null;
  const numbers = faces.map((face) => face.number);
  if (new Set(numbers).size !== numbers.length) return null;

  let best: number | null = null;
  for (let start = 1; start + tiles.length - 1 <= 13; start += 1) {
    const end = start + tiles.length - 1;
    if (!numbers.every((number) => number >= start && number <= end)) continue;
    let value = 0;
    for (let number = start; number <= end; number += 1) value += number;
    if (best == null || value > best) best = value;
  }
  return best == null ? null : { kind: 'run', value: best };
}

export function checkMeld(tiles: Tile[], okey: OkeyDef): MeldCheck | null {
  if (tiles.length < 2 || tiles.length > 13) return null;
  if (tiles.length === 2) return checkPair(tiles, okey);
  const set = checkSet(tiles, okey);
  const run = checkRun(tiles, okey);
  if (!set) return run;
  if (!run) return set;
  return run.value >= set.value ? run : set;
}

export function validateOpening(
  groups: Tile[][],
  okey: OkeyDef,
): { route: 'score' | 'pairs'; value: number } | null {
  if (groups.length === 0) return null;
  const checks = groups.map((group) => checkMeld(group, okey));
  if (checks.some((check) => check == null)) return null;

  const pairRoute = groups.some((group) => group.length === 2);
  if (pairRoute) {
    if (groups.length < 5) return null;
    if (!groups.every((group) => group.length === 2)) return null;
    if (!checks.every((check) => check!.kind === 'pair')) return null;
    return { route: 'pairs', value: 0 };
  }

  if (!groups.every((group) => group.length >= 3)) return null;
  if (!checks.every((check) => check!.kind === 'set' || check!.kind === 'run')) return null;
  const value = checks.reduce((sum, check) => sum + check!.value, 0);
  if (value < 101) return null;
  return { route: 'score', value };
}

export function validateTable(
  groups: Tile[][],
  okey: OkeyDef,
  route: 'score' | 'pairs',
): boolean {
  if (groups.length === 0) return false;
  return groups.every((group) => {
    const check = checkMeld(group, okey);
    if (!check) return false;
    if (route === 'pairs') return check.kind === 'pair' && group.length === 2;
    return (check.kind === 'set' || check.kind === 'run') && group.length >= 3;
  });
}

export function handPoints(tiles: Tile[], okey: OkeyDef): number {
  return tiles.reduce((sum, tile) => sum + tileNumber(tile, okey), 0);
}
