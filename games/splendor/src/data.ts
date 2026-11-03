/**
 * 璀璨宝石（Splendor，Marc André 2014）基础版的数据表。
 *
 * 90 张发展卡：等级 1 / 2 / 3 各 40 / 30 / 20 张，五色红利各 8 / 6 / 4 张。
 * 数据来源：https://github.com/bouk/splendimax/blob/master/Splendor%20Cards.csv
 * （列序 Black,Blue,Green,Red,White，这里转成 white/blue/green/red/black）
 *
 * 10 张贵族：任意两色各 4 个，3 分，全组合正好 10 张（与实物一致）。
 *
 * 荣誉之战 / 贸易之路两个模块的静态数据也放这里：
 * 要塞每人 3 个，纹章每人 5 枚，版图上 5 条能力各 4 个座位。
 */

export type Gem = 'white' | 'blue' | 'green' | 'red' | 'black';
export type TokenColor = Gem | 'gold';

export const GEMS: Gem[] = ['white', 'blue', 'green', 'red', 'black'];

export const COLOR_NAME: Record<TokenColor, string> = {
  white: '钻石（白）',
  blue: '蓝宝石（蓝）',
  green: '绿宝石（绿）',
  red: '红宝石（红）',
  black: '玛瑙（黑）',
  gold: '黄金',
};

/** 卡面五个角的颜色顺序，渲染和成本表都按它排 */
export const COST_ORDER: Gem[] = ['white', 'blue', 'green', 'red', 'black'];

export interface Card {
  /** 稳定 id：L<等级>-<两位序号>，回放和测试都靠它 */
  id: string;
  level: 1 | 2 | 3;
  prestige: number;
  /** 买下之后永久提供的红利息 */
  bonus: Gem;
  cost: Record<Gem, number>;
}

export interface Noble {
  id: string;
  prestige: number;
  need: Partial<Record<Gem, number>>;
}

type Row = [
  level: 1 | 2 | 3,
  prestige: number,
  bonus: Gem,
  white: number,
  blue: number,
  green: number,
  red: number,
  black: number,
];

// prettier-ignore
const ROWS: Row[] = [
  // ---- 等级 1（40 张）----
  [1, 0, 'black', 1, 1, 1, 1, 0],
  [1, 0, 'black', 1, 2, 1, 1, 0],
  [1, 0, 'black', 2, 2, 0, 1, 0],
  [1, 0, 'black', 0, 0, 1, 3, 1],
  [1, 0, 'black', 0, 0, 2, 1, 0],
  [1, 0, 'black', 2, 0, 2, 0, 0],
  [1, 0, 'black', 0, 0, 3, 0, 0],
  [1, 1, 'black', 0, 4, 0, 0, 0],

  [1, 0, 'blue', 1, 0, 1, 1, 1],
  [1, 0, 'blue', 1, 0, 1, 2, 1],
  [1, 0, 'blue', 1, 0, 2, 2, 0],
  [1, 0, 'blue', 0, 1, 3, 1, 0],
  [1, 0, 'blue', 1, 0, 0, 0, 2],
  [1, 0, 'blue', 0, 0, 2, 0, 2],
  [1, 0, 'blue', 0, 0, 0, 0, 3],
  [1, 1, 'blue', 0, 0, 0, 4, 0],

  [1, 0, 'white', 0, 1, 1, 1, 1],
  [1, 0, 'white', 0, 1, 2, 1, 1],
  [1, 0, 'white', 0, 2, 2, 0, 1],
  [1, 0, 'white', 3, 1, 0, 0, 1],
  [1, 0, 'white', 0, 0, 0, 2, 1],
  [1, 0, 'white', 0, 2, 0, 0, 2],
  [1, 0, 'white', 0, 3, 0, 0, 0],
  [1, 1, 'white', 0, 0, 4, 0, 0],

  [1, 0, 'green', 1, 1, 0, 1, 1],
  [1, 0, 'green', 1, 1, 0, 1, 2],
  [1, 0, 'green', 0, 1, 0, 2, 2],
  [1, 0, 'green', 1, 3, 1, 0, 0],
  [1, 0, 'green', 2, 0, 0, 1, 0],
  [1, 0, 'green', 0, 2, 0, 2, 0],
  [1, 0, 'green', 0, 0, 0, 3, 0],
  [1, 1, 'green', 0, 0, 0, 0, 4],

  [1, 0, 'red', 1, 1, 1, 0, 1],
  [1, 0, 'red', 2, 1, 1, 0, 1],
  [1, 0, 'red', 2, 0, 1, 0, 2],
  [1, 0, 'red', 1, 0, 0, 1, 3],
  [1, 0, 'red', 0, 2, 1, 0, 0],
  [1, 0, 'red', 2, 0, 0, 2, 0],
  [1, 0, 'red', 3, 0, 0, 0, 0],
  [1, 1, 'red', 4, 0, 0, 0, 0],

  // ---- 等级 2（30 张）----
  [2, 1, 'black', 3, 2, 2, 0, 0],
  [2, 1, 'black', 3, 0, 3, 0, 2],
  [2, 2, 'black', 0, 1, 4, 2, 0],
  [2, 2, 'black', 0, 0, 5, 3, 0],
  [2, 2, 'black', 5, 0, 0, 0, 0],
  [2, 3, 'black', 0, 0, 0, 0, 6],

  [2, 1, 'blue', 0, 2, 2, 3, 0],
  [2, 1, 'blue', 0, 2, 3, 0, 3],
  [2, 2, 'blue', 5, 3, 0, 0, 0],
  [2, 2, 'blue', 2, 0, 0, 1, 4],
  [2, 2, 'blue', 0, 5, 0, 0, 0],
  [2, 3, 'blue', 0, 6, 0, 0, 0],

  [2, 1, 'white', 0, 0, 3, 2, 2],
  [2, 1, 'white', 2, 3, 0, 3, 0],
  [2, 2, 'white', 0, 0, 1, 4, 2],
  [2, 2, 'white', 0, 0, 0, 5, 3],
  [2, 2, 'white', 0, 0, 0, 5, 0],
  [2, 3, 'white', 6, 0, 0, 0, 0],

  [2, 1, 'green', 3, 0, 2, 3, 0],
  [2, 1, 'green', 2, 3, 0, 0, 2],
  [2, 2, 'green', 4, 2, 0, 0, 1],
  [2, 2, 'green', 0, 5, 3, 0, 0],
  [2, 2, 'green', 0, 0, 5, 0, 0],
  [2, 3, 'green', 0, 0, 6, 0, 0],

  [2, 1, 'red', 2, 0, 0, 2, 3],
  [2, 1, 'red', 0, 3, 0, 2, 3],
  [2, 2, 'red', 1, 4, 2, 0, 0],
  [2, 2, 'red', 3, 0, 0, 0, 5],
  [2, 2, 'red', 0, 0, 0, 0, 5],
  [2, 3, 'red', 0, 0, 0, 6, 0],

  // ---- 等级 3（20 张）----
  [3, 3, 'black', 3, 3, 5, 3, 0],
  [3, 4, 'black', 0, 0, 0, 7, 0],
  [3, 4, 'black', 0, 0, 3, 6, 3],
  [3, 5, 'black', 0, 0, 0, 7, 3],

  [3, 3, 'blue', 3, 0, 3, 3, 5],
  [3, 4, 'blue', 7, 0, 0, 0, 0],
  [3, 4, 'blue', 6, 3, 0, 0, 3],
  [3, 5, 'blue', 7, 3, 0, 0, 0],

  [3, 3, 'white', 0, 3, 3, 5, 3],
  [3, 4, 'white', 0, 0, 0, 0, 7],
  [3, 4, 'white', 3, 0, 0, 3, 6],
  [3, 5, 'white', 3, 0, 0, 0, 7],

  [3, 3, 'green', 5, 3, 0, 3, 3],
  [3, 4, 'green', 0, 7, 0, 0, 0],
  [3, 4, 'green', 3, 6, 3, 0, 0],
  [3, 5, 'green', 0, 7, 3, 0, 0],

  [3, 3, 'red', 3, 5, 3, 0, 3],
  [3, 4, 'red', 0, 0, 7, 0, 0],
  [3, 4, 'red', 0, 3, 6, 3, 0],
  [3, 5, 'red', 0, 0, 7, 3, 0],
];

function costOf(row: Row): Record<Gem, number> {
  const [, , , white, blue, green, red, black] = row;
  return { white, blue, green, red, black };
}

const counters: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };

export const CARDS: Card[] = ROWS.map((row) => {
  const [level, prestige, bonus] = row;
  counters[level] += 1;
  return {
    id: `L${level}-${String(counters[level]).padStart(2, '0')}`,
    level,
    prestige,
    bonus,
    cost: costOf(row),
  };
});

export const CARD_BY_ID: Record<string, Card> = Object.fromEntries(
  CARDS.map((card) => [card.id, card]),
);

export const DECKS: Record<'1' | '2' | '3', string[]> = {
  '1': CARDS.filter((card) => card.level === 1).map((card) => card.id),
  '2': CARDS.filter((card) => card.level === 2).map((card) => card.id),
  '3': CARDS.filter((card) => card.level === 3).map((card) => card.id),
};

/** 贵族：任意两色各 4 个，正好 10 张 */
const NOBLE_PAIRS: [Gem, Gem][] = [
  ['white', 'blue'],
  ['white', 'green'],
  ['white', 'red'],
  ['white', 'black'],
  ['blue', 'green'],
  ['blue', 'red'],
  ['blue', 'black'],
  ['green', 'red'],
  ['green', 'black'],
  ['red', 'black'],
];

export const NOBLES: Noble[] = NOBLE_PAIRS.map(([a, b]) => ({
  id: `N-${a}-${b}`,
  prestige: 3,
  need: { [a]: 4, [b]: 4 } as Partial<Record<Gem, number>>,
}));

export const NOBLE_BY_ID: Record<string, Noble> = Object.fromEntries(
  NOBLES.map((noble) => [noble.id, noble]),
);

/* ------------------------------------------------------------------ */
/* 荣誉之战 / 贸易之路                                                 */
/* ------------------------------------------------------------------ */

/** 每人 3 个要塞 */
export const STRONGHOLDS_PER_PLAYER = 3;

/**
 * 贸易之路的 5 条能力。
 *
 * 版图上每条能力给每个座位留一格（5 × 4 = 20，正好对上 20 枚纹章），
 * 所以同一条能力可以被不同玩家各占一枚，同一玩家也可以在多条能力上各占一枚。
 */
export interface TradingPower {
  id: string;
  name: string;
  /** 要求：红利数量（noble=true 表示还要一个贵族） */
  need: Partial<Record<Gem, number>>;
  needNobel?: boolean;
  description: string;
}

export const TRADING_POWERS: TradingPower[] = [
  {
    id: 'gem-on-buy',
    name: '买卡后得宝石',
    need: { red: 3, white: 1 },
    description: '每次买下发展卡后，拿 1 个宝石指示物（放纹章的那回合不算）。',
  },
  {
    id: 'extra-gem',
    name: '同色另补一颗',
    need: { white: 2 },
    description: '拿 2 个同色宝石时，额外拿 1 个其他颜色的宝石。',
  },
  {
    id: 'gold-double',
    name: '黄金当双倍',
    need: { blue: 3, black: 1 },
    description: '购买时，每个黄金指示物当作 2 个同色宝石使用。',
  },
  {
    id: 'five-points',
    name: '立得 5 分',
    need: { green: 5 },
    needNobel: true,
    description: '立刻获得 5 点声望（只生效一次，可能直接触发终局）。',
  },
  {
    id: 'seal-points',
    name: '纹章计分',
    need: { black: 3 },
    description: '你在版图上每有 1 枚纹章，就值 1 点声望（可触发终局）。',
  },
];

export const POWER_BY_ID: Record<string, TradingPower> = Object.fromEntries(
  TRADING_POWERS.map((power) => [power.id, power]),
);

/** 每人 5 枚纹章 */
export const SEALS_PER_PLAYER = 5;

/** 2 / 3 / 4 人局的宝石堆与贵族数 */
export function setupCounts(playerCount: number): { gem: number; nobles: number } {
  if (playerCount <= 2) return { gem: 4, nobles: 3 };
  if (playerCount === 3) return { gem: 5, nobles: 4 };
  return { gem: 7, nobles: 5 };
}
