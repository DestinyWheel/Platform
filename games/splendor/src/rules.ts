/**
 * 璀璨宝石 —— 纯规则函数。
 *
 * 这里只做计算，不碰状态机：状态机在 server.ts，客户端也用这些函数算"能不能买"。
 */
import type { Card, CityRequirement, CitySide, Gem, Noble, TokenColor } from './data.js';
import { GEMS } from './data.js';

export type TokenBag = Record<TokenColor, number>;

export function emptyTokens(): TokenBag {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 };
}

export function tokenTotal(tokens: TokenBag): number {
  return (
    tokens.white + tokens.blue + tokens.green + tokens.red + tokens.black + tokens.gold
  );
}

/** 已购卡提供的永久红利（每色各几颗） */
export function bonusCounts(cards: Card[]): Record<Gem, number> {
  const counts: Record<Gem, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  for (const card of cards) counts[card.bonus] += 1;
  return counts;
}

/** 卡面价格减去红利后还差多少（不小于 0） */
export function shortfall(card: Card, bonuses: Record<Gem, number>): Record<Gem, number> {
  const rest: Record<Gem, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  for (const gem of GEMS) rest[gem] = Math.max(0, card.cost[gem] - bonuses[gem]);
  return rest;
}

export interface Payment {
  ok: true;
  /** 每种颜色实际付掉的宝石指示物 */
  tokens: Record<Gem, number>;
  /** 付掉的黄金数量 */
  gold: number;
}

export type PaymentResult = Payment | { ok: false; reason: string };

/**
 * 算一笔付款。
 *
 * 先花本色宝石，不够的部分用黄金补；`goldDouble`（贸易之路第 3 条能力）时
 * 一个黄金顶同色 2 颗，所以缺 3 颗只需要 2 个黄金（一个顶 2、一个顶 1）。
 */
export function planPayment(
  tokens: TokenBag,
  bonuses: Record<Gem, number>,
  card: Card,
  goldDouble = false,
): PaymentResult {
  const rest = shortfall(card, bonuses);
  const used: Record<Gem, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  let gold = 0;

  for (const gem of GEMS) {
    const need = rest[gem]!;
    if (need === 0) continue;
    const fromTokens = Math.min(tokens[gem], need);
    used[gem] = fromTokens;
    let remaining = need - fromTokens;
    if (remaining > 0) {
      const per = goldDouble ? 2 : 1;
      const units = Math.ceil(remaining / per);
      gold += units;
      remaining -= units * per;
      // remaining 可能变成负数（黄金顶多了），按规则是浪费，不退还
      if (remaining > 0) return { ok: false, reason: '宝石不够' };
    }
  }

  if (gold > tokens.gold) return { ok: false, reason: `黄金不够（需要 ${gold} 个）` };
  return { ok: true, tokens: used, gold };
}

/** 这个贵族能不能来拜访：红利是否满足 */
export function nobleQualifies(noble: Noble, bonuses: Record<Gem, number>): boolean {
  return GEMS.every((gem) => (noble.need[gem] ?? 0) <= (bonuses[gem] ?? 0));
}

/**
 * 城市板块的红利要求。
 * - fixed：指定颜色各几个
 * - any：同一种颜色 N 个（自选哪一色）
 * - anyOther：base 色 N 个 + 另一种任意颜色 N 个
 * - none：不看红利
 */
export function cityRequirementMet(
  requirement: CityRequirement,
  bonuses: Record<Gem, number>,
): boolean {
  if (requirement.kind === 'none') return true;
  if (requirement.kind === 'fixed') {
    return GEMS.every((gem) => (requirement.need[gem] ?? 0) <= (bonuses[gem] ?? 0));
  }
  if (requirement.kind === 'any') {
    return GEMS.some((gem) => (bonuses[gem] ?? 0) >= requirement.count);
  }
  const base = bonuses[requirement.base] ?? 0;
  if (base < requirement.count) return false;
  return GEMS.some(
    (gem) => gem !== requirement.base && (bonuses[gem] ?? 0) >= requirement.count,
  );
}

/** 城市板块整条要求：声望够了 + 红利够了 */
export function cityQualifies(
  side: CitySide,
  prestige: number,
  bonuses: Record<Gem, number>,
): boolean {
  return prestige >= side.prestige && cityRequirementMet(side.requirement, bonuses);
}

/** 卡面总价，用于排序和展示 */
export function cardCostTotal(card: Card): number {
  return GEMS.reduce((sum, gem) => sum + card.cost[gem], 0);
}
