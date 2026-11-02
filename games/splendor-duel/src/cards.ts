/**
 * Splendor Duel 的 67 张 Jewel 卡与 4 张 Royal 卡。
 *
 * 数据来源：开源仓库 sone359/Splendor_Duel 的 data/info_cartejoaillerie（CSV）。
 * 字段：等级;声望;奖励数量;奖励色;皇冠;白,蓝,绿,红,黑,珍珠;能力;图片名。
 * Royal 卡效果来自同仓库 source/Back/partie.cpp。
 */

export type GemColor = 'white' | 'blue' | 'green' | 'red' | 'black';
export type TokenColor = GemColor | 'pearl' | 'gold';
export type Ability = 'replay' | 'privilege' | 'gem' | 'steal' | 'copyColor';

export interface JewelCard {
  id: string;
  level: 1 | 2 | 3;
  prestige: number;
  bonusCount: number;
  bonusColor: GemColor | null;
  crowns: number;
  cost: Record<GemColor | 'pearl', number>;
  abilities: Ability[];
}

export interface RoyalCard {
  id: string;
  prestige: number;
  ability: 'steal' | 'privilege' | 'replay' | 'none';
}

type RawAbility =
  | 'rejouer'
  | 'privilege'
  | 'gemme'
  | 'voler'
  | 'couleur'
  | 'none'
  | 'couleur,rejouer';

type Row = [
  level: 1 | 2 | 3,
  prestige: number,
  bonusCount: number,
  bonusColor: 'blanc' | 'bleu' | 'vert' | 'rouge' | 'noir' | 'none',
  crowns: number,
  cost: [number, number, number, number, number, number],
  ability: RawAbility,
  path: string,
];

const COLORS: Record<Exclude<Row[3], 'none'>, GemColor> = {
  blanc: 'white',
  bleu: 'blue',
  vert: 'green',
  rouge: 'red',
  noir: 'black',
};

function abilitiesOf(raw: RawAbility): Ability[] {
  if (raw === 'none') return [];
  return raw.split(',').map((part) => {
    if (part === 'rejouer') return 'replay';
    if (part === 'privilege') return 'privilege';
    if (part === 'gemme') return 'gem';
    if (part === 'voler') return 'steal';
    return 'copyColor';
  });
}

// prettier-ignore
const ROWS: Row[] = [
  // ---- Level 1（30 张）----
  [1, 0, 1, 'bleu', 0, [0, 0, 2, 2, 0, 1], 'rejouer', 'niveau1(17)'],
  [1, 0, 1, 'bleu', 0, [1, 0, 1, 1, 1, 0], 'none', 'niveau1(27)'],
  [1, 0, 1, 'noir', 0, [0, 0, 2, 2, 0, 0], 'gemme', 'niveau1(29)'],
  [1, 3, 0, 'none', 0, [0, 0, 0, 4, 0, 1], 'none', 'niveau1(16)'],
  [1, 0, 1, 'rouge', 0, [2, 0, 0, 0, 2, 1], 'rejouer', 'niveau1(9)'],
  [1, 1, 1, 'none', 0, [0, 2, 0, 2, 1, 1], 'couleur', 'niveau1(12)'],
  [1, 0, 1, 'rouge', 1, [0, 0, 0, 0, 3, 0], 'none', 'niveau1(22)'],
  [1, 0, 1, 'vert', 0, [1, 1, 0, 1, 1, 0], 'none', 'niveau1(21)'],
  [1, 0, 1, 'blanc', 0, [0, 0, 0, 2, 2, 0], 'gemme', 'niveau1(26)'],
  [1, 0, 1, 'noir', 1, [3, 0, 0, 0, 0, 0], 'none', 'niveau1(19)'],
  [1, 1, 1, 'none', 0, [2, 0, 2, 0, 1, 1], 'couleur', 'niveau1(15)'],
  [1, 0, 1, 'noir', 0, [1, 1, 1, 1, 0, 0], 'none', 'niveau1(25)'],
  [1, 1, 1, 'noir', 0, [0, 2, 3, 0, 0, 0], 'none', 'niveau1(20)'],
  [1, 0, 1, 'bleu', 0, [2, 0, 0, 0, 2, 0], 'gemme', 'niveau1(14)'],
  [1, 0, 1, 'bleu', 1, [0, 0, 3, 0, 0, 0], 'none', 'niveau1(24)'],
  [1, 1, 1, 'bleu', 0, [0, 0, 0, 2, 3, 0], 'none', 'niveau1(28)'],
  [1, 0, 1, 'none', 1, [4, 0, 0, 0, 0, 1], 'couleur', 'niveau1(13)'],
  [1, 1, 1, 'blanc', 0, [0, 0, 2, 3, 0, 0], 'none', 'niveau1(23)'],
  [1, 0, 1, 'blanc', 0, [0, 1, 1, 1, 1, 0], 'none', 'niveau1(11)'],
  [1, 0, 1, 'blanc', 0, [0, 2, 2, 0, 0, 1], 'rejouer', 'niveau1(10)'],
  [1, 0, 1, 'noir', 0, [2, 2, 0, 0, 0, 1], 'rejouer', 'niveau1(18)'],
  [1, 0, 1, 'blanc', 1, [0, 3, 0, 0, 0, 0], 'none', 'niveau1(8)'],
  [1, 1, 1, 'rouge', 0, [2, 3, 0, 0, 0, 0], 'none', 'niveau1(7)'],
  [1, 1, 1, 'vert', 0, [3, 0, 0, 0, 2, 0], 'none', 'niveau1(6)'],
  [1, 1, 1, 'none', 0, [0, 0, 0, 0, 4, 1], 'couleur', 'niveau1(5)'],
  [1, 0, 1, 'vert', 1, [0, 0, 0, 3, 0, 0], 'none', 'niveau1(4)'],
  [1, 0, 1, 'rouge', 0, [1, 1, 1, 0, 1, 0], 'none', 'niveau1(3)'],
  [1, 0, 1, 'rouge', 0, [0, 2, 2, 0, 0, 0], 'gemme', 'niveau1(1)'],
  [1, 0, 1, 'vert', 0, [0, 0, 0, 2, 2, 1], 'rejouer', 'niveau1(2)'],
  [1, 0, 1, 'vert', 0, [2, 2, 0, 0, 0, 0], 'gemme', 'niveau1(30)'],
  // ---- Level 2（24 张）----
  [2, 0, 1, 'none', 2, [0, 6, 0, 0, 0, 1], 'couleur', 'niveau2(14)'],
  [2, 0, 1, 'none', 2, [0, 0, 6, 0, 0, 1], 'couleur', 'niveau2(12)'],
  [2, 1, 2, 'rouge', 0, [2, 0, 0, 0, 5, 0], 'none', 'niveau2(11)'],
  [2, 1, 2, 'noir', 0, [5, 2, 0, 0, 0, 0], 'none', 'niveau2(20)'],
  [2, 2, 1, 'noir', 0, [0, 0, 0, 2, 4, 1], 'privilege', 'niveau2(10)'],
  [2, 5, 0, 'none', 0, [0, 6, 0, 0, 0, 1], 'none', 'niveau2(18)'],
  [2, 1, 1, 'blanc', 0, [0, 4, 0, 3, 0, 0], 'voler', 'niveau2(24)'],
  [2, 2, 1, 'bleu', 1, [2, 0, 0, 2, 2, 1], 'none', 'niveau2(23)'],
  [2, 1, 2, 'vert', 0, [0, 0, 0, 5, 2, 0], 'none', 'niveau2(22)'],
  [2, 2, 1, 'noir', 1, [0, 2, 2, 2, 0, 1], 'none', 'niveau2(21)'],
  [2, 1, 1, 'noir', 0, [4, 0, 3, 0, 0, 0], 'voler', 'niveau2(9)'],
  [2, 2, 1, 'none', 0, [0, 0, 6, 0, 0, 1], 'couleur', 'niveau2(8)'],
  [2, 2, 1, 'vert', 1, [2, 2, 0, 0, 2, 1], 'none', 'niveau2(7)'],
  [2, 2, 1, 'bleu', 0, [2, 4, 0, 0, 0, 1], 'privilege', 'niveau2(6)'],
  [2, 2, 1, 'vert', 0, [0, 2, 4, 0, 0, 1], 'privilege', 'niveau2(4)'],
  [2, 1, 1, 'bleu', 0, [0, 0, 4, 0, 3, 0], 'voler', 'niveau2(3)'],
  [2, 2, 1, 'blanc', 0, [4, 0, 0, 0, 2, 1], 'privilege', 'niveau2(16)'],
  [2, 1, 1, 'rouge', 0, [0, 3, 0, 0, 4, 0], 'voler', 'niveau2(5)'],
  [2, 2, 1, 'rouge', 1, [2, 2, 2, 0, 0, 1], 'none', 'niveau2(19)'],
  [2, 1, 2, 'bleu', 0, [0, 0, 5, 2, 0, 0], 'none', 'niveau2(17)'],
  [2, 1, 1, 'vert', 0, [3, 0, 0, 4, 0, 0], 'voler', 'niveau2(2)'],
  [2, 2, 1, 'rouge', 0, [0, 0, 2, 4, 0, 1], 'privilege', 'niveau2(1)'],
  [2, 2, 1, 'blanc', 1, [0, 0, 2, 2, 2, 1], 'none', 'niveau2(15)'],
  [2, 1, 2, 'blanc', 0, [0, 5, 2, 0, 0, 0], 'none', 'niveau2(13)'],
  // ---- Level 3（13 张）----
  [3, 0, 1, 'none', 3, [0, 0, 0, 0, 8, 0], 'couleur', 'niveau3(4)'],
  [3, 4, 1, 'bleu', 0, [2, 6, 2, 0, 0, 0], 'none', 'niveau3(1)'],
  [3, 3, 1, 'rouge', 1, [0, 5, 3, 0, 3, 1], 'none', 'niveau3(5)'],
  [3, 4, 1, 'rouge', 0, [0, 0, 2, 6, 2, 0], 'none', 'niveau3(11)'],
  [3, 3, 1, 'noir', 2, [3, 0, 5, 3, 0, 1], 'none', 'niveau3(13)'],
  [3, 3, 1, 'blanc', 2, [0, 3, 0, 5, 3, 1], 'none', 'niveau3(12)'],
  [3, 3, 1, 'bleu', 2, [3, 0, 3, 0, 5, 1], 'none', 'niveau3(6)'],
  [3, 4, 1, 'vert', 0, [0, 2, 6, 2, 0, 0], 'none', 'niveau3(2)'],
  [3, 4, 1, 'noir', 0, [2, 0, 0, 2, 6, 0], 'none', 'niveau3(8)'],
  [3, 4, 1, 'blanc', 0, [6, 2, 0, 0, 2, 0], 'none', 'niveau3(7)'],
  [3, 3, 1, 'vert', 2, [5, 3, 0, 3, 0, 1], 'none', 'niveau3(9)'],
  [3, 3, 1, 'none', 0, [0, 0, 0, 8, 0, 0], 'couleur,rejouer', 'niveau3(3)'],
  [3, 6, 0, 'none', 0, [8, 0, 0, 0, 0, 0], 'none', 'niveau3(10)'],
];

function idOf(path: string): string {
  return path.replace('niveau', 'L').replace('(', '-').replace(')', '');
}

function costOf(row: Row): Record<GemColor | 'pearl', number> {
  const [white, blue, green, red, black, pearl] = row[5];
  return { white, blue, green, red, black, pearl };
}

export const JEWEL_CARDS: JewelCard[] = ROWS.map((row) => ({
  id: idOf(row[7]),
  level: row[0],
  prestige: row[1],
  bonusCount: row[2],
  bonusColor: row[3] === 'none' ? null : COLORS[row[3]],
  crowns: row[4],
  cost: costOf(row),
  abilities: abilitiesOf(row[6]),
}));

export const CARD_BY_ID: Record<string, JewelCard> = Object.fromEntries(
  JEWEL_CARDS.map((card) => [card.id, card]),
);

export const DECKS: Record<'1' | '2' | '3', string[]> = {
  '1': JEWEL_CARDS.filter((card) => card.level === 1).map((card) => card.id),
  '2': JEWEL_CARDS.filter((card) => card.level === 2).map((card) => card.id),
  '3': JEWEL_CARDS.filter((card) => card.level === 3).map((card) => card.id),
};

export const ROYAL_CARDS: RoyalCard[] = [
  { id: 'royal-steal', prestige: 2, ability: 'steal' },
  { id: 'royal-privilege', prestige: 2, ability: 'privilege' },
  { id: 'royal-replay', prestige: 2, ability: 'replay' },
  { id: 'royal-none', prestige: 3, ability: 'none' },
];

export const ROYAL_BY_ID: Record<string, RoyalCard> = Object.fromEntries(
  ROYAL_CARDS.map((card) => [card.id, card]),
);
