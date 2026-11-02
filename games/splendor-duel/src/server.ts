/**
 * 璀璨宝石：对决（Splendor Duel）—— 服务端规则。
 *
 * 规则来源：根目录 SCSPL2P01EN_Rules_Planche_BD.pdf。
 * 卡表来源：开源仓库 sone359/Splendor_Duel。
 *
 * 用户房规：对手预购的卡在预购当回合 + 对手整个回合可见，
 * 到预购者下一次回合开始时翻回背面（官方规则是对手始终看不到）。
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
  DECKS,
  ROYAL_BY_ID,
  ROYAL_CARDS,
  type GemColor,
  type JewelCard,
  type RoyalCard,
  type TokenColor,
} from './cards';

const GEM_COLORS: GemColor[] = ['white', 'blue', 'green', 'red', 'black'];
const TOKEN_COLORS: TokenColor[] = [...GEM_COLORS, 'pearl', 'gold'];
const COLOR_NAME: Record<TokenColor, string> = {
  white: '白',
  blue: '蓝',
  green: '绿',
  red: '红',
  black: '黑',
  pearl: '珍珠',
  gold: '金',
};

/** 版图中心开始、顺时针向外的 25 格顺序 */
const SPIRAL_COORDS: [number, number][] = [
  [2, 2], [2, 3], [3, 3], [3, 2], [3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [1, 4],
  [2, 4], [3, 4], [4, 4], [4, 3], [4, 2], [4, 1], [4, 0], [3, 0], [2, 0], [1, 0],
  [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
];
const SPIRAL = SPIRAL_COORDS.map(([row, col]) => row * 5 + col);

const DIRECTIONS: [number, number][] = [
  [0, 1], [1, 0], [1, 1], [1, -1], [0, -1], [-1, 0], [-1, -1], [-1, 1],
];

/** 所有合法拿 token 组合（1–3 个连续相邻格）的排序 key */
const LEGAL_GROUPS: string[] = (() => {
  const set = new Set<string>();
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      for (const [dr, dc] of DIRECTIONS) {
        const cells: number[] = [];
        for (let step = 0; step < 3; step += 1) {
          const nextRow = row + dr * step;
          const nextCol = col + dc * step;
          if (nextRow < 0 || nextRow > 4 || nextCol < 0 || nextCol > 4) break;
          cells.push(nextRow * 5 + nextCol);
          set.add([...cells].sort((a, b) => a - b).join(','));
        }
      }
    }
  }
  return [...set];
})();

function groupKey(cells: number[]): string {
  return [...cells].sort((a, b) => a - b).join(',');
}

function isLegalGroup(cells: number[]): boolean {
  if (cells.length < 1 || cells.length > 3) return false;
  if (new Set(cells).size !== cells.length) return false;
  return LEGAL_GROUPS.includes(groupKey(cells));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

function emptyTokens(): Record<TokenColor, number> {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 };
}

function zeroed<T>(players: PlayerId[], make: () => T): Record<PlayerId, T> {
  return Object.fromEntries(players.map((player) => [player, make()]));
}

interface OwnedCard {
  cardId: string;
  /** copyColor 卡购买时选择的颜色 */
  copyColor: GemColor | null;
}

interface ReservedCard {
  cardId: string;
  /** 到这个 turnSeq 开始就翻回背面 */
  publicUntilTurn: number;
}

export interface SplendorDuelState extends BaseState {
  decks: Record<'1' | '2' | '3', string[]>;
  pyramid: (string | null)[];
  board: (TokenColor | null)[];
  bag: TokenColor[];
  tokens: Record<PlayerId, Record<TokenColor, number>>;
  cards: Record<PlayerId, OwnedCard[]>;
  reserved: Record<PlayerId, ReservedCard[]>;
  privileges: Record<PlayerId, number>;
  privilegeSupply: number;
  royals: string[];
  royalsOwned: Record<PlayerId, string[]>;
  firstPlayer: PlayerId;
  /** 每开始一个回合 +1，用来判断预购卡的可见窗口 */
  turnSeq: number;
  mandatoryDone: boolean;
  privilegesUsed: boolean;
  replenished: boolean;
  extraTurn: boolean;
  /** 强制动作之后要依次处理的子阶段 */
  pending: ('steal' | 'royal')[];
}

function currentPlayer(state: SplendorDuelState): PlayerId {
  return state.players[state.turn]!;
}

function opponentOf(state: SplendorDuelState, player: PlayerId): PlayerId {
  return state.players.find((item) => item !== player) ?? state.players[0]!;
}

function tokenTotal(state: SplendorDuelState, player: PlayerId): number {
  const tokens = state.tokens[player]!;
  return TOKEN_COLORS.reduce((sum, color) => sum + (tokens[color] ?? 0), 0);
}

function ownedColor(owned: OwnedCard): GemColor | null {
  return owned.copyColor ?? CARD_BY_ID[owned.cardId]?.bonusColor ?? null;
}

function bonusCounts(state: SplendorDuelState, player: PlayerId): Record<GemColor, number> {
  const counts: Record<GemColor, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  for (const owned of state.cards[player] ?? []) {
    const card = CARD_BY_ID[owned.cardId];
    const color = ownedColor(owned);
    if (!card || !color || card.bonusCount <= 0) continue;
    counts[color] += card.bonusCount;
  }
  return counts;
}

function prestigeOf(state: SplendorDuelState, player: PlayerId): number {
  let total = 0;
  for (const owned of state.cards[player] ?? []) total += CARD_BY_ID[owned.cardId]?.prestige ?? 0;
  for (const royalId of state.royalsOwned[player] ?? []) total += ROYAL_BY_ID[royalId]?.prestige ?? 0;
  return total;
}

function crownsOf(state: SplendorDuelState, player: PlayerId): number {
  return (state.cards[player] ?? []).reduce(
    (sum, owned) => sum + (CARD_BY_ID[owned.cardId]?.crowns ?? 0),
    0,
  );
}

function sameColorMax(state: SplendorDuelState, player: PlayerId): number {
  const totals: Record<GemColor, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  for (const owned of state.cards[player] ?? []) {
    const card = CARD_BY_ID[owned.cardId];
    const color = ownedColor(owned);
    if (!card || !color) continue;
    totals[color] += card.prestige;
  }
  return Math.max(...GEM_COLORS.map((color) => totals[color]));
}

function ownBonusColors(state: SplendorDuelState, player: PlayerId): GemColor[] {
  const colors = new Set<GemColor>();
  for (const owned of state.cards[player] ?? []) {
    const card = CARD_BY_ID[owned.cardId];
    const color = ownedColor(owned);
    if (card && color && card.bonusCount > 0) colors.add(color);
  }
  return GEM_COLORS.filter((color) => colors.has(color));
}

function gainPrivilege(state: SplendorDuelState, player: PlayerId): void {
  if (state.privileges[player]! >= 3) return;
  if (state.privilegeSupply > 0) {
    state.privilegeSupply -= 1;
    state.privileges[player] = (state.privileges[player] ?? 0) + 1;
    return;
  }
  const opponent = opponentOf(state, player);
  if ((state.privileges[opponent] ?? 0) > 0) {
    state.privileges[opponent]! -= 1;
    state.privileges[player] = (state.privileges[player] ?? 0) + 1;
  }
}

function takeBoardToken(state: SplendorDuelState, cell: number): TokenColor | null {
  const token = state.board[cell] ?? null;
  if (token == null) return null;
  state.board[cell] = null;
  return token;
}

function addToPlayer(state: SplendorDuelState, player: PlayerId, token: TokenColor): void {
  state.tokens[player]![token] += 1;
}

function removeFromPlayer(state: SplendorDuelState, player: PlayerId, token: TokenColor): boolean {
  const tokens = state.tokens[player]!;
  if (tokens[token] <= 0) return false;
  tokens[token] -= 1;
  return true;
}

function totalCost(): Record<GemColor | 'pearl', number> {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0 };
}

function paymentFor(
  state: SplendorDuelState,
  player: PlayerId,
  cardId: string,
): Record<TokenColor, number> | null {
  const card = CARD_BY_ID[cardId];
  if (!card) return null;
  const bonuses = bonusCounts(state, player);
  const need = totalCost();
  for (const color of GEM_COLORS) {
    need[color] = Math.max(0, (card.cost[color] ?? 0) - bonuses[color]);
  }
  need.pearl = card.cost.pearl ?? 0;

  const available = state.tokens[player]!;
  const use = emptyTokens();
  let goldNeeded = 0;
  for (const color of [...GEM_COLORS, 'pearl'] as const) {
    const paid = Math.min(need[color], available[color] ?? 0);
    use[color] = paid;
    goldNeeded += need[color] - paid;
  }
  if ((available.gold ?? 0) < goldNeeded) return null;
  use.gold = goldNeeded;
  return use;
}

function canAfford(state: SplendorDuelState, player: PlayerId, cardId: string): boolean {
  return paymentFor(state, player, cardId) != null;
}

function payFor(state: SplendorDuelState, player: PlayerId, cardId: string): boolean {
  const use = paymentFor(state, player, cardId);
  if (!use) return false;
  for (const color of TOKEN_COLORS) {
    const count = use[color] ?? 0;
    for (let index = 0; index < count; index += 1) {
      if (!removeFromPlayer(state, player, color)) return false;
      state.bag.push(color);
    }
  }
  return true;
}

function locateCard(
  state: SplendorDuelState,
  player: PlayerId,
  cardId: string,
): { kind: 'pyramid'; index: number } | { kind: 'reserve' } | null {
  const index = state.pyramid.findIndex((item) => item === cardId);
  if (index >= 0) return { kind: 'pyramid', index };
  if ((state.reserved[player] ?? []).some((item) => item.cardId === cardId)) {
    return { kind: 'reserve' };
  }
  return null;
}

function replacePyramid(state: SplendorDuelState, index: number): void {
  const cardId = state.pyramid[index];
  if (!cardId) return;
  const level = CARD_BY_ID[cardId]?.level;
  if (!level) {
    state.pyramid[index] = null;
    return;
  }
  const deck = state.decks[String(level) as '1' | '2' | '3'];
  state.pyramid[index] = deck.length > 0 ? deck.pop()! : null;
}

function takeFromBoardToPlayer(
  state: SplendorDuelState,
  player: PlayerId,
  cell: number,
): TokenColor | null {
  const token = takeBoardToken(state, cell);
  if (token) addToPlayer(state, player, token);
  return token;
}

function opponentHasStealTarget(state: SplendorDuelState, player: PlayerId): boolean {
  const opponent = opponentOf(state, player);
  const tokens = state.tokens[opponent]!;
  return [...GEM_COLORS, 'pearl' as const].some((color) => tokens[color] > 0);
}

function applyCardAbilities(
  state: SplendorDuelState,
  player: PlayerId,
  card: JewelCard,
  copyColor: GemColor | null,
): void {
  for (const ability of card.abilities) {
    if (ability === 'replay') {
      state.extraTurn = true;
      continue;
    }
    if (ability === 'privilege') {
      gainPrivilege(state, player);
      continue;
    }
    if (ability === 'gem') {
      const color = copyColor ?? card.bonusColor;
      if (!color) continue;
      const cell = state.board.findIndex((token) => token === color);
      if (cell >= 0) takeFromBoardToPlayer(state, player, cell);
      continue;
    }
    if (ability === 'steal') {
      if (opponentHasStealTarget(state, player)) state.pending.push('steal');
    }
  }
}

function applyRoyalAbility(
  state: SplendorDuelState,
  player: PlayerId,
  royal: RoyalCard,
): void {
  if (royal.ability === 'steal') {
    if (opponentHasStealTarget(state, player)) state.pending.unshift('steal');
    return;
  }
  if (royal.ability === 'privilege') {
    gainPrivilege(state, player);
    return;
  }
  if (royal.ability === 'replay') state.extraTurn = true;
}

function canReplenish(state: SplendorDuelState): boolean {
  return state.bag.length > 0 && state.board.some((cell) => cell == null);
}

function canUsePrivilegesCell(state: SplendorDuelState, cell: number): boolean {
  const token = state.board[cell];
  return token != null && token !== 'gold';
}

function mandatoryMoves(state: SplendorDuelState, player: PlayerId): AnyAction[] {
  if (state.mandatoryDone) return [];
  const moves: AnyAction[] = [];

  for (const key of LEGAL_GROUPS) {
    const cells = key.split(',').map(Number);
    if (
      cells.every((cell) => {
        const token = state.board[cell];
        return token != null && token !== 'gold';
      })
    ) {
      moves.push({ type: 'takeTokens', payload: { cells } });
    }
  }

  const candidates: string[] = [];
  for (const cardId of state.pyramid) if (cardId) candidates.push(cardId);
  for (const reserved of state.reserved[player] ?? []) candidates.push(reserved.cardId);
  for (const cardId of candidates) {
    if (!canAfford(state, player, cardId)) continue;
    const card = CARD_BY_ID[cardId];
    if (!card) continue;
    if (card.abilities.includes('copyColor')) {
      const colors = ownBonusColors(state, player);
      for (const color of colors) {
        moves.push({ type: 'buy', payload: { cardId, copyColor: color } });
      }
    } else {
      moves.push({ type: 'buy', payload: { cardId } });
    }
  }

  if (state.board.includes('gold') && (state.reserved[player]?.length ?? 0) < 3) {
    state.pyramid.forEach((cardId, index) => {
      if (cardId) moves.push({ type: 'reserve', payload: { from: 'pyramid', cell: index } });
    });
    for (const level of ['1', '2', '3'] as const) {
      if (state.decks[level].length > 0) {
        moves.push({ type: 'reserve', payload: { from: 'deck', level } });
      }
    }
  }

  return moves;
}

function finishTurn(state: SplendorDuelState, ctx: ActionContext<SplendorDuelState>): void {
  const player = currentPlayer(state);
  const other = opponentOf(state, player);

  const won =
    prestigeOf(state, player) >= 20 ||
    crownsOf(state, player) >= 10 ||
    sameColorMax(state, player) >= 10;

  if (won) {
    state.finished = true;
    state.ranking = [[player], [other]];
    ctx.emit({
      type: 'log',
      key: 'sd.gameEnd',
      args: {
        winner: player,
        scores: { [player]: prestigeOf(state, player), [other]: prestigeOf(state, other) },
      },
    });
    ctx.emit({ type: 'achievement', player, key: 'first-win' });
    for (const id of state.players) {
      if (crownsOf(state, id) >= 6 || (state.royalsOwned[id]?.length ?? 0) >= 2) {
        ctx.emit({ type: 'achievement', player: id, key: 'royal-crown' });
      }
    }
    if (sameColorMax(state, player) >= 10) {
      ctx.emit({ type: 'achievement', player, key: 'color-master' });
    }
    ctx.goTo('finished');
    return;
  }

  const keepTurn = state.extraTurn;
  state.extraTurn = false;
  state.pending = [];
  state.mandatoryDone = false;
  state.privilegesUsed = false;
  state.replenished = false;
  state.turnSeq += 1;
  if (!keepTurn) state.turn = (state.turn + 1) % state.players.length;
  ctx.goTo('playing');
}

function resolveQueue(
  state: SplendorDuelState,
  ctx: ActionContext<SplendorDuelState>,
): void {
  const player = currentPlayer(state);

  // 队列里可能有已经不可执行的 steal/royal（例如对手突然没 token 了）
  while (state.pending[0] === 'steal' && !opponentHasStealTarget(state, player)) {
    state.pending.shift();
  }
  while (state.pending[0] === 'royal' && state.royals.length === 0) {
    state.pending.shift();
  }

  const next = state.pending[0];
  if (next === 'steal') {
    ctx.goTo('steal');
    return;
  }
  if (next === 'royal') {
    ctx.goTo('royal');
    return;
  }
  if (tokenTotal(state, player) > 10) {
    ctx.goTo('discard');
    return;
  }
  finishTurn(state, ctx);
}

function excessTokens(state: SplendorDuelState, player: PlayerId): TokenColor[] {
  let excess = tokenTotal(state, player) - 10;
  const colors: TokenColor[] = [];
  if (excess <= 0) return colors;
  for (const color of TOKEN_COLORS) {
    const count = state.tokens[player]![color];
    const take = Math.min(count, excess);
    for (let index = 0; index < take; index += 1) colors.push(color);
    excess -= take;
    if (excess <= 0) break;
  }
  return colors;
}

function afterMandatory(state: SplendorDuelState, ctx: ActionContext<SplendorDuelState>): void {
  resolveQueue(state, ctx);
}

const takeTokens: ActionDef<SplendorDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({ cells: z.array(z.number().int().min(0).max(24)).min(1).max(3) }),
  validate(state, action, ctx) {
    if (state.mandatoryDone) return { ok: false, reason: '这一回合已经行动过了' };
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const { cells } = action.payload as { cells: number[] };
    if (!isLegalGroup(cells)) return { ok: false, reason: '只能拿横/竖/斜连续相邻的 1–3 个宝石' };
    for (const cell of cells) {
      const token = state.board[cell];
      if (token == null) return { ok: false, reason: '空格子不能拿' };
      if (token === 'gold') return { ok: false, reason: '金只能通过“拿金 + 预留”获得' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { cells } = action.payload as { cells: number[] };
    state.mandatoryDone = true;
    const taken: TokenColor[] = [];
    for (const cell of cells) {
      const token = takeFromBoardToPlayer(state, ctx.playerId, cell);
      if (token) taken.push(token);
    }
    const sameThree =
      taken.length === 3 && taken.every((token) => token === taken[0]);
    const twoPearls = taken.length === 2 && taken.every((token) => token === 'pearl');
    if (sameThree || twoPearls) {
      gainPrivilege(state, opponentOf(state, ctx.playerId));
    }
    ctx.emit({
      type: 'log',
      key: 'sd.take',
      args: { player: ctx.playerId, tokens: taken },
    });
    afterMandatory(state, ctx);
  },
};

const usePrivileges: ActionDef<SplendorDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({ cells: z.array(z.number().int().min(0).max(24)).min(1).max(3) }),
  validate(state, action, ctx) {
    if (state.mandatoryDone) return { ok: false, reason: '强制行动之后不能再使用特权' };
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.privilegesUsed) return { ok: false, reason: '本回合已经用过特权了' };
    if (state.replenished) return { ok: false, reason: '使用特权必须在补版图之前' };
    const { cells } = action.payload as { cells: number[] };
    if (new Set(cells).size !== cells.length) return { ok: false, reason: '不能重复拿同一格' };
    if (cells.length > (state.privileges[ctx.playerId] ?? 0)) {
      return { ok: false, reason: '特权不够' };
    }
    if (!cells.every((cell) => canUsePrivilegesCell(state, cell))) {
      return { ok: false, reason: '特权只能拿版图上的非金宝石' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { cells } = action.payload as { cells: number[] };
    state.privilegesUsed = true;
    state.privileges[ctx.playerId]! -= cells.length;
    state.privilegeSupply += cells.length;
    for (const cell of cells) takeFromBoardToPlayer(state, ctx.playerId, cell);
    ctx.emit({
      type: 'log',
      key: 'sd.privilege',
      args: { player: ctx.playerId, count: cells.length },
    });
  },
};

const replenish: ActionDef<SplendorDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (state.mandatoryDone) return { ok: false, reason: '强制行动之后不能再补版图' };
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.replenished) return { ok: false, reason: '本回合已经补过版图了' };
    if (state.bag.length === 0) return { ok: false, reason: '袋子里没有宝石了' };
    if (!state.board.some((cell) => cell == null)) return { ok: false, reason: '版图已经满了' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    state.replenished = true;
    state.bag = shuffle(state.bag, ctx.rng);
    for (const cell of SPIRAL) {
      if (state.bag.length === 0) break;
      if (state.board[cell] != null) continue;
      state.board[cell] = state.bag.pop()!;
    }
    gainPrivilege(state, opponentOf(state, ctx.playerId));
    ctx.emit({ type: 'log', key: 'sd.replenish', args: { player: ctx.playerId } });
  },
};

const reserve: ActionDef<SplendorDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({
    from: z.enum(['pyramid', 'deck']),
    cell: z.number().int().min(0).max(11).optional(),
    level: z.enum(['1', '2', '3']).optional(),
  }),
  validate(state, action, ctx) {
    if (state.mandatoryDone) return { ok: false, reason: '这一回合已经行动过了' };
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (!state.board.includes('gold')) return { ok: false, reason: '版图上没有金了' };
    if ((state.reserved[ctx.playerId]?.length ?? 0) >= 3) {
      return { ok: false, reason: '最多只能预留 3 张卡' };
    }
    const payload = action.payload as { from: 'pyramid' | 'deck'; cell?: number; level?: '1' | '2' | '3' };
    if (payload.from === 'pyramid') {
      if (payload.cell == null || !state.pyramid[payload.cell]) {
        return { ok: false, reason: '这里没有可以预留的卡' };
      }
      return { ok: true };
    }
    if (!payload.level || state.decks[payload.level].length === 0) {
      return { ok: false, reason: '这个等级已经没有牌了' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as { from: 'pyramid' | 'deck'; cell?: number; level?: '1' | '2' | '3' };
    state.mandatoryDone = true;
    const goldCell = state.board.findIndex((token) => token === 'gold');
    if (goldCell >= 0) takeFromBoardToPlayer(state, ctx.playerId, goldCell);

    let cardId: string | null = null;
    if (payload.from === 'pyramid' && payload.cell != null) {
      cardId = state.pyramid[payload.cell] ?? null;
      if (cardId) replacePyramid(state, payload.cell);
    } else if (payload.level) {
      cardId = state.decks[payload.level].pop() ?? null;
    }
    if (cardId) {
      state.reserved[ctx.playerId]!.push({
        cardId,
        publicUntilTurn: state.turnSeq + 2,
      });
    }
    ctx.emit({ type: 'log', key: 'sd.reserve', args: { player: ctx.playerId } });
    afterMandatory(state, ctx);
  },
};

const buy: ActionDef<SplendorDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({
    cardId: z.string().min(1),
    copyColor: z.enum(['white', 'blue', 'green', 'red', 'black']).optional(),
  }),
  validate(state, action, ctx) {
    if (state.mandatoryDone) return { ok: false, reason: '这一回合已经行动过了' };
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const payload = action.payload as { cardId: string; copyColor?: GemColor };
    const card = CARD_BY_ID[payload.cardId];
    if (!card) return { ok: false, reason: '没有这张卡' };
    if (!locateCard(state, ctx.playerId, payload.cardId)) {
      return { ok: false, reason: '这张卡不在金字塔或你的预留区' };
    }
    if (card.abilities.includes('copyColor')) {
      const colors = ownBonusColors(state, ctx.playerId);
      if (colors.length === 0) return { ok: false, reason: '你还没有可以复制的奖励色' };
      if (!payload.copyColor || !colors.includes(payload.copyColor)) {
        return { ok: false, reason: '请选择一张已有的奖励色来复制' };
      }
    }
    if (!canAfford(state, ctx.playerId, payload.cardId)) {
      return { ok: false, reason: '宝石不够，买不起这张卡' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const payload = action.payload as { cardId: string; copyColor?: GemColor };
    const card = CARD_BY_ID[payload.cardId]!;
    const location = locateCard(state, ctx.playerId, payload.cardId);
    if (!location) return;
    state.mandatoryDone = true;

    const beforeCrowns = crownsOf(state, ctx.playerId);
    if (!payFor(state, ctx.playerId, payload.cardId)) return;

    if (location.kind === 'pyramid') {
      replacePyramid(state, location.index);
    } else {
      state.reserved[ctx.playerId] = state.reserved[ctx.playerId]!.filter(
        (item) => item.cardId !== payload.cardId,
      );
    }

    const copyColor = card.abilities.includes('copyColor') ? payload.copyColor ?? null : null;
    state.cards[ctx.playerId]!.push({ cardId: payload.cardId, copyColor });
    applyCardAbilities(state, ctx.playerId, card, copyColor);

    const afterCrowns = crownsOf(state, ctx.playerId);
    if (beforeCrowns < 3 && afterCrowns >= 3) state.pending.push('royal');
    if (beforeCrowns < 6 && afterCrowns >= 6) state.pending.push('royal');

    ctx.emit({
      type: 'log',
      key: 'sd.buy',
      args: { player: ctx.playerId, cardId: payload.cardId },
    });
    afterMandatory(state, ctx);
  },
};

const pass: ActionDef<SplendorDuelState> = {
  allowedIn: ['playing'],
  schema: z.object({}),
  validate(state, _action, ctx) {
    if (state.mandatoryDone) return { ok: false, reason: '这一回合已经行动过了' };
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (mandatoryMoves(state, ctx.playerId).length > 0) {
      return { ok: false, reason: '还有可以执行的动作，不能跳过' };
    }
    if (canReplenish(state)) return { ok: false, reason: '没有可执行动作时，必须先补版图' };
    return { ok: true };
  },
  reduce(state, _action, ctx) {
    state.mandatoryDone = true;
    ctx.emit({ type: 'log', key: 'sd.pass', args: { player: ctx.playerId } });
    afterMandatory(state, ctx);
  },
};

const takeRoyal: ActionDef<SplendorDuelState> = {
  allowedIn: ['royal'],
  schema: z.object({ royalId: z.string().min(1) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.pending[0] !== 'royal') return { ok: false, reason: '现在不需要拿 Royal' };
    const { royalId } = action.payload as { royalId: string };
    if (!state.royals.includes(royalId)) return { ok: false, reason: '这张 Royal 已经被拿走了' };
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { royalId } = action.payload as { royalId: string };
    const royal = ROYAL_BY_ID[royalId];
    if (!royal) return;
    state.royals = state.royals.filter((id) => id !== royalId);
    state.royalsOwned[ctx.playerId]!.push(royalId);
    state.pending.shift();
    applyRoyalAbility(state, ctx.playerId, royal);
    ctx.emit({
      type: 'log',
      key: 'sd.royal',
      args: { player: ctx.playerId, royalId },
    });
    resolveQueue(state, ctx);
  },
};

const steal: ActionDef<SplendorDuelState> = {
  allowedIn: ['steal'],
  schema: z.object({ color: z.enum(['white', 'blue', 'green', 'red', 'black', 'pearl']) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    if (state.pending[0] !== 'steal') return { ok: false, reason: '现在没有要偷的 token' };
    const { color } = action.payload as { color: Exclude<TokenColor, 'gold'> };
    const opponent = opponentOf(state, ctx.playerId);
    if ((state.tokens[opponent]?.[color] ?? 0) <= 0) {
      return { ok: false, reason: '对手没有这种 token' };
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { color } = action.payload as { color: Exclude<TokenColor, 'gold'> };
    const opponent = opponentOf(state, ctx.playerId);
    if (removeFromPlayer(state, opponent, color)) addToPlayer(state, ctx.playerId, color);
    state.pending.shift();
    ctx.emit({
      type: 'log',
      key: 'sd.steal',
      args: { player: ctx.playerId, from: opponent, color },
    });
    resolveQueue(state, ctx);
  },
};

const discardTokens: ActionDef<SplendorDuelState> = {
  allowedIn: ['discard'],
  schema: z.object({ colors: z.array(z.enum(['white', 'blue', 'green', 'red', 'black', 'pearl', 'gold'])).min(1).max(20) }),
  validate(state, action, ctx) {
    if (currentPlayer(state) !== ctx.playerId) return { ok: false, reason: '还没轮到你' };
    const { colors } = action.payload as { colors: TokenColor[] };
    const excess = tokenTotal(state, ctx.playerId) - 10;
    if (excess <= 0) return { ok: false, reason: '你的 token 没有超过 10 个' };
    if (colors.length !== excess) {
      return { ok: false, reason: `需要弃掉 ${excess} 个 token` };
    }
    const counts = emptyTokens();
    for (const color of colors) counts[color] += 1;
    for (const color of TOKEN_COLORS) {
      if (counts[color] > (state.tokens[ctx.playerId]?.[color] ?? 0)) {
        return { ok: false, reason: '你手里没有这么多这种 token' };
      }
    }
    return { ok: true };
  },
  reduce(state, action, ctx) {
    const { colors } = action.payload as { colors: TokenColor[] };
    for (const color of colors) {
      if (removeFromPlayer(state, ctx.playerId, color)) state.bag.push(color);
    }
    ctx.emit({
      type: 'log',
      key: 'sd.discard',
      args: { player: ctx.playerId, colors },
    });
    resolveQueue(state, ctx);
  },
};

const states: Record<string, StateDef<SplendorDuelState>> = {
  playing: {
    type: 'activePlayer',
    onEnter(state) {
      state.mandatoryDone = false;
      state.privilegesUsed = false;
      state.replenished = false;
      state.pending = [];
    },
    onTimeout(state, ctx) {
      const player = currentPlayer(state);
      const moves = mandatoryMoves(state, player);
      if (moves.length > 0) return moves[0]!;
      if (canReplenish(state)) return { type: 'replenish', payload: {} };
      return { type: 'pass', payload: {} };
    },
  },
  royal: {
    type: 'activePlayer',
    onTimeout(state) {
      const royalId = state.royals[0];
      return royalId ? { type: 'takeRoyal', payload: { royalId } } : null;
    },
  },
  steal: {
    type: 'activePlayer',
    onTimeout(state) {
      const player = currentPlayer(state);
      const opponent = opponentOf(state, player);
      const color = ([...GEM_COLORS, 'pearl'] as const).find(
        (item) => (state.tokens[opponent]?.[item] ?? 0) > 0,
      );
      return color ? { type: 'steal', payload: { color } } : null;
    },
  },
  discard: {
    type: 'activePlayer',
    onTimeout(state) {
      const player = currentPlayer(state);
      const colors = excessTokens(state, player);
      return colors.length > 0 ? { type: 'discardTokens', payload: { colors } } : null;
    },
  },
  finished: { type: 'global' },
};

function playerView(state: SplendorDuelState, player: PlayerId, viewer: PlayerId | null) {
  const isOwner = viewer === player;
  const reserved = (state.reserved[player] ?? []).map((item) => {
    const isPublic = item.publicUntilTurn > state.turnSeq;
    return {
      cardId: isOwner || isPublic ? item.cardId : null,
      public: isPublic,
    };
  });
  return {
    id: player,
    tokens: state.tokens[player],
    privileges: state.privileges[player] ?? 0,
    cards: state.cards[player] ?? [],
    reserved,
    reservedCount: reserved.length,
    royals: state.royalsOwned[player] ?? [],
    score: prestigeOf(state, player),
    crowns: crownsOf(state, player),
    sameColorMax: sameColorMax(state, player),
  };
}

const splendorDuel: GamePlugin<SplendorDuelState> = {
  manifest: {
    id: 'splendor-duel',
    name: '璀璨宝石：对决',
    version: '0.1.0',
    apiVersion: '^1.0.0',
    players: { min: 2, max: 2 },
    modes: ['realtime', 'turnbased'],
    tags: ['卡牌', '策略', '双人'],
    estimatedMinutes: 30,
    realtime: { fast: 45, normal: 90, slow: 180 },
    description:
      '两个人抢宝石、买珠宝、争皇冠；先到 20 分、10 皇冠或同色 10 分就赢。',
    intro:
      '双人版璀璨宝石，30 分钟一局。\n\n## 每回合\n\n先做可选动作（用特权、补版图），然后三选一：拿至多 3 个相邻宝石、拿 1 个金并预留 1 张卡、或买 1 张卡。\n\n## 胜利\n\n- 20 分\n- 10 个皇冠\n- 同一种颜色的卡凑到 10 分\n\n第 3、6 个皇冠会拿一张 Royal 卡，Royal 会立刻给奖励。',
    achievements: [
      { id: 'first-win', name: '首胜', description: '在璀璨宝石：对决里赢下第一局', icon: '💎', color: '#3f4a7a' },
      { id: 'royal-crown', name: '皇冠收藏家', description: '一局拿到 6 个皇冠或两张 Royal 卡', icon: '👑', color: '#6b5320' },
      { id: 'color-master', name: '一色到底', description: '靠同色 10 分获胜', icon: '🎨', color: '#4a2f5a' },
    ],
  },

  createState({ players, seed }: SetupContext): SplendorDuelState {
    const rng = mulberry32(seed);
    const decks: Record<'1' | '2' | '3', string[]> = {
      '1': shuffle(DECKS['1'], rng),
      '2': shuffle(DECKS['2'], rng),
      '3': shuffle(DECKS['3'], rng),
    };

    const pyramid: (string | null)[] = [];
    for (let index = 0; index < 3; index += 1) pyramid.push(decks['3'].pop() ?? null);
    for (let index = 0; index < 4; index += 1) pyramid.push(decks['2'].pop() ?? null);
    for (let index = 0; index < 5; index += 1) pyramid.push(decks['1'].pop() ?? null);

    const tokens: TokenColor[] = [];
    for (const color of GEM_COLORS) for (let index = 0; index < 4; index += 1) tokens.push(color);
    tokens.push('pearl', 'pearl');
    tokens.push('gold', 'gold', 'gold');
    const shuffled = shuffle(tokens, rng);
    const board: (TokenColor | null)[] = Array.from({ length: 25 }, () => null);
    SPIRAL.forEach((cell, index) => {
      board[cell] = shuffled[index] ?? null;
    });

    const firstIndex = rng() < 0.5 ? 0 : 1;
    const firstPlayer = players[firstIndex]!;
    const other = players[1 - firstIndex]!;
    const privileges = zeroed(players, () => 0);
    privileges[other] = 1;

    return {
      players: [...players],
      turn: firstIndex,
      round: 1,
      phase: 'playing',
      finished: false,
      ranking: null,
      rngSeed: seed >>> 0,
      decks,
      pyramid,
      board,
      bag: [],
      tokens: zeroed(players, emptyTokens),
      cards: zeroed(players, () => []),
      reserved: zeroed(players, () => []),
      privileges,
      privilegeSupply: 2,
      royals: ROYAL_CARDS.map((card) => card.id),
      royalsOwned: zeroed(players, () => []),
      firstPlayer,
      turnSeq: 0,
      mandatoryDone: false,
      privilegesUsed: false,
      replenished: false,
      extraTurn: false,
      pending: [],
    };
  },

  states,
  actions: { takeTokens, usePrivileges, replenish, reserve, buy, pass, takeRoyal, steal, discardTokens },

  view(state, viewer): PublicView {
    const me = viewer === 'spectator' ? null : viewer;
    return {
      phase: state.phase,
      players: state.players,
      turn: state.finished ? null : currentPlayer(state),
      round: 1,
      finished: state.finished,
      ranking: state.ranking,
      data: {
        board: state.board,
        bagCount: state.bag.length,
        deckCounts: {
          '1': state.decks['1'].length,
          '2': state.decks['2'].length,
          '3': state.decks['3'].length,
        },
        pyramid: state.pyramid,
        privilegeSupply: state.privilegeSupply,
        royals: state.royals,
        firstPlayer: state.firstPlayer,
        turnSeq: state.turnSeq,
        pending: state.pending,
        optional: {
          mandatoryDone: state.mandatoryDone,
          privilegesUsed: state.privilegesUsed,
          replenished: state.replenished,
          extraTurn: state.extraTurn,
        },
        players: state.players.map((player) => playerView(state, player, me)),
        you: me,
        colorNames: COLOR_NAME,
      },
    };
  },

  legalMoves(state, playerId) {
    if (state.finished) return [];
    if (state.phase === 'playing') {
      if (currentPlayer(state) !== playerId) return [];
      const moves = mandatoryMoves(state, playerId);
      if (moves.length === 0) {
        if (canReplenish(state)) moves.push({ type: 'replenish', payload: {} });
        else moves.push({ type: 'pass', payload: {} });
      }
      return moves;
    }
    if (state.phase === 'royal') {
      if (currentPlayer(state) !== playerId) return [];
      return state.royals.map((royalId) => ({ type: 'takeRoyal', payload: { royalId } }));
    }
    if (state.phase === 'steal') {
      if (currentPlayer(state) !== playerId) return [];
      const opponent = opponentOf(state, playerId);
      return ([...GEM_COLORS, 'pearl'] as const)
        .filter((color) => (state.tokens[opponent]?.[color] ?? 0) > 0)
        .map((color) => ({ type: 'steal', payload: { color } }));
    }
    if (state.phase === 'discard') {
      if (currentPlayer(state) !== playerId) return [];
      const colors = excessTokens(state, playerId);
      return colors.length > 0 ? [{ type: 'discardTokens', payload: { colors } }] : [];
    }
    return [];
  },
};

export default splendorDuel;
export { splendorDuel };
