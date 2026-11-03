/**
 * 璀璨宝石 —— 服务端规则。
 *
 * 一个回合：四选一（拿 3 个异色 / 拿 2 个同色 / 预留 + 黄金 / 买卡），
 * 然后按顺序结算：买卡奖励 → 要塞 → 补牌 → 抢占购买 → 贵族 → 贸易之路 → 弃指示物 → 换人。
 *
 * 扩展：荣誉之战（strongholds）、贸易之路（trading-posts），两者互斥。
 * 城市与东方之门这一版没做，manifest 里也没声明，以后加是纯增量。
 */
import { z } from 'zod';
import type {
  ActionContext,
  ActionDef,
  AnyAction,
  BaseState,
  GamePlugin,
  PlayerId,
  PublicView,
  SetupContext,
  StateDef,
} from '@platform/sdk';
import {
  CARD_BY_ID,
  CITY_BY_ID,
  CITY_TILES,
  DECKS,
  GEMS,
  NOBLE_BY_ID,
  NOBLES,
  POWER_BY_ID,
  SEALS_PER_PLAYER,
  STRONGHOLDS_PER_PLAYER,
  TRADING_POWERS,
  setupCounts,
  type Card,
  type CitySide,
  type Gem,
  type TokenColor,
} from './data.js';
import {
  bonusCounts,
  cityQualifies,
  emptyTokens,
  nobleQualifies,
  planPayment,
  tokenTotal,
  type TokenBag,
} from './rules.js';

export type ExpansionId = 'cities' | 'strongholds' | 'trading-posts';
type Level = '1' | '2' | '3';

const LEVELS: Level[] = ['1', '2', '3'];
const ROW_SIZE = 4;

export interface PlayerData {
  tokens: TokenBag;
  /** 已购发展卡 */
  cards: string[];
  /** 预留（只有本人看得到牌面） */
  reserved: string[];
  nobles: string[];
}

export interface StrongholdSpot {
  owner: PlayerId;
  count: number;
}

/** 场上的一张城市板块（同一张牌的两面算两个实例） */
export interface CityInstance {
  key: string;
  tileId: string;
  side: 0 | 1;
  owner: PlayerId | null;
}

export interface SplendorState extends BaseState {
  expansions: ExpansionId[];
  /** 场上的宝石堆（不含已发出的黄金） */
  supply: TokenBag;
  data: Record<PlayerId, PlayerData>;
  board: Record<Level, (string | null)[]>;
  decks: Record<Level, string[]>;
  /** 还没被领走的贵族 */
  nobles: string[];
  /** 卡上的要塞：只有同一个人能叠，最多 3 个 */
  strongholds: Record<string, StrongholdSpot>;
  /** 贸易之路：每人已经占下的能力 */
  seals: Record<PlayerId, string[]>;
  /** 一次性加的分（贸易之路第 4 条） */
  bonusPoints: Record<PlayerId, number>;
  /** 有人到 15 分，打完本轮结束 */
  endTriggered: boolean;
  turnSeq: number;
  /** 本回合是否已经用过抢占购买 */
  conquestUsed: boolean;
  /** 买走/预留后等待补牌的位置 */
  pendingRefill: { level: Level; index: number } | null;
  /** 待选贵族 / 待选能力 / 待选城市 */
  pendingNobles: string[];
  pendingPowers: string[];
  pendingCities: string[];
  /** 本回合的城市检查是否已经做过 */
  cityResolved: boolean;
  /** 繁华之城：场上 3 张城市板块 */
  cities: CityInstance[];
  endReason: string | null;
}

function currentPlayer(state: SplendorState): PlayerId {
  return state.players[state.turn]!;
}

/** 这一桌开了哪些扩展（可以同时开多个） */
export function has(state: SplendorState, id: ExpansionId): boolean {
  return (state.expansions ?? []).includes(id);
}

function dataOf(state: SplendorState, player: PlayerId): PlayerData {
  return state.data[player]!;
}

function cardsOf(state: SplendorState, player: PlayerId): Card[] {
  return dataOf(state, player).cards.map((id) => CARD_BY_ID[id]!).filter(Boolean);
}

export function bonusesOf(state: SplendorState, player: PlayerId): Record<Gem, number> {
  return bonusCounts(cardsOf(state, player));
}

export function sealScore(state: SplendorState, player: PlayerId): number {
  return (state.seals[player] ?? []).length;
}

/** 贸易之路第 5 条：每条自己的纹章 1 分 */
function hasPower(state: SplendorState, player: PlayerId, powerId: string): boolean {
  return (state.seals[player] ?? []).includes(powerId);
}

export function prestigeOf(state: SplendorState, player: PlayerId): number {
  const data = state.data[player];
  if (!data) return 0;
  let total = data.nobles.length * 3 + (state.bonusPoints[player] ?? 0);
  for (const id of data.cards) total += CARD_BY_ID[id]?.prestige ?? 0;
  if (hasPower(state, player, 'seal-points')) total += sealScore(state, player);
  return total;
}

/** 买卡后该拿几张黄金的替代：贸易之路第三条能力让黄金顶 2 颗 */
function goldDouble(state: SplendorState, player: PlayerId): boolean {
  return hasPower(state, player, 'gold-double');
}

function canAfford(state: SplendorState, player: PlayerId, card: Card): boolean {
  const payment = planPayment(
    dataOf(state, player).tokens,
    bonusesOf(state, player),
    card,
    goldDouble(state, player),
  );
  return payment.ok;
}

/** 真正扣钱：宝石回场，黄金回供给堆 */
function payCard(state: SplendorState, player: PlayerId, card: Card): boolean {
  const data = dataOf(state, player);
  const payment = planPayment(
    data.tokens,
    bonusesOf(state, player),
    card,
    goldDouble(state, player),
  );
  if (!payment.ok) return false;
  for (const gem of GEMS) {
    const used = payment.tokens[gem]!;
    if (used > 0) {
      data.tokens[gem] -= used;
      state.supply[gem] += used;
    }
  }
  if (payment.gold > 0) {
    data.tokens.gold -= payment.gold;
    state.supply.gold += payment.gold;
  }
  return true;
}

function refill(state: SplendorState): void {
  const pending = state.pendingRefill;
  if (!pending) return;
  state.pendingRefill = null;
  const deck = state.decks[pending.level];
  const next = deck.pop();
  state.board[pending.level][pending.index] = next ?? null;
}

/** 从牌桌拿走一张卡，记下要补的位置 */
function takeFromBoard(state: SplendorState, cardId: string): boolean {
  for (const level of LEVELS) {
    const index = state.board[level].indexOf(cardId);
    if (index >= 0) {
      state.board[level][index] = null;
      state.pendingRefill = { level, index };
      return true;
    }
  }
  return false;
}

function addTokens(state: SplendorState, player: PlayerId, color: TokenColor, count: number): void {
  dataOf(state, player).tokens[color] += count;
  state.supply[color] -= count;
}

function giveGold(state: SplendorState, player: PlayerId): void {
  if (state.supply.gold > 0) {
    dataOf(state, player).tokens.gold += 1;
    state.supply.gold -= 1;
  }
}

function takeNoble(state: SplendorState, player: PlayerId, nobleId: string): void {
  const index = state.nobles.indexOf(nobleId);
  if (index < 0) return;
  state.nobles.splice(index, 1);
  dataOf(state, player).nobles.push(nobleId);
}

function qualifyingNobles(state: SplendorState, player: PlayerId): string[] {
  const bonuses = bonusesOf(state, player);
  return state.nobles.filter((id) => {
    const noble = NOBLE_BY_ID[id];
    return noble ? nobleQualifies(noble, bonuses) : false;
  });
}

function qualifyingPowers(state: SplendorState, player: PlayerId): string[] {
  if (!has(state, 'trading-posts')) return [];
  const bonuses = bonusesOf(state, player);
  const owned = state.seals[player] ?? [];
  if (owned.length >= SEALS_PER_PLAYER) return [];
  return TRADING_POWERS.filter((power) => {
    if (owned.includes(power.id)) return false;
    if (power.needNobel && dataOf(state, player).nobles.length === 0) return false;
    return GEMS.every((gem) => (power.need[gem] ?? 0) <= (bonuses[gem] ?? 0));
  }).map((power) => power.id);
}

/** 三枚自己的要塞压在同一张卡上：可以立刻买下它 */
function conquestTargets(state: SplendorState, player: PlayerId): string[] {
  if (!has(state, 'strongholds')) return [];
  return Object.entries(state.strongholds)
    .filter(([, spot]) => spot.owner === player && spot.count >= STRONGHOLDS_PER_PLAYER)
    .map(([cardId]) => cardId)
    .filter((cardId) => canAfford(state, player, CARD_BY_ID[cardId]!));
}

function citySideOf(instance: CityInstance): CitySide {
  return CITY_BY_ID[instance.tileId]!.sides[instance.side];
}

/** 回合结束能拿的城市板块：已经有一张的人不再拿 */
function qualifyingCities(state: SplendorState, player: PlayerId): CityInstance[] {
  if (!has(state, 'cities')) return [];
  if (state.cities.some((city) => city.owner === player)) return [];
  const bonuses = bonusesOf(state, player);
  const prestige = prestigeOf(state, player);
  return state.cities.filter(
    (city) => !city.owner && cityQualifies(citySideOf(city), prestige, bonuses),
  );
}

function takeCity(
  state: SplendorState,
  ctx: ActionContext<SplendorState>,
  key: string,
): void {
  const city = state.cities.find((item) => item.key === key);
  if (!city || city.owner) return;
  city.owner = ctx.playerId;
  // 有人拿到城市板块：本轮走完就结束
  state.endTriggered = true;
  const side = citySideOf(city);
  ctx.emit({
    type: 'log',
    key: 'sp.city',
    args: { player: ctx.playerId, city: city.tileId, prestige: side.prestige },
  });
  ctx.emit({ type: 'achievement', player: ctx.playerId, key: 'city-lord' });
}

/* ------------------------------------------------------------------ */
/* 回合推进                                                            */
/* ------------------------------------------------------------------ */

function enterDiscard(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  const player = currentPlayer(state);
  if (tokenTotal(dataOf(state, player).tokens) > 10) {
    ctx.goTo('discard');
    return;
  }
  finishTurn(state, ctx);
}

function enterSeal(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  const player = currentPlayer(state);
  const powers = qualifyingPowers(state, player);
  state.pendingPowers = powers;
  if (powers.length === 0) {
    enterDiscard(state, ctx);
    return;
  }
  if (powers.length === 1) {
    placeSeal(state, ctx, powers[0]!);
    enterDiscard(state, ctx);
    return;
  }
  ctx.goTo('seal');
}

function enterNoble(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  const player = currentPlayer(state);
  const nobles = qualifyingNobles(state, player);
  state.pendingNobles = nobles;
  if (nobles.length === 0) {
    enterSeal(state, ctx);
    return;
  }
  if (nobles.length === 1) {
    takeNoble(state, player, nobles[0]!);
    enterSeal(state, ctx);
    return;
  }
  ctx.goTo('noble');
}

function placeSeal(
  state: SplendorState,
  ctx: ActionContext<SplendorState>,
  powerId: string,
): void {
  const player = currentPlayer(state);
  const power = POWER_BY_ID[powerId];
  if (!power) return;
  if (!state.seals[player]) state.seals[player] = [];
  if (state.seals[player]!.includes(powerId)) return;
  state.seals[player]!.push(powerId);
  if (power.id === 'five-points') state.bonusPoints[player] = (state.bonusPoints[player] ?? 0) + 5;
  ctx.emit({
    type: 'log',
    key: 'sp.seal',
    args: { player, power: powerId, name: power.name },
  });
}

/** 买完卡之后：先结算"得宝石"能力，再进要塞 */
function afterBuy(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  const player = currentPlayer(state);
  const canTakeGem = hasPower(state, player, 'gem-on-buy');
  const anyGem = GEMS.some((gem) => state.supply[gem] > 0);
  if (canTakeGem && anyGem) {
    ctx.goTo('buy-gem');
    return;
  }
  afterBuyGem(state, ctx);
}

function afterBuyGem(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  if (has(state, 'strongholds')) {
    ctx.goTo('stronghold');
    return;
  }
  refill(state);
  afterRefill(state, ctx);
}

function afterStronghold(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  refill(state);
  afterRefill(state, ctx);
}

function afterRefill(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  const player = currentPlayer(state);
  if (has(state, 'strongholds') && !state.conquestUsed) {
    const targets = conquestTargets(state, player);
    if (targets.length > 0) {
      ctx.goTo('conquest');
      return;
    }
  }
  enterNoble(state, ctx);
}

function finishTurn(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  // 繁华之城：回合结束先看能不能拿城市板块（拿到就直接触发终局）
  if (has(state, 'cities') && !state.cityResolved) {
    const player = currentPlayer(state);
    const options = qualifyingCities(state, player);
    if (options.length > 1) {
      state.pendingCities = options.map((city) => city.key);
      ctx.goTo('city');
      return;
    }
    state.cityResolved = true;
    if (options.length === 1) takeCity(state, ctx, options[0]!.key);
  }

  if (!has(state, 'cities')) {
    const reached = state.players.some((player) => prestigeOf(state, player) >= 15);
    if (reached) state.endTriggered = true;
  }

  const next = (state.turn + 1) % state.players.length;
  if (state.endTriggered && next === 0) {
    finishGame(state, ctx);
    return;
  }
  state.turn = next;
  if (next === 0) state.round += 1;
  state.turnSeq += 1;
  state.conquestUsed = false;
  state.pendingNobles = [];
  state.pendingPowers = [];
  state.pendingCities = [];
  ctx.goTo('turn');
}

function finishGame(state: SplendorState, ctx: ActionContext<SplendorState>): void {
  const rows = state.players.map((player) => ({
    player,
    prestige: prestigeOf(state, player),
    cards: dataOf(state, player).cards.length,
    city: state.cities.some((item) => item.owner === player),
  }));

  if (has(state, 'cities')) {
    // 只有一个人拿到城市板块 -> 他赢；多人拿到 -> 其中声望最高的赢
    rows.sort(
      (a, b) => Number(b.city) - Number(a.city) || b.prestige - a.prestige || a.cards - b.cards,
    );
  } else {
    rows.sort((a, b) => b.prestige - a.prestige || a.cards - b.cards);
  }

  const ranking: PlayerId[][] = [];
  for (const row of rows) {
    const last = ranking[ranking.length - 1];
    const previous = rows.find((item) => item.player === last?.[0]);
    if (
      last &&
      previous &&
      previous.prestige === row.prestige &&
      previous.cards === row.cards &&
      previous.city === row.city
    ) {
      last.push(row.player);
    } else {
      ranking.push([row.player]);
    }
  }

  state.ranking = ranking;
  state.finished = true;
  state.phase = 'finished';
  state.endReason = has(state, 'cities') ? 'cities' : 'fifteen';
  state.endTriggered = true;

  const scores: Record<string, number> = {};
  for (const row of rows) scores[row.player] = row.prestige;
  ctx.emit({ type: 'log', key: 'sp.gameEnd', args: { ranking: ranking[0], scores } });

  for (const winner of ranking[0] ?? []) {
    ctx.emit({ type: 'achievement', player: winner, key: 'first-win' });
  }
  for (const player of state.players) {
    if (prestigeOf(state, player) >= 15) {
      ctx.emit({ type: 'achievement', player, key: 'fifteen' });
    }
    if (dataOf(state, player).nobles.length >= 3) {
      ctx.emit({ type: 'achievement', player, key: 'noble-collector' });
    }
    if ((state.seals[player] ?? []).length >= TRADING_POWERS.length) {
      ctx.emit({ type: 'achievement', player, key: 'trade-empire' });
    }
    const stacked = Object.values(state.strongholds).some(
      (spot) => spot.owner === player && spot.count >= STRONGHOLDS_PER_PLAYER,
    );
    if (stacked) ctx.emit({ type: 'achievement', player, key: 'stronghold-master' });
  }
  ctx.goTo('finished');
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

const take3: ActionDef<SplendorState> = {
  allowedIn: ['turn'],
  schema: z.object({ colors: z.array(z.enum(['white', 'blue', 'green', 'red', 'black'])).length(3) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const { colors } = action.payload as { colors: Gem[] };
    if (new Set(colors).size !== colors.length) return { ok: false, reason: '拿 3 个必须是三种不同颜色' };
    for (const color of colors) {
      if (state.supply[color] <= 0) return { ok: false, reason: `${color} 的宝石不够` };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { colors } = action.payload as { colors: Gem[] };
    for (const color of colors) addTokens(state, ctx.playerId, color, 1);
    ctx.emit({ type: 'log', key: 'sp.take3', args: { player: ctx.playerId, colors } });
    enterNoble(state, ctx);
  },
};

const take2: ActionDef<SplendorState> = {
  allowedIn: ['turn'],
  schema: z.object({ color: z.enum(['white', 'blue', 'green', 'red', 'black']) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const { color } = action.payload as { color: Gem };
    if (state.supply[color] < 4) return { ok: false, reason: '同色宝石少于 4 个时不能拿 2 个' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { color } = action.payload as { color: Gem };
    addTokens(state, ctx.playerId, color, 2);
    ctx.emit({ type: 'log', key: 'sp.take2', args: { player: ctx.playerId, color } });
    const power = hasPower(state, ctx.playerId, 'extra-gem');
    const anyGem = GEMS.some((gem) => state.supply[gem] > 0);
    if (power && anyGem) {
      ctx.goTo('extra-gem');
      return;
    }
    enterNoble(state, ctx);
  },
};

const chooseExtraGem: ActionDef<SplendorState> = {
  allowedIn: ['extra-gem'],
  schema: z.object({ color: z.enum(['white', 'blue', 'green', 'red', 'black']) }),
  validate(state, action, ctx) {
    const { color } = action.payload as { color: Gem };
    if (state.supply[color] <= 0) return { ok: false, reason: '这个颜色已经没有宝石了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { color } = action.payload as { color: Gem };
    addTokens(state, ctx.playerId, color, 1);
    ctx.emit({ type: 'log', key: 'sp.extraGem', args: { player: ctx.playerId, color } });
    enterNoble(state, ctx);
  },
};

const chooseBuyGem: ActionDef<SplendorState> = {
  allowedIn: ['buy-gem'],
  schema: z.object({ color: z.enum(['white', 'blue', 'green', 'red', 'black']) }),
  validate(state, action, ctx) {
    const { color } = action.payload as { color: Gem };
    if (state.supply[color] <= 0) return { ok: false, reason: '这个颜色已经没有宝石了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { color } = action.payload as { color: Gem };
    addTokens(state, ctx.playerId, color, 1);
    ctx.emit({ type: 'log', key: 'sp.buyGem', args: { player: ctx.playerId, color } });
    afterBuyGem(state, ctx);
  },
};

const reserve: ActionDef<SplendorState> = {
  allowedIn: ['turn'],
  schema: z.object({
    from: z.enum(['board', 'deck']),
    level: z.enum(['1', '2', '3']),
    index: z.number().int().min(0).max(ROW_SIZE - 1).optional(),
  }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const payload = action.payload as { from: 'board' | 'deck'; level: Level; index?: number };
    if (dataOf(state, ctx.playerId).reserved.length >= 3) {
      return { ok: false, reason: '最多只能预留 3 张' };
    }
    if (payload.from === 'board') {
      const index = payload.index ?? -1;
      if (!state.board[payload.level]?.[index]) return { ok: false, reason: '这里没有牌' };
    } else if (state.decks[payload.level].length === 0) {
      return { ok: false, reason: '这个牌堆已经空了' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as { from: 'board' | 'deck'; level: Level; index?: number };
    const data = dataOf(state, ctx.playerId);
    let cardId: string | null = null;
    if (payload.from === 'board') {
      cardId = state.board[payload.level][payload.index!] ?? null;
      if (cardId) {
        state.board[payload.level][payload.index!] = null;
        state.pendingRefill = { level: payload.level, index: payload.index! };
      }
    } else {
      cardId = state.decks[payload.level].pop() ?? null;
    }
    if (!cardId) return;
    data.reserved.push(cardId);
    giveGold(state, ctx.playerId);
    ctx.emit({ type: 'log', key: 'sp.reserve', args: { player: ctx.playerId, card: cardId } });
    refill(state);
    enterNoble(state, ctx);
  },
};

const buy: ActionDef<SplendorState> = {
  allowedIn: ['turn'],
  schema: z.object({ cardId: z.string().min(1) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const { cardId } = action.payload as { cardId: string };
    const card = CARD_BY_ID[cardId];
    if (!card) return { ok: false, reason: '没有这张牌' };
    const data = dataOf(state, ctx.playerId);
    const onBoard = LEVELS.some((level) => state.board[level].includes(cardId));
    const reserved = data.reserved.includes(cardId);
    if (!onBoard && !reserved) return { ok: false, reason: '这张牌不在桌上也不在你手里' };
    const spot = state.strongholds[cardId];
    if (has(state, 'strongholds') && spot && spot.owner !== ctx.playerId) {
      return { ok: false, reason: '这张牌被别的公会占了，你买不了' };
    }
    if (!canAfford(state, ctx.playerId, card)) return { ok: false, reason: '宝石不够' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { cardId } = action.payload as { cardId: string };
    const card = CARD_BY_ID[cardId]!;
    const data = dataOf(state, ctx.playerId);
    payCard(state, ctx.playerId, card);

    const reservedIndex = data.reserved.indexOf(cardId);
    if (reservedIndex >= 0) data.reserved.splice(reservedIndex, 1);
    else takeFromBoard(state, cardId);

    data.cards.push(cardId);
    ctx.emit({ type: 'log', key: 'sp.buy', args: { player: ctx.playerId, card: cardId } });
    afterBuy(state, ctx);
  },
};

const buyConquest: ActionDef<SplendorState> = {
  allowedIn: ['conquest'],
  schema: z.object({ cardId: z.string().min(1) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const { cardId } = action.payload as { cardId: string };
    if (!conquestTargets(state, ctx.playerId).includes(cardId)) {
      return { ok: false, reason: '这不是你能抢占的牌' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { cardId } = action.payload as { cardId: string };
    const card = CARD_BY_ID[cardId]!;
    const data = dataOf(state, ctx.playerId);
    payCard(state, ctx.playerId, card);
    takeFromBoard(state, cardId);
    delete state.strongholds[cardId];
    data.cards.push(cardId);
    state.conquestUsed = true;
    ctx.emit({ type: 'log', key: 'sp.conquestBuy', args: { player: ctx.playerId, card: cardId } });
    if (has(state, 'strongholds')) {
      ctx.goTo('stronghold');
      return;
    }
    refill(state);
    enterNoble(state, ctx);
  },
};

const skipConquest: ActionDef<SplendorState> = {
  allowedIn: ['conquest'],
  schema: z.object({}),
  reduce(state, _action, ctx) {
    state.conquestUsed = true;
    enterNoble(state, ctx);
  },
};

const placeStronghold: ActionDef<SplendorState> = {
  allowedIn: ['stronghold'],
  schema: z.object({ cardId: z.string().min(1), from: z.string().min(1).optional() }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const payload = action.payload as { cardId: string; from?: string };
    const target = CARD_BY_ID[payload.cardId];
    if (!target) return { ok: false, reason: '没有这张牌' };
    if (!LEVELS.some((level) => state.board[level].includes(payload.cardId))) {
      return { ok: false, reason: '只能放在桌面上正面朝上的牌上' };
    }
    const spot = state.strongholds[payload.cardId];
    if (spot && spot.owner !== ctx.playerId) return { ok: false, reason: '这张牌上有别的公会的要塞' };
    if (spot && spot.count >= STRONGHOLDS_PER_PLAYER) {
      return { ok: false, reason: '这张牌上已经有三个要塞了' };
    }

    const own = Object.entries(state.strongholds).filter(([, item]) => item.owner === ctx.playerId);
    const placed = own.reduce((sum, [, item]) => sum + item.count, 0);
    if (payload.from) {
      const source = state.strongholds[payload.from];
      if (!source || source.owner !== ctx.playerId) return { ok: false, reason: '那个位置没有你的要塞' };
      if (payload.from === payload.cardId) return { ok: false, reason: '要塞已经在这张牌上了' };
    } else if (placed >= STRONGHOLDS_PER_PLAYER) {
      return { ok: false, reason: '三个要塞都已经放出去了，只能移动或移除' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as { cardId: string; from?: string };
    if (payload.from) {
      const source = state.strongholds[payload.from];
      if (source) {
        source.count -= 1;
        if (source.count <= 0) delete state.strongholds[payload.from];
      }
    }
    const spot = state.strongholds[payload.cardId];
    if (spot) spot.count += 1;
    else state.strongholds[payload.cardId] = { owner: ctx.playerId, count: 1 };
    ctx.emit({
      type: 'log',
      key: 'sp.strongholdPlace',
      args: { player: ctx.playerId, card: payload.cardId },
    });
    const spotNow = state.strongholds[payload.cardId];
    if (spotNow && spotNow.count >= STRONGHOLDS_PER_PLAYER) {
      ctx.emit({ type: 'achievement', player: ctx.playerId, key: 'stronghold-master' });
    }
    afterStronghold(state, ctx);
  },
};

const removeStronghold: ActionDef<SplendorState> = {
  allowedIn: ['stronghold'],
  schema: z.object({ cardId: z.string().min(1) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const { cardId } = action.payload as { cardId: string };
    const spot = state.strongholds[cardId];
    if (!spot) return { ok: false, reason: '这张牌上没有要塞' };
    if (spot.owner === ctx.playerId) return { ok: false, reason: '只能移除对手的要塞' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { cardId } = action.payload as { cardId: string };
    const spot = state.strongholds[cardId];
    if (spot) {
      spot.count -= 1;
      if (spot.count <= 0) delete state.strongholds[cardId];
    }
    ctx.emit({ type: 'log', key: 'sp.strongholdRemove', args: { player: ctx.playerId, card: cardId } });
    afterStronghold(state, ctx);
  },
};

const chooseNoble: ActionDef<SplendorState> = {
  allowedIn: ['noble'],
  schema: z.object({ nobleId: z.string().min(1) }),
  validate(state, action, ctx) {
    const { nobleId } = action.payload as { nobleId: string };
    if (!state.pendingNobles.includes(nobleId)) return { ok: false, reason: '这位贵族不能来' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { nobleId } = action.payload as { nobleId: string };
    takeNoble(state, ctx.playerId, nobleId);
    ctx.emit({ type: 'log', key: 'sp.noble', args: { player: ctx.playerId, noble: nobleId } });
    state.pendingNobles = [];
    enterSeal(state, ctx);
  },
};

const choosePower: ActionDef<SplendorState> = {
  allowedIn: ['seal'],
  schema: z.object({ powerId: z.string().min(1) }),
  validate(state, action, ctx) {
    const { powerId } = action.payload as { powerId: string };
    if (!state.pendingPowers.includes(powerId)) return { ok: false, reason: '这个能力你还占不了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { powerId } = action.payload as { powerId: string };
    placeSeal(state, ctx, powerId);
    state.pendingPowers = [];
    enterDiscard(state, ctx);
  },
};

const chooseCity: ActionDef<SplendorState> = {
  allowedIn: ['city'],
  schema: z.object({ key: z.string().min(1) }),
  validate(state, action) {
    const { key } = action.payload as { key: string };
    if (!state.pendingCities.includes(key)) return { ok: false, reason: '这张城市板块现在拿不了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { key } = action.payload as { key: string };
    state.cityResolved = true;
    state.pendingCities = [];
    takeCity(state, ctx, key);
    finishTurn(state, ctx);
  },
};

const discardToken: ActionDef<SplendorState> = {
  allowedIn: ['discard'],
  schema: z.object({ color: z.enum(['white', 'blue', 'green', 'red', 'black', 'gold']) }),
  validate(state, action, ctx) {
    const { color } = action.payload as { color: TokenColor };
    if (dataOf(state, ctx.playerId).tokens[color] <= 0) return { ok: false, reason: '你没有这种指示物' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { color } = action.payload as { color: TokenColor };
    dataOf(state, ctx.playerId).tokens[color] -= 1;
    state.supply[color] += 1;
    ctx.emit({ type: 'log', key: 'sp.discard', args: { player: ctx.playerId, color } });
    enterDiscard(state, ctx);
  },
};

/** 兜底：桌上没宝石、也买不起任何牌时才会出现，避免死锁 */
const pass: ActionDef<SplendorState> = {  allowedIn: ['turn'],
  schema: z.object({}),
  reduce(state, _action, ctx) {
    ctx.emit({ type: 'log', key: 'sp.pass', args: { player: ctx.playerId } });
    enterNoble(state, ctx);
  },
};

/* ------------------------------------------------------------------ */
/* 阶段                                                                */
/* ------------------------------------------------------------------ */

const states: Record<string, StateDef<SplendorState>> = {
  turn: {
    type: 'activePlayer',
    onEnter(state) {
      state.conquestUsed = false;
      state.pendingNobles = [];
      state.pendingPowers = [];
      state.pendingCities = [];
      state.cityResolved = false;
    },
    onTimeout(state, ctx) {
      const moves = turnMoves(state, currentPlayer(state));
      return moves[0] ?? { type: 'pass', payload: {} };
    },
  },
  city: {
    type: 'activePlayer',
    onTimeout(state) {
      const key = state.pendingCities[0];
      return key ? { type: 'chooseCity', payload: { key } } : null;
    },
  },
  'buy-gem': {
    type: 'activePlayer',
    onTimeout(state) {
      const color = GEMS.find((gem) => state.supply[gem] > 0);
      return color ? { type: 'chooseBuyGem', payload: { color } } : null;
    },
  },
  'extra-gem': {
    type: 'activePlayer',
    onTimeout(state) {
      const color = GEMS.find((gem) => state.supply[gem] > 0);
      return color ? { type: 'chooseExtraGem', payload: { color } } : null;
    },
  },
  stronghold: {
    type: 'activePlayer',
    onTimeout(state) {
      const moves = strongholdMoves(state, currentPlayer(state));
      return moves[0] ?? null;
    },
  },
  conquest: {
    type: 'activePlayer',
    onTimeout() {
      return { type: 'skipConquest', payload: {} };
    },
  },
  noble: {
    type: 'activePlayer',
    onTimeout(state) {
      const nobleId = state.pendingNobles[0];
      return nobleId ? { type: 'chooseNoble', payload: { nobleId } } : null;
    },
  },
  seal: {
    type: 'activePlayer',
    onTimeout(state) {
      const powerId = state.pendingPowers[0];
      return powerId ? { type: 'choosePower', payload: { powerId } } : null;
    },
  },
  discard: {
    type: 'activePlayer',
    onTimeout(state, ctx) {
      const tokens = dataOf(state, currentPlayer(state)).tokens;
      const color = (Object.keys(tokens) as TokenColor[]).find((item) => tokens[item] > 0);
      return color ? { type: 'discardToken', payload: { color } } : null;
    },
  },
  finished: { type: 'global' },
};

/* ------------------------------------------------------------------ */
/* 合法动作枚举                                                        */
/* ------------------------------------------------------------------ */

function boardCards(state: SplendorState): { level: Level; index: number; cardId: string }[] {
  const list: { level: Level; index: number; cardId: string }[] = [];
  for (const level of LEVELS) {
    state.board[level].forEach((cardId, index) => {
      if (cardId) list.push({ level, index, cardId });
    });
  }
  return list;
}

function turnMoves(state: SplendorState, player: PlayerId): AnyAction[] {
  const moves: AnyAction[] = [];

  const available = GEMS.filter((gem) => state.supply[gem] > 0);
  for (let a = 0; a < available.length; a += 1) {
    for (let b = a + 1; b < available.length; b += 1) {
      for (let c = b + 1; c < available.length; c += 1) {
        const colors = [available[a]!, available[b]!, available[c]!];
        moves.push({ type: 'take3', payload: { colors } });
      }
    }
  }
  for (const color of GEMS) {
    if (state.supply[color] >= 4) moves.push({ type: 'take2', payload: { color } });
  }

  const data = dataOf(state, player);
  if (data.reserved.length < 3) {
    for (const item of boardCards(state)) {
      moves.push({
        type: 'reserve',
        payload: { from: 'board', level: item.level, index: item.index },
      });
    }
    for (const level of LEVELS) {
      if (state.decks[level].length > 0) {
        moves.push({ type: 'reserve', payload: { from: 'deck', level } });
      }
    }
  }

  for (const item of boardCards(state)) {
    const spot = state.strongholds[item.cardId];
    if (has(state, 'strongholds') && spot && spot.owner !== player) continue;
    if (canAfford(state, player, CARD_BY_ID[item.cardId]!)) {
      moves.push({ type: 'buy', payload: { cardId: item.cardId } });
    }
  }
  for (const cardId of data.reserved) {
    if (canAfford(state, player, CARD_BY_ID[cardId]!)) {
      moves.push({ type: 'buy', payload: { cardId } });
    }
  }

  if (moves.length === 0) moves.push({ type: 'pass', payload: {} });
  return moves;
}

function strongholdMoves(state: SplendorState, player: PlayerId): AnyAction[] {
  const moves: AnyAction[] = [];
  const own = Object.entries(state.strongholds).filter(([, spot]) => spot.owner === player);
  const placed = own.reduce((sum, [, spot]) => sum + spot.count, 0);

  for (const item of boardCards(state)) {
    const spot = state.strongholds[item.cardId];
    if (spot && spot.owner !== player) continue;
    const full = spot && spot.owner === player && spot.count >= STRONGHOLDS_PER_PLAYER;
    if (full) continue;
    if (placed < STRONGHOLDS_PER_PLAYER) {
      moves.push({ type: 'placeStronghold', payload: { cardId: item.cardId } });
    }
    for (const [from] of own) {
      if (from === item.cardId) continue;
      moves.push({ type: 'placeStronghold', payload: { cardId: item.cardId, from } });
    }
  }
  for (const [cardId, spot] of Object.entries(state.strongholds)) {
    if (spot.owner !== player) moves.push({ type: 'removeStronghold', payload: { cardId } });
  }
  return moves;
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function playerView(state: SplendorState, player: PlayerId, viewer: PlayerId | null) {
  const data = dataOf(state, player);
  const isOwner = viewer === player;
  return {
    id: player,
    tokens: data.tokens,
    cards: data.cards,
    reserved: isOwner ? data.reserved : data.reserved.map(() => null),
    reservedCount: data.reserved.length,
    nobles: data.nobles,
    bonuses: bonusesOf(state, player),
    prestige: prestigeOf(state, player),
    seals: state.seals[player] ?? [],
  };
}

const splendor: GamePlugin<SplendorState> = {
  manifest: {
    id: 'splendor',
    name: '璀璨宝石',
    version: '0.1.0',
    apiVersion: '^1.0.0',
    players: { min: 2, max: 4 },
    modes: ['realtime', 'turnbased'],
    tags: ['卡牌', '策略', '资源'],
    estimatedMinutes: 30,
    realtime: { fast: 45, normal: 90, slow: 180 },
    description: '收宝石、买发展卡、请贵族；2–4 人，先到 15 分并就位的人赢。',
    intro:
      '经典《璀璨宝石》。每回合四选一：拿 3 个异色宝石、拿 2 个同色宝石、预留一张卡并拿黄金、或买一张卡。\n\n## 每回合\n\n- 拿 3 个不同颜色；或拿 2 个同色（该色场上至少 4 个）\n- 预留 1 张卡（手牌上限 3），同时拿 1 个黄金；黄金可当任意颜色\n- 买卡：场上的或自己预留的，红利会永久抵扣同色价格\n\n## 结束\n\n有人达到 15 分后，本轮走完即结束；分高者胜，同分则买卡少的人胜。\n\n## 扩展\n\n三个模块可以单独开，也可以混开。\n\n- 繁华之城：不摆贵族，改抢 3 座城市；拿到一块城市板块，本轮走完即结束\n- 荣誉之战：买卡后必须放置/移动要塞或拆掉对手一个；同一张牌上三个自己的要塞可以立刻再买一次\n- 贸易之路：回合结束满足条件即可占下一条能力，永久生效',
    expansions: [
      {
        id: 'cities',
        name: '城市扩展 · 繁华之城',
        description: '不摆贵族，改抢 3 座城市：拿到一块城市板块，本轮走完就结束。',
      },
      {
        id: 'strongholds',
        name: '城市扩展 · 荣誉之战',
        description: '每人 3 个要塞，占领牌桌、控住关键卡；互斥模块之一。',
      },
      {
        id: 'trading-posts',
        name: '城市扩展 · 贸易之路',
        description: '达成要求占下 5 条能力之一，永久获得加成；互斥模块之一。',
      },
    ],
    achievements: [
      { id: 'first-win', name: '首胜', description: '在璀璨宝石里赢下第一局', icon: '💎', color: '#3f4a7a' },
      { id: 'fifteen', name: '十五分', description: '一局打到 15 分以上', icon: '✨', color: '#6b5320' },
      { id: 'noble-collector', name: '贵族收藏', description: '一局请到 3 位贵族', icon: '👑', color: '#4a2f5a' },
      { id: 'city-lord', name: '城市之主', description: '拿到一块城市板块', icon: '🏙️', color: '#7a5a2c' },
      { id: 'stronghold-master', name: '三堡压顶', description: '三个要塞压在同一张卡上', icon: '🏰', color: '#2c5a4a' },
      { id: 'trade-empire', name: '贸易帝国', description: '一局占下全部 5 条贸易之路能力', icon: '🐫', color: '#5a4a2c' },
    ],
  },

  createState({ players, expansions, seed }: SetupContext): SplendorState {
    const rng = mulberry32(seed);
    // 扩展可以同时开多个（BGA 也允许混开）；去重后保留平台给的顺序
    const chosen: ExpansionId[] = [
      ...new Set(
        (expansions ?? []).filter(
          (id): id is ExpansionId =>
            id === 'cities' || id === 'strongholds' || id === 'trading-posts',
        ),
      ),
    ];
    const hasCities = chosen.includes('cities');

    const decks: Record<Level, string[]> = {
      '1': shuffle(DECKS['1'], rng),
      '2': shuffle(DECKS['2'], rng),
      '3': shuffle(DECKS['3'], rng),
    };
    const board: Record<Level, (string | null)[]> = { '1': [], '2': [], '3': [] };
    for (const level of LEVELS) {
      for (let index = 0; index < ROW_SIZE; index += 1) {
        board[level].push(decks[level].pop() ?? null);
      }
    }

    const { gem, nobles } = setupCounts(players.length);
    const supply = emptyTokens();
    for (const color of GEMS) supply[color] = gem;
    supply.gold = 5;

    const data: Record<PlayerId, PlayerData> = {};
    const seals: Record<PlayerId, string[]> = {};
    const bonusPoints: Record<PlayerId, number> = {};
    for (const player of players) {
      data[player] = { tokens: emptyTokens(), cards: [], reserved: [], nobles: [] };
      seals[player] = [];
      bonusPoints[player] = 0;
    }

    // 繁华之城：不摆贵族，改摆 3 张城市板块（正反面随机）
    const cities: CityInstance[] = hasCities
      ? shuffle(CITY_TILES, rng)
          .slice(0, 3)
          .map((tile) => {
            const side = (rng() < 0.5 ? 0 : 1) as 0 | 1;
            return { key: `${tile.id}-${side}`, tileId: tile.id, side, owner: null };
          })
      : [];

    return {
      players: [...players],
      turn: 0,
      round: 1,
      phase: 'turn',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      expansions: chosen,
      supply,
      data,
      board,
      decks,
      nobles: hasCities ? [] : shuffle(NOBLES.map((noble) => noble.id), rng).slice(0, nobles),
      cities,
      strongholds: {},
      seals,
      bonusPoints,
      endTriggered: false,
      turnSeq: 0,
      conquestUsed: false,
      pendingRefill: null,
      pendingNobles: [],
      pendingPowers: [],
      pendingCities: [],
      cityResolved: false,
      endReason: null,
    };
  },

  states,
  actions: {
    take3,
    take2,
    chooseExtraGem,
    chooseBuyGem,
    reserve,
    buy,
    buyConquest,
    skipConquest,
    placeStronghold,
    removeStronghold,
    chooseNoble,
    choosePower,
    chooseCity,
    discardToken,
    pass,
  },

  view(state, viewer): PublicView {
    const me = viewer === 'spectator' ? null : viewer;
    return {
      phase: state.phase,
      players: state.players,
      turn: state.finished ? null : currentPlayer(state),
      round: state.round,
      finished: state.finished,
      ranking: state.ranking,
      data: {
        expansions: state.expansions,
        supply: state.supply,
        board: state.board,
        deckCounts: {
          '1': state.decks['1'].length,
          '2': state.decks['2'].length,
          '3': state.decks['3'].length,
        },
        nobles: state.nobles,
        cities: state.cities,
        strongholds: state.strongholds,
        conquestTargets: state.finished ? [] : conquestTargets(state, currentPlayer(state)),
        pendingNobles: state.pendingNobles,
        pendingPowers: state.pendingPowers,
        pendingCities: state.pendingCities,
        endTriggered: state.endTriggered,
        players: state.players.map((player) => playerView(state, player, me)),
        you: me,
        seats: state.players.length,
      },
    };
  },

  legalMoves(state, playerId) {
    if (state.finished) return [];
    if (state.phase === 'turn' && currentPlayer(state) === playerId) {
      return turnMoves(state, playerId);
    }
    if (state.phase === 'stronghold' && currentPlayer(state) === playerId) {
      return strongholdMoves(state, playerId);
    }
    if (state.phase === 'conquest' && currentPlayer(state) === playerId) {
      const targets = conquestTargets(state, playerId).map((cardId) => ({
        type: 'buyConquest',
        payload: { cardId },
      }));
      return [...targets, { type: 'skipConquest', payload: {} }];
    }
    if (state.phase === 'noble' && currentPlayer(state) === playerId) {
      return state.pendingNobles.map((nobleId) => ({ type: 'chooseNoble', payload: { nobleId } }));
    }
    if (state.phase === 'seal' && currentPlayer(state) === playerId) {
      return state.pendingPowers.map((powerId) => ({ type: 'choosePower', payload: { powerId } }));
    }
    if (state.phase === 'city' && currentPlayer(state) === playerId) {
      return state.pendingCities.map((key) => ({ type: 'chooseCity', payload: { key } }));
    }
    if (state.phase === 'discard' && currentPlayer(state) === playerId) {
      const tokens = dataOf(state, playerId).tokens;
      return (Object.keys(tokens) as TokenColor[])
        .filter((color) => tokens[color] > 0)
        .map((color) => ({ type: 'discardToken', payload: { color } }));
    }
    if (state.phase === 'buy-gem' && currentPlayer(state) === playerId) {
      return GEMS.filter((gem) => state.supply[gem] > 0).map((color) => ({
        type: 'chooseBuyGem',
        payload: { color },
      }));
    }
    if (state.phase === 'extra-gem' && currentPlayer(state) === playerId) {
      return GEMS.filter((gem) => state.supply[gem] > 0).map((color) => ({
        type: 'chooseExtraGem',
        payload: { color },
      }));
    }
    return [];
  },
};

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const temp = copy[index]!;
    copy[index] = copy[swap]!;
    copy[swap] = temp;
  }
  return copy;
}

export default splendor;
export { splendor };
