/**
 * 扑克牌力：52 张牌、种子洗牌、7 选 5 取最优、逐张比大小。
 *
 * 这里是纯函数，没有任何随机源 —— 洗牌用传进来的 rng，保证同一局能原样回放。
 */

export type Card = string;

export const RANK_LABEL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUIT_LABEL = ['♠', '♥', '♦', '♣'];
const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

/** 牌型从弱到强，下标就是分数里的 category */
export const CATEGORY_NAME = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
];

export function rankOf(card: Card): number {
  return RANKS.indexOf(card[0]!.toUpperCase()) + 2;
}

export function suitOf(card: Card): number {
  return SUITS.indexOf(card[1]!.toLowerCase());
}

export function cardLabel(card: Card): string {
  const rank = rankOf(card);
  const suit = suitOf(card);
  return `${RANK_LABEL[rank - 2]}${SUIT_LABEL[suit] ?? '?'}`;
}

export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`);
  }
  return deck;
}

/** Fisher-Yates，随机数由调用方提供（ctx.rng） */
export function shuffle(deck: Card[], rng: () => number): Card[] {
  const out = [...deck];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const tmp = out[index]!;
    out[index] = out[swap]!;
    out[swap] = tmp;
  }
  return out;
}

/** 分数：第一个数是牌型，后面依次是比大小用的点数，长度固定 6，方便直接逐位比 */
type Score = number[];

function evaluateFive(cards: Card[]): Score {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((suit) => suit === suits[0]);

  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0]! - unique[4]! === 4) straightHigh = unique[0]!;
    // A 可以当 1：A-2-3-4-5 算 5 高的顺子；K-A-2-3-4 不合法，所以只认这一种特例
    else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
      straightHigh = 5;
    }
  }

  const pad = (values: number[]) => {
    const out = [0, 0, 0, 0, 0];
    values.forEach((value, index) => {
      if (index < 5) out[index] = value;
    });
    return out;
  };

  if (isFlush && straightHigh > 0) return [8, ...pad([straightHigh])];
  if (groups[0]!.count === 4) {
    return [7, ...pad([groups[0]!.rank, groups[1]!.rank])];
  }
  if (groups[0]!.count === 3 && groups[1]!.count === 2) {
    return [6, ...pad([groups[0]!.rank, groups[1]!.rank])];
  }
  if (isFlush) return [5, ...pad(ranks)];
  if (straightHigh > 0) return [4, ...pad([straightHigh])];
  if (groups[0]!.count === 3) {
    const kickers = groups.filter((g) => g.count === 1).map((g) => g.rank);
    return [3, ...pad([groups[0]!.rank, ...kickers])];
  }
  if (groups[0]!.count === 2 && groups[1]!.count === 2) {
    const [high, low] = [groups[0]!.rank, groups[1]!.rank].sort((a, b) => b - a);
    const kicker = groups.find((g) => g.count === 1)?.rank ?? 0;
    return [2, ...pad([high, low, kicker])];
  }
  if (groups[0]!.count === 2) {
    const kickers = groups.filter((g) => g.count === 1).map((g) => g.rank);
    return [1, ...pad([groups[0]!.rank, ...kickers])];
  }
  return [0, ...pad(ranks)];
}

/** 7 选 5 取最优；少于 5 张按实际张数算（轮次早期用不到，留给人机/调试） */
export function evaluate(cards: Card[]): Score {
  return evaluateWithBest(cards).score;
}

/** 同时把凑成这手牌的 5 张挑出来，摊牌时只展示这 5 张更清楚 */
export function evaluateWithBest(cards: Card[]): { score: Score; best: Card[] } {
  if (cards.length <= 5) return { score: evaluateFive(cards), best: [...cards] };

  let bestScore: Score | null = null;
  let bestCards: Card[] = [];
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const combo = [cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!];
            const score = evaluateFive(combo);
            if (!bestScore || compareScores(score, bestScore) > 0) {
              bestScore = score;
              bestCards = combo;
            }
          }
        }
      }
    }
  }
  return { score: bestScore!, best: bestCards };
}

/** 1 = a 强，0 = 真平局，-1 = b 强 */
export function compareScores(a: Score, b: Score): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

export function categoryName(score: Score): string {
  const category = score[0] ?? 0;
  if (category === 8 && score[1] === 14) return '皇家同花顺';
  return CATEGORY_NAME[category] ?? '高牌';
}
