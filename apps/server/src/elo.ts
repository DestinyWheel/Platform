/**
 * Elo 评分（多人局版本）。
 *
 * 只做一件事：按"你本该赢的概率"调整分数。
 * 多人局两两算期望、同分算 0.5，最后除以 (n-1)——这样一局的最大变动不随人数膨胀。
 */

export const DEFAULT_RATING = 1500;

export interface RatedPlayer {
  userId: string;
  rating: number;
  /** 已下过的局数，用来决定 K 因子 */
  games: number;
  /** 1 = 第一；并列同名次 */
  rank: number;
}

/** 新人变动大、老手趋于稳定 */
export function kFactor(games: number): number {
  if (games < 10) return 40;
  if (games < 30) return 28;
  return 20;
}

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export function computeDeltas(players: RatedPlayer[]): Map<string, number> {
  const deltas = new Map<string, number>();
  const count = players.length;
  if (count < 2) return deltas;

  for (const player of players) {
    let score = 0;
    for (const opponent of players) {
      if (opponent.userId === player.userId) continue;
      const actual = player.rank < opponent.rank ? 1 : player.rank === opponent.rank ? 0.5 : 0;
      score += actual - expectedScore(player.rating, opponent.rating);
    }
    deltas.set(player.userId, Math.round((kFactor(player.games) * score) / (count - 1)));
  }

  return deltas;
}
