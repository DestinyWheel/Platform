/**
 * 璀璨宝石：对决 —— 前端。
 *
 * 原生 DOM + 内联 CSS，不依赖任何图片/字体。
 * 只从 snapshot.view.data 读裁剪后的信息；对手隐藏的预留卡在这里只看到牌背。
 */
import type { ClientSnapshot, GameClient, GameClientContext, LogEntry } from '@platform/sdk';
import { CARD_BY_ID, ROYAL_BY_ID, type GemColor, type TokenColor } from './cards';

const STYLE_ID = 'splendor-duel-style';

const TOKEN_NAME: Record<TokenColor, string> = {
  white: '白',
  blue: '蓝',
  green: '绿',
  red: '红',
  black: '黑',
  pearl: '珍珠',
  gold: '金',
};
const GEM_COLORS: GemColor[] = ['white', 'blue', 'green', 'red', 'black'];
const TOKEN_COLORS: TokenColor[] = [...GEM_COLORS, 'pearl', 'gold'];
const TOKEN_HEX: Record<TokenColor, string> = {
  white: '#e8edf5',
  blue: '#3a7bd5',
  green: '#2f9e62',
  red: '#d64545',
  black: '#4b5563',
  pearl: '#e7cfa6',
  gold: '#e3b341',
};
/** 圆点上的文字：深色/饱和底用柔和象牙白，浅色底用柔和深墨，不用纯黑纯白 */
const TOKEN_TEXT: Record<TokenColor, string> = {
  white: '#303740',
  blue: '#f1f6ff',
  green: '#233229',
  red: '#fff4ed',
  black: '#f3f4f6',
  pearl: '#3a3025',
  gold: '#3a2c10',
};
const ABILITY_ICON: Record<string, string> = {
  replay: '⟳',
  privilege: '📜',
  gem: '💠',
  steal: '✋',
  copyColor: '🎨',
};
const ABILITY_LABEL: Record<string, string> = {
  replay: '再来一回合',
  privilege: '拿特权',
  gem: '拿同色宝石',
  steal: '偷对手宝石',
  copyColor: '复制奖励色',
};
const ABILITY_HINT: Record<string, string> = {
  replay: '本回合结束后立刻再进行一个回合',
  privilege: '从特权池拿 1 张；没有就从对手拿',
  gem: '从版图拿 1 个与卡牌颜色相同的宝石',
  steal: '从对手手里拿 1 个非金宝石',
  copyColor: '叠在已有奖励色的卡上，复制那个颜色',
};
const ROYAL_ICON: Record<string, string> = {
  steal: '✋',
  privilege: '📜',
  replay: '⟳',
  none: '★',
};

const CSS = `
.sd-root { position: relative; display: flex; flex-direction: column; gap: 12px; color: #e6edf3; }
.sd-topbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 14px; border: 1px solid #262d38; border-radius: 12px; background: rgba(22,27,34,.72); }
.sd-turn { font-weight: 700; }
.sd-muted { color: #8b98a7; font-size: 12px; }
.sd-badge { border: 1px solid #2c3745; border-radius: 999px; padding: 2px 8px; font-size: 11px; color: #c3ccd8; }
.sd-panel { border: 1px solid #262d38; border-radius: 12px; background: rgba(20,25,32,.8); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.sd-panel.me { border-color: #4c8dff; box-shadow: 0 0 0 1px rgba(76,141,255,.28); }
.sd-panel-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sd-score { font-size: 18px; font-weight: 750; }
.sd-crowns { color: #f2c94c; font-size: 13px; }
.sd-tokens { display: flex; gap: 6px; flex-wrap: wrap; }
.sd-token-count { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #c3ccd8; }
.sd-dot { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 800; color: #303740; line-height: 1; padding: 0; font-variant-numeric: tabular-nums; border: 1px solid rgba(255,255,255,.18); }
.sd-cards { display: flex; gap: 6px; flex-wrap: wrap; max-height: 190px; overflow-y: auto; padding-bottom: 2px; }
.sd-royals { display: flex; gap: 6px; flex-wrap: wrap; }
.sd-reserved { display: flex; gap: 6px; flex-wrap: wrap; }
.sd-center { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(240px, .7fr); gap: 12px; }
@media (max-width: 860px) { .sd-center { grid-template-columns: 1fr; } }
.sd-pyramid { display: flex; flex-direction: column; gap: 8px; }
.sd-row { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.sd-row-label { width: 32px; color: #8b98a7; font-size: 12px; }
.sd-board { display: grid; grid-template-columns: repeat(5, 38px); gap: 6px; justify-content: center; padding: 10px; border: 1px solid #262d38; border-radius: 14px; background: radial-gradient(circle at 50% 40%, rgba(58,123,213,.12), rgba(16,20,26,.85)); }
.sd-cell { width: 38px; height: 38px; border-radius: 50%; border: 1px dashed #2c3745; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.sd-cell.empty { cursor: default; }
.sd-cell.picked { outline: 2px solid #4c8dff; outline-offset: 2px; }
.sd-cell.gold { border-style: solid; }
.sd-token { width: 32px; height: 32px; border-radius: 50%; border: 1px solid rgba(0,0,0,.35); box-shadow: inset 0 1px 2px rgba(255,255,255,.35); }
.sd-token.white { background: #e8edf5; box-shadow: inset 0 1px 2px rgba(255,255,255,.55), 0 0 0 1px rgba(120,140,170,.4); }
.sd-token.blue { background: #3a7bd5; }
.sd-token.green { background: #2f9e62; }
.sd-token.red { background: #d64545; }
.sd-token.black { background: #4b5563; }
/* 珍珠改成暖香槟色 + 星形标记，和冷白色区分开 */
.sd-token.pearl {
  background: radial-gradient(circle at 32% 28%, #fffdf5, #e7cfa6 48%, #b99a63);
  box-shadow: inset 0 1px 2px rgba(255,255,255,.5), 0 0 0 1px rgba(185,154,99,.75);
  position: relative;
}
.sd-token.pearl::after {
  content: '✦';
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: rgba(105,77,34,.55);
}
.sd-token.gold { background: radial-gradient(circle at 35% 30%, #fff2b8, #e3b341 55%, #9b741c); }
.sd-side { display: flex; flex-direction: column; gap: 10px; }
.sd-box { border: 1px solid #262d38; border-radius: 12px; background: rgba(22,27,34,.7); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.sd-box-title { font-size: 12px; color: #8b98a7; }
.sd-card { box-sizing: border-box; width: 72px; height: 100px; border-radius: 9px; border: 2px solid #3a4656; background: linear-gradient(160deg, #202836, #161b22); display: flex; flex-direction: column; align-items: stretch; padding: 4px; gap: 3px; cursor: pointer; position: relative; flex: none; }
.sd-card.compact { width: 42px; height: 58px; padding: 3px; border-width: 1px; }
.sd-card.large { width: 150px; height: 210px; padding: 8px; gap: 5px; border-width: 3px; border-radius: 12px; }
.sd-card.lvl1 { border-color: #5f8f5a; }
.sd-card.lvl2 { border-color: #b28a3a; }
.sd-card.lvl3 { border-color: #7a6ac0; }
.sd-card.selected { outline: 2px solid #4c8dff; outline-offset: 1px; }
.sd-card.back { background: repeating-linear-gradient(135deg, #1b2230, #1b2230 5px, #232c3c 5px, #232c3c 10px); border-color: #3a4656; cursor: default; }
.sd-card.large { width: 110px; height: 156px; padding: 6px; }
.sd-card-top { display: flex; justify-content: space-between; align-items: flex-start; min-height: 14px; flex: 0 0 auto; }
.sd-pts { font-weight: 800; font-size: 15px; color: #f5f7fa; }
.sd-card.compact .sd-pts { font-size: 11px; }
.sd-crown { color: #f2c94c; font-size: 11px; }
.sd-bonus { width: 16px; height: 16px; border-radius: 50%; align-self: center; border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto; }
.sd-card.compact .sd-bonus { width: 9px; height: 9px; }
.sd-card.compact .sd-card-top { min-height: 10px; }
.sd-abilities { display: flex; gap: 2px; justify-content: center; font-size: 11px; min-height: 14px; flex: 0 0 auto; }
.sd-card.compact .sd-abilities { font-size: 9px; min-height: 9px; }
.sd-cost { display: flex; gap: 1px; flex-wrap: nowrap; justify-content: center; margin-top: auto; flex: 0 0 auto; min-height: 14px; }
.sd-cost-pip { box-sizing: border-box; width: 14px; height: 14px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 800; color: #303740; line-height: 1; padding: 0; font-variant-numeric: tabular-nums; border: 1px solid rgba(255,255,255,.32); box-shadow: inset 0 0 0 1px rgba(0,0,0,.18); flex: 0 0 auto; }
.sd-cost-pip.pearl { border-color: #b89355; box-shadow: inset 0 0 0 1px rgba(110,80,35,.35); }
.sd-card.compact .sd-cost { min-height: 8px; }
.sd-card.compact .sd-cost-pip { width: 7px; height: 7px; font-size: 6px; border-width: 0; }
.sd-card.large .sd-card-top { min-height: 28px; }
.sd-card.large .sd-pts { font-size: 26px; }
.sd-card.large .sd-crown { font-size: 18px; }
.sd-card.large .sd-bonus { width: 30px; height: 30px; }
.sd-card.large .sd-abilities { font-size: 20px; min-height: 24px; gap: 4px; }
.sd-card.large .sd-cost { min-height: 26px; gap: 2px; }
.sd-card.large .sd-cost-pip { width: 26px; height: 26px; font-size: 15px; border-width: 2px; }
.sd-royal { width: 58px; height: 76px; border-radius: 8px; border: 2px solid #d9a521; background: linear-gradient(160deg, #4a3a18, #241c0b); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; cursor: pointer; flex: none; }
.sd-royal .pts { font-size: 17px; font-weight: 800; color: #f7e6a8; }
.sd-royal .icon { font-size: 18px; }
.sd-royal.compact { width: 42px; height: 56px; }
.sd-royal.compact .pts { font-size: 12px; }
.sd-royal.compact .icon { font-size: 14px; }
.sd-detail { display: flex; gap: 10px; align-items: center; border: 1px solid #2c3745; border-radius: 12px; background: rgba(22,27,34,.9); padding: 10px; flex-wrap: wrap; }
.sd-detail-info { display: flex; flex-direction: column; gap: 6px; min-width: 140px; }
.sd-btn { padding: 7px 12px; border-radius: 9px; border: 1px solid #2c3745; background: #1a212b; color: #e6edf3; cursor: pointer; font-size: 13px; }
.sd-btn:hover { border-color: #4c8dff; }
.sd-btn.primary { background: linear-gradient(180deg, #4c8dff, #3a72d8); border-color: transparent; font-weight: 650; }
.sd-btn:disabled { opacity: .4; cursor: default; }
.sd-hint { border: 1px dashed #2c3745; border-radius: 10px; padding: 7px 9px; color: #aab6c4; font-size: 12px; }
.sd-modal { position: absolute; inset: 0; background: rgba(6,9,13,.76); display: flex; align-items: center; justify-content: center; z-index: 8; padding: 16px; }
.sd-modal-card { width: min(520px, 100%); border: 1px solid #3a4656; border-radius: 16px; background: #121821; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.sd-modal h3 { margin: 0; font-size: 16px; }
.sd-modal-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sd-selected { display: flex; gap: 4px; flex-wrap: wrap; }
.sd-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #2c3745; border-radius: 999px; padding: 3px 8px; font-size: 12px; }
.sd-wait { color: #8b98a7; font-size: 13px; }
.sd-legend { display: flex; flex-direction: column; gap: 6px; }
.sd-legend-item { display: flex; gap: 8px; align-items: flex-start; color: #aab6c4; font-size: 12px; line-height: 1.35; }
.sd-legend-icon { width: 20px; flex: none; text-align: center; color: #e6edf3; font-size: 14px; }
.sd-legend-item b { color: #e6edf3; font-weight: 650; }
`;

interface OwnedView {
  cardId: string;
  copyColor: GemColor | null;
}
interface ReservedView {
  cardId: string | null;
  public: boolean;
}
interface PlayerView {
  id: string;
  tokens: Record<TokenColor, number>;
  privileges: number;
  cards: OwnedView[];
  reserved: ReservedView[];
  reservedCount: number;
  royals: string[];
  score: number;
  crowns: number;
  sameColorMax: number;
}
interface SdData {
  board: (TokenColor | null)[];
  bagCount: number;
  deckCounts: Record<'1' | '2' | '3', number>;
  pyramid: (string | null)[];
  privilegeSupply: number;
  royals: string[];
  firstPlayer: string;
  turnSeq: number;
  pending: ('steal' | 'royal')[];
  optional: {
    mandatoryDone: boolean;
    privilegesUsed: boolean;
    replenished: boolean;
    extraTurn: boolean;
  };
  players: PlayerView[];
  you: string | null;
  colorNames: Record<TokenColor, string>;
}

let root: HTMLElement | null = null;
let context: GameClientContext | null = null;
let snapshot: ClientSnapshot | null = null;
let selectedCells: number[] = [];
let privilegeMode = false;
let selectedCard: string | null = null;
let discardSel: TokenColor[] = [];
let lastPhase = '';
let lastTurn = '';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function nameOf(id: string): string {
  return context?.players.find((player) => player.id === id)?.name ?? id.slice(0, 6);
}

function viewData(): SdData | null {
  return (snapshot?.view?.data as unknown as SdData | undefined) ?? null;
}

function meId(): string | null {
  const data = viewData();
  if (!data || !snapshot?.view) return null;
  return snapshot.view.players.includes(context?.me ?? '') ? context!.me : null;
}

function isMyTurn(): boolean {
  const view = snapshot?.view;
  const me = meId();
  return !!view && !!me && view.turn === me && !view.finished;
}

function playerOf(id: string): PlayerView | null {
  return viewData()?.players.find((player) => player.id === id) ?? null;
}

function tokenDot(token: TokenColor, size = 18): string {
  return `<span class="sd-dot" style="width:${size}px;height:${size}px;background:${TOKEN_HEX[token]};color:${TOKEN_TEXT[token]}">${TOKEN_NAME[token]}</span>`;
}

function tokenChip(token: TokenColor): string {
  return `<span class="sd-dot" style="background:${TOKEN_HEX[token]};color:${TOKEN_TEXT[token]}">${TOKEN_NAME[token]}</span>`;
}

function costPips(cardId: string, compact: boolean): string {
  const card = CARD_BY_ID[cardId];
  if (!card) return '';
  const parts: string[] = [];
  for (const color of GEM_COLORS) {
    if (!card.cost[color]) continue;
    parts.push(
      `<span class="sd-cost-pip ${color}" style="background:${TOKEN_HEX[color]};color:${TOKEN_TEXT[color]}">${card.cost[color]}</span>`,
    );
  }
  if (card.cost.pearl) {
    parts.push(
      `<span class="sd-cost-pip pearl" style="background:${TOKEN_HEX.pearl};color:${TOKEN_TEXT.pearl}">${card.cost.pearl}</span>`,
    );
  }
  return parts.join('');
}

function cardHtml(
  cardId: string,
  options: {
    compact?: boolean;
    large?: boolean;
    selected?: boolean;
    copyColor?: GemColor | null;
    hideCost?: boolean;
  } = {},
): string {
  const card = CARD_BY_ID[cardId];
  if (!card) return '';
  const copyColor = options.copyColor ?? null;
  const bonus = copyColor ?? card.bonusColor;
  const bonusCss = bonus
    ? TOKEN_HEX[bonus]
    : 'conic-gradient(#e8edf5,#3a7bd5,#2f9e62,#f2c94c,#d64545,#e8edf5)';
  const crowns = card.crowns > 0 ? '👑'.repeat(card.crowns) : '';
  const abilities = card.abilities
    .map(
      (ability) =>
        `<span title="${ABILITY_LABEL[ability] ?? ability}">${ABILITY_ICON[ability] ?? ''}</span>`,
    )
    .join('');
  const classes = [
    'sd-card',
    `lvl${card.level}`,
    options.compact ? 'compact' : '',
    options.large ? 'large' : '',
    options.selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="${classes}" data-card="${cardId}" title="等级 ${card.level} · ${card.prestige} 分${
    card.crowns ? ` · ${card.crowns} 皇冠` : ''
  }">
    <div class="sd-card-top">
      <span class="sd-pts">${card.prestige || 0}</span>
      <span class="sd-crown">${crowns}</span>
    </div>
    <div class="sd-bonus" style="background:${bonusCss}"></div>
    <div class="sd-abilities">${abilities}</div>
    ${options.hideCost ? '' : `<div class="sd-cost">${costPips(cardId, !!options.compact)}</div>`}
  </div>`;
}

function royalHtml(royalId: string, compact = false): string {
  const royal = ROYAL_BY_ID[royalId];
  if (!royal) return '';
  return `<div class="sd-royal${compact ? ' compact' : ''}" data-royal="${royalId}" title="Royal：${
    royal.prestige
  } 分 · ${ROYAL_ICON[royal.ability] ?? ''}">
    <span class="pts">${royal.prestige}</span><span class="icon">${ROYAL_ICON[royal.ability] ?? '★'}</span>
  </div>`;
}

function cardBack(compact = false): string {
  return `<div class="sd-card back${compact ? ' compact' : ''}"></div>`;
}

function renderPanel(player: PlayerView, isMe: boolean): string {
  const tokens = TOKEN_COLORS.filter((color) => (player.tokens?.[color] ?? 0) > 0)
    .map(
      (color) =>
        `<span class="sd-token-count">${tokenDot(color)}${player.tokens[color]}</span>`,
    )
    .join('');
  // 已购卡不再需要看价格；把空间留给声望/皇冠/奖励色
  const cards = player.cards.map((owned) =>
    cardHtml(owned.cardId, { compact: true, hideCost: true, copyColor: owned.copyColor }),
  ).join('');
  // 预留卡还用得上价格，保持正常尺寸
  const reserved = player.reserved
    .map((item) => (item.cardId ? cardHtml(item.cardId) : cardBack()))
    .join('');
  const royals = player.royals.map((royalId) => royalHtml(royalId, true)).join('');
  const publicReserve = !isMe
    ? player.reserved.filter((item) => item.public && item.cardId).length
    : 0;
  return `<div class="sd-panel${isMe ? ' me' : ''}">
    <div class="sd-panel-head">
      <span class="sd-score">${nameOf(player.id)}${isMe ? '（你）' : ''}</span>
      <span class="sd-score">${player.score} 分</span>
      <span class="sd-crowns">👑 ${player.crowns}</span>
      <span class="sd-badge">特权 ${player.privileges}</span>
      ${player.sameColorMax >= 10 ? '<span class="sd-badge">同色 ' + player.sameColorMax + '</span>' : ''}
    </div>
    <div class="sd-tokens">${tokens || '<span class="sd-muted">还没有宝石</span>'}</div>
    <div class="sd-cards">${cards || '<span class="sd-muted">还没有珠宝卡</span>'}</div>
    <div class="sd-reserved">
      ${royals}
      ${reserved}
      ${player.reserved.length === 0 ? '' : `<span class="sd-muted">预留 ${player.reservedCount}${
        publicReserve ? ` · 其中 ${publicReserve} 张刚预购可见` : ''
      }</span>`}
    </div>
  </div>`;
}

function legalTake(cells: number[]): boolean {
  if (cells.length === 0) return false;
  return (snapshot?.legalMoves ?? []).some((move) => {
    if (move.type !== 'takeTokens') return false;
    const payload = move.payload as { cells?: number[] } | undefined;
    if (!payload?.cells || payload.cells.length !== cells.length) return false;
    const left = [...payload.cells].sort((a, b) => a - b).join(',');
    const right = [...cells].sort((a, b) => a - b).join(',');
    return left === right;
  });
}

function legalBuys(cardId: string): (GemColor | null)[] {
  const found: (GemColor | null)[] = [];
  for (const move of snapshot?.legalMoves ?? []) {
    if (move.type !== 'buy') continue;
    const payload = move.payload as { cardId?: string; copyColor?: GemColor } | undefined;
    if (payload?.cardId !== cardId) continue;
    found.push(payload.copyColor ?? null);
  }
  return found;
}

function legalReserveCell(cardId: string): number | null {
  const data = viewData();
  if (!data) return null;
  const cell = data.pyramid.findIndex((item) => item === cardId);
  if (cell < 0) return null;
  const exists = (snapshot?.legalMoves ?? []).some((move) => {
    if (move.type !== 'reserve') return false;
    const payload = move.payload as { from?: string; cell?: number } | undefined;
    return payload?.from === 'pyramid' && payload.cell === cell;
  });
  return exists ? cell : null;
}

function renderDetail(data: SdData): string {
  if (!selectedCard) return '';
  const card = CARD_BY_ID[selectedCard];
  if (!card) return '';
  const buys = legalBuys(selectedCard);
  const buyButtons = buys.length
    ? buys
        .map(
          (color) =>
            `<button class="sd-btn primary" data-act="buy" data-copy="${color ?? ''}">${
              color ? `买下（复制${TOKEN_NAME[color]}）` : '买下'
            }</button>`,
        )
        .join('')
    : `<button class="sd-btn" disabled>${isMyTurn() ? '宝石不够，暂时买不起' : '不是你的回合'}</button>`;
  const reserveCell = legalReserveCell(selectedCard);
  const canReserve = reserveCell != null && data.board.includes('gold');
  const isReservedMine = (playerOf(meId() ?? '')?.reserved ?? []).some(
    (item) => item.cardId === selectedCard,
  );
  return `<div class="sd-detail">
    ${cardHtml(selectedCard, { large: true })}
    <div class="sd-detail-info">
      <strong>${card.level} 级 · ${card.prestige} 分${card.crowns ? ` · ${card.crowns} 皇冠` : ''}</strong>
      <span class="sd-muted">奖励：${card.bonusColor ? TOKEN_NAME[card.bonusColor] : '复制'} ×${card.bonusCount}${
        card.abilities.length
          ? ` · ${card.abilities.map((ability) => ABILITY_LABEL[ability] ?? ability).join(' / ')}`
          : ''
      }</span>
      <div class="sd-modal-row">${buyButtons}</div>
      ${
        canReserve && !isReservedMine
          ? `<button class="sd-btn" data-act="reserve" data-cell="${reserveCell}">拿 1 金并预留</button>`
          : ''
      }
      <button class="sd-btn" data-act="cancel">取消选择</button>
    </div>
  </div>`;
}

function renderLegend(): string {
  const symbols = [
    { icon: '2', label: '声望分', hint: '卡牌左上角的数字' },
    { icon: '👑', label: '皇冠', hint: '第 3、6 个皇冠各拿一张 Royal' },
    { icon: '●', label: '奖励色', hint: '以后买卡少付 1 个该色宝石' },
    ...Object.keys(ABILITY_LABEL).map((key) => ({
      icon: ABILITY_ICON[key] ?? '',
      label: ABILITY_LABEL[key]!,
      hint: ABILITY_HINT[key]!,
    })),
  ];
  return `<div class="sd-box">
    <div class="sd-box-title">卡牌图案说明</div>
    <div class="sd-legend">${symbols
      .map(
        (item) =>
          `<div class="sd-legend-item"><span class="sd-legend-icon">${item.icon}</span><span><b>${item.label}</b> · ${item.hint}</span></div>`,
      )
      .join('')}</div>
  </div>`;
}

function renderBoard(data: SdData): string {
  const cells = data.board
    .map((token, index) => {
      if (!token) return '<div class="sd-cell empty"></div>';
      const picked = selectedCells.includes(index);
      return `<div class="sd-cell${picked ? ' picked' : ''}${token === 'gold' ? ' gold' : ''}" data-cell="${index}">
        <span class="sd-token ${token}"></span>
      </div>`;
    })
    .join('');
  return `<div class="sd-box">
    <div class="sd-box-title">宝石版图 · 袋 ${data.bagCount} 个</div>
    <div class="sd-board">${cells}</div>
  </div>`;
}

function renderPyramid(data: SdData): string {
  const rows: { label: string; from: number; count: number }[] = [
    { label: '3 级', from: 0, count: 3 },
    { label: '2 级', from: 3, count: 4 },
    { label: '1 级', from: 7, count: 5 },
  ];
  const body = rows
    .map((row) => {
      const cards = data.pyramid
        .slice(row.from, row.from + row.count)
        .map((cardId) => (cardId ? cardHtml(cardId, { selected: cardId === selectedCard }) : '<div class="sd-card back"></div>'))
        .join('');
      return `<div class="sd-row"><span class="sd-row-label">${row.label}</span>${cards}</div>`;
    })
    .join('');
  return `<div class="sd-box">
    <div class="sd-box-title">金字塔 · 牌堆 ${data.deckCounts['1']} / ${data.deckCounts['2']} / ${data.deckCounts['3']}</div>
    <div class="sd-pyramid">${body}</div>
  </div>`;
}

function renderControl(data: SdData): string {
  if (!snapshot?.view) return '<div class="sd-wait">等对手行动…</div>';
  if (snapshot.view.finished) return '<div class="sd-wait">对局结束</div>';
  if (!isMyTurn()) return '<div class="sd-wait">等对手行动…</div>';
  const view = snapshot.view;
  const me = playerOf(meId() ?? '');
  if (view.phase === 'royal') return '';
  if (view.phase === 'steal') return '';
  if (view.phase === 'discard') return '';
  if (!me) return '<div class="sd-wait">你在观战</div>';
  if (data.optional.mandatoryDone) return '<div class="sd-wait">正在结算强制行动…</div>';

  const takeReady = legalTake(selectedCells);
  const usePrivilegeReady =
    privilegeMode && selectedCells.length > 0 && selectedCells.length <= me.privileges;
  const canPrivilege =
    me.privileges > 0 && !data.optional.privilegesUsed && !data.optional.replenished;
  const canReplenish =
    data.bagCount > 0 &&
    data.board.some((cell) => cell == null) &&
    !data.optional.replenished &&
    !data.optional.mandatoryDone;
  const legalMovesNow = snapshot.legalMoves ?? [];
  const canPass = legalMovesNow.some((move) => move.type === 'pass');
  const deckReserves = (['1', '2', '3'] as const)
    .filter((level) =>
      legalMovesNow.some((move) => {
        if (move.type !== 'reserve') return false;
        const payload = move.payload as { from?: string; level?: string } | undefined;
        return payload?.from === 'deck' && payload.level === level;
      }),
    )
    .map(
      (level) =>
        `<button class="sd-btn" data-act="reserve-deck" data-level="${level}">盲预留 ${level} 级牌堆顶</button>`,
    )
    .join('');

  return `<div class="sd-box">
    <div class="sd-box-title">你的回合 · 先做可选动作，再做三选一</div>
    <div class="sd-hint">${
      privilegeMode
        ? `特权：点版图上的非金宝石，选 ${me.privileges} 个以内；再点“用特权拿”。`
        : '点版图上的宝石选 1–3 个连续相邻的；或点金字塔/预留卡购买、预留。'
    }</div>
    <div class="sd-modal-row">
      ${
        privilegeMode
          ? `<button class="sd-btn primary" data-act="use-privileges" ${
              usePrivilegeReady ? '' : 'disabled'
            }>用特权拿 ${selectedCells.length} 个</button>
             <button class="sd-btn" data-act="privilege">退出特权</button>`
          : `<button class="sd-btn primary" data-act="take" ${takeReady ? '' : 'disabled'}>拿走选中宝石</button>
             <button class="sd-btn" data-act="privilege" ${canPrivilege ? '' : 'disabled'}>使用特权</button>`
      }
      <button class="sd-btn" data-act="replenish" ${canReplenish ? '' : 'disabled'}>补版图（对手得特权）</button>
      ${deckReserves}
      ${canPass ? '<button class="sd-btn" data-act="pass">跳过</button>' : ''}
      <button class="sd-btn" data-act="cancel">清空选择</button>
    </div>
  </div>`;
}

function renderModal(data: SdData): string {
  if (!isMyTurn() || !snapshot?.view) return '';
  const view = snapshot.view;
  const me = playerOf(meId() ?? '');
  if (!me) return '';

  if (view.phase === 'royal') {
    const choices = data.royals
      .map(
        (royalId) =>
          `<button class="sd-btn" data-act="royal" data-royal="${royalId}">${royalHtml(royalId)}</button>`,
      )
      .join('');
    return `<div class="sd-modal"><div class="sd-modal-card">
      <h3>你拿到皇冠奖励</h3>
      <div class="sd-muted">选一张 Royal 卡，立刻结算它的效果。</div>
      <div class="sd-modal-row">${choices || '<span class="sd-muted">Royal 已经被拿完</span>'}</div>
    </div></div>`;
  }

  if (view.phase === 'steal') {
    const opponentId = view.players.find((id) => id !== me.id) ?? '';
    const opponent = playerOf(opponentId);
    const choices = ([...GEM_COLORS, 'pearl'] as TokenColor[])
      .filter((color) => (opponent?.tokens?.[color] ?? 0) > 0)
      .map(
        (color) =>
          `<button class="sd-btn" data-act="steal" data-color="${color}">${tokenChip(
            color,
          )} ${TOKEN_NAME[color]}（${opponent?.tokens?.[color] ?? 0}）</button>`,
      )
      .join('');
    return `<div class="sd-modal"><div class="sd-modal-card">
      <h3>偷一个 token</h3>
      <div class="sd-muted">只能拿非金 token。</div>
      <div class="sd-modal-row">${choices || '<span class="sd-muted">对手没有可偷的 token</span>'}</div>
    </div></div>`;
  }

  if (view.phase === 'discard') {
    const excess = TOKEN_COLORS.reduce((sum, color) => sum + (me.tokens[color] ?? 0), 0) - 10;
    const selectedCount = discardSel.length;
    const buttons = TOKEN_COLORS.filter((color) => (me.tokens[color] ?? 0) > 0)
      .map(
        (color) =>
          `<button class="sd-btn" data-act="discard-token" data-color="${color}" ${
            discardSel.filter((item) => item === color).length >= (me.tokens[color] ?? 0)
              ? 'disabled'
              : ''
          }>${tokenChip(color)} ${TOKEN_NAME[color]} ${me.tokens[color]}</button>`,
      )
      .join('');
    return `<div class="sd-modal"><div class="sd-modal-card">
      <h3>弃到 10 个 token</h3>
      <div class="sd-muted">还要弃 ${excess} 个，已选 ${selectedCount} 个。</div>
      <div class="sd-modal-row">${buttons}</div>
      <div class="sd-selected">${discardSel.map((color) => tokenChip(color)).join('')}</div>
      <div class="sd-modal-row">
        <button class="sd-btn primary" data-act="discard" ${selectedCount === excess ? '' : 'disabled'}>确认弃掉</button>
        <button class="sd-btn" data-act="discard-reset">重选</button>
      </div>
    </div></div>`;
  }

  return '';
}

function render(): void {
  if (!root || !context) return;
  const view = snapshot?.view;
  if (!view) {
    root.innerHTML = '<div class="sd-wait">等待对局开始…</div>';
    return;
  }
  const data = viewData();
  if (!data) {
    root.innerHTML = '<div class="sd-wait">等待牌桌数据…</div>';
    return;
  }
  const me = meId();
  const opponents = view.players.filter((id) => id !== me);
  const mePlayer = me ? playerOf(me) : null;
  const turnName = view.turn ? nameOf(view.turn) : '—';
  const phaseName: Record<string, string> = {
    playing: '行动',
    royal: '选 Royal',
    steal: '偷 token',
    discard: '弃 token',
    finished: '结束',
  };
  const top = `<div class="sd-topbar">
    <span class="sd-turn">${view.finished ? '对局结束' : `${turnName} 的回合`}</span>
    <span class="sd-badge">${phaseName[view.phase] ?? view.phase}</span>
    <span class="sd-muted">特权池 ${data.privilegeSupply}</span>
    <span class="sd-muted">袋 ${data.bagCount}</span>
    <span class="sd-muted">牌堆 ${data.deckCounts['1']}/${data.deckCounts['2']}/${data.deckCounts['3']}</span>
    ${me ? '' : '<span class="sd-badge">观战 / 回放</span>'}
  </div>`;

  const opponentPanels = opponents.map((id) => {
    const player = playerOf(id);
    return player ? renderPanel(player, false) : '';
  }).join('');

  const center = `<div class="sd-center">
    <div class="sd-side">
      ${renderPyramid(data)}
      ${renderDetail(data)}
      ${renderControl(data)}
    </div>
    <div class="sd-side">
      ${renderBoard(data)}
      <div class="sd-box">
        <div class="sd-box-title">Royal 卡</div>
        <div class="sd-royals">${data.royals.map((royalId) => royalHtml(royalId, true)).join('') || '<span class="sd-muted">已拿完</span>'}</div>
      </div>
      ${renderLegend()}
    </div>
  </div>`;

  const myPanel = mePlayer ? renderPanel(mePlayer, true) : '';

  root.innerHTML = `<div class="sd-root">
    ${top}
    ${opponentPanels}
    ${center}
    ${myPanel}
    ${renderModal(data)}
  </div>`;
}

function onClick(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cell],[data-card],[data-act]');
  if (!target || !context) return;

  if (target.dataset.cell != null && !target.dataset.act) {
    const cell = Number(target.dataset.cell);
    if (!Number.isFinite(cell)) return;
    if (privilegeMode) {
      selectedCells = selectedCells.includes(cell)
        ? selectedCells.filter((item) => item !== cell)
        : [...selectedCells, cell].slice(0, 3);
    } else {
      selectedCells = selectedCells.includes(cell)
        ? selectedCells.filter((item) => item !== cell)
        : [...selectedCells, cell].slice(0, 3);
    }
    render();
    return;
  }

  if (target.dataset.card && !target.dataset.act) {
    const cardId = target.dataset.card;
    const data = viewData();
    if (!cardId || !data) return;
    const isPyramid = data.pyramid.includes(cardId);
    const myReserved = (playerOf(meId() ?? '')?.reserved ?? []).some(
      (item) => item.cardId === cardId,
    );
    if (isPyramid || myReserved) {
      selectedCard = cardId;
      selectedCells = [];
      privilegeMode = false;
      render();
    }
    return;
  }

  const act = target.dataset.act;
  if (!act) return;
  if (act === 'take') {
    if (!legalTake(selectedCells)) return;
    context.send({ type: 'takeTokens', payload: { cells: selectedCells } });
    selectedCells = [];
    selectedCard = null;
  } else if (act === 'privilege') {
    privilegeMode = !privilegeMode;
    selectedCells = [];
  } else if (act === 'use-privileges') {
    if (selectedCells.length === 0) return;
    context.send({ type: 'usePrivileges', payload: { cells: selectedCells } });
    selectedCells = [];
    privilegeMode = false;
  } else if (act === 'replenish') {
    context.send({ type: 'replenish', payload: {} });
  } else if (act === 'pass') {
    context.send({ type: 'pass', payload: {} });
  } else if (act === 'reserve-deck') {
    const level = target.dataset.level;
    if (level === '1' || level === '2' || level === '3') {
      context.send({ type: 'reserve', payload: { from: 'deck', level } });
    }
  } else if (act === 'buy' && selectedCard) {
    const copy = target.dataset.copy;
    context.send({
      type: 'buy',
      payload: copy ? { cardId: selectedCard, copyColor: copy } : { cardId: selectedCard },
    });
    selectedCard = null;
  } else if (act === 'reserve' && selectedCard) {
    const cell = Number(target.dataset.cell);
    if (!Number.isFinite(cell)) return;
    context.send({ type: 'reserve', payload: { from: 'pyramid', cell } });
    selectedCard = null;
  } else if (act === 'royal') {
    const royalId = target.dataset.royal;
    if (royalId) context.send({ type: 'takeRoyal', payload: { royalId } });
  } else if (act === 'steal') {
    const color = target.dataset.color;
    if (color) context.send({ type: 'steal', payload: { color } });
  } else if (act === 'discard-token') {
    const color = target.dataset.color as TokenColor | undefined;
    const me = playerOf(meId() ?? '');
    if (!color || !me) return;
    const have = me.tokens[color] ?? 0;
    if (discardSel.filter((item) => item === color).length < have) {
      discardSel = [...discardSel, color];
    }
  } else if (act === 'discard-reset') {
    discardSel = [];
  } else if (act === 'discard') {
    context.send({ type: 'discardTokens', payload: { colors: discardSel } });
    discardSel = [];
  } else if (act === 'cancel') {
    selectedCells = [];
    selectedCard = null;
    privilegeMode = false;
  }
  render();
}

function mount(next: GameClientContext): void {
  ensureStyle();
  context = next;
  root = document.createElement('div');
  root.className = 'sd-root-host';
  next.root.replaceChildren(root);
  next.root.addEventListener('click', onClick);
  render();
}

function update(next: ClientSnapshot): void {
  snapshot = next;
  const view = next.view;
  const phase = view?.phase ?? '';
  const turn = view?.turn ?? '';
  if (phase !== lastPhase || turn !== lastTurn) {
    selectedCells = [];
    privilegeMode = false;
    discardSel = [];
    if (phase !== 'playing') selectedCard = null;
    lastPhase = phase;
    lastTurn = turn;
  }
  if (selectedCard) {
    const data = viewData();
    const mine = meId() ? playerOf(meId()!)?.reserved ?? [] : [];
    const stillThere =
      !!data &&
      (data.pyramid.includes(selectedCard) ||
        mine.some((item) => item.cardId === selectedCard));
    if (!stillThere) selectedCard = null;
  }
  render();
}

function unmount(): void {
  context?.root.removeEventListener('click', onClick);
  root?.remove();
  root = null;
  context = null;
  snapshot = null;
  selectedCells = [];
  privilegeMode = false;
  selectedCard = null;
  discardSel = [];
  lastPhase = '';
  lastTurn = '';
}

function formatLog(entry: LogEntry): string | null {
  const args = entry.args ?? {};
  const who = nameOf(String(args.player ?? args.winner ?? ''));
  switch (entry.key) {
    case 'sd.take': {
      const tokens = (args.tokens as TokenColor[] | undefined) ?? [];
      return `${who} 拿了 ${tokens.map((token) => TOKEN_NAME[token]).join('、')}`;
    }
    case 'sd.reserve':
      return `${who} 预购了一张卡`;
    case 'sd.buy': {
      const card = CARD_BY_ID[String(args.cardId)];
      return `${who} 买下 ${card ? `${card.level} 级 ${card.prestige} 分卡` : '一张卡'}`;
    }
    case 'sd.privilege':
      return `${who} 使用了 ${args.count ?? 1} 张特权`;
    case 'sd.replenish':
      return `${who} 补了版图`;
    case 'sd.royal': {
      const royal = ROYAL_BY_ID[String(args.royalId)];
      return `${who} 拿了 Royal（${royal?.prestige ?? 2} 分）`;
    }
    case 'sd.steal':
      return `${who} 从 ${nameOf(String(args.from))} 手里偷了 ${TOKEN_NAME[String(args.color) as TokenColor] ?? 'token'}`;
    case 'sd.discard': {
      const colors = (args.colors as TokenColor[] | undefined) ?? [];
      return `${who} 弃了 ${colors.length} 个 token`;
    }
    case 'sd.pass':
      return `${who} 跳过`;
    case 'sd.gameEnd':
      return `${who} 获胜！`;
    default:
      return null;
  }
}

const client: GameClient = { mount, update, unmount, formatLog };
export default client;
export { client };
