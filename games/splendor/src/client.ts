/**
 * 璀璨宝石 —— 客户端。原生 DOM + 内联 CSS，无图片。
 *
 * 三层结构：发展卡三行 / 宝石与贵族 / 每位玩家的资产面板。
 * 点卡牌弹出详情，按平台给的具体 legalMoves 决定按钮亮不亮。
 */
import type { ClientSnapshot, GameClient, GameClientContext, LogEntry, PublicView } from '@platform/sdk';
import {
  CARD_BY_ID,
  CITY_BY_ID,
  COLOR_NAME,
  GEMS,
  NOBLE_BY_ID,
  TRADING_POWERS,
  type Card,
  type CitySide,
  type Gem,
  type TokenColor,
} from './data.js';

const STYLE_ID = 'splendor-style';

const GEM_HEX: Record<TokenColor, string> = {
  white: '#e8edf5',
  blue: '#3a7bd5',
  green: '#2f9e62',
  red: '#d64545',
  black: '#4b5563',
  gold: '#e3b341',
};

const LEVEL_COLOR: Record<'1' | '2' | '3', string> = {
  '1': '#5f8f5a',
  '2': '#b28a3a',
  '3': '#7a6ac0',
};

/** 四个座位的颜色，用来标要塞归属 */
const SEAT_COLOR = ['#4c8dff', '#2f9e62', '#d64545', '#e3b341'];

const EXPANSION_LABEL: Record<string, string> = {
  cities: '扩展 · 繁华之城',
  strongholds: '扩展 · 荣誉之战',
  'trading-posts': '扩展 · 贸易之路',
};

const LEVEL_NAME: Record<'1' | '2' | '3', string> = {
  '1': '等级 1',
  '2': '等级 2',
  '3': '等级 3',
};

/** 日志和提示里只用单字，卡面不写颜色名 */
const COLOR_SHORT: Record<TokenColor, string> = {
  white: '白',
  blue: '蓝',
  green: '绿',
  red: '红',
  black: '黑',
  gold: '金',
};

interface ViewPlayer {
  id: string;
  tokens: Record<TokenColor, number>;
  cards: string[];
  reserved: (string | null)[];
  reservedCount: number;
  nobles: string[];
  bonuses: Record<Gem, number>;
  prestige: number;
  seals: string[];
}

interface ViewCity {
  key: string;
  tileId: string;
  side: 0 | 1;
  owner: string | null;
}

interface ViewData {
  expansions: string[];
  supply: Record<TokenColor, number>;
  board: Record<'1' | '2' | '3', (string | null)[]>;
  deckCounts: Record<'1' | '2' | '3', number>;
  nobles: string[];
  cities: ViewCity[];
  strongholds: Record<string, { owner: string; count: number }>;
  conquestTargets: string[];
  pendingNobles: string[];
  pendingPowers: string[];
  pendingCities: string[];
  pendingDeck: string[];
  endTriggered: boolean;
  players: ViewPlayer[];
  you: string | null;
  seats: number;
}

const CSS = `
.sp-root { display: flex; flex-direction: column; gap: 12px; color: #e6edf3; position: relative; container-type: inline-size; }
.sp-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border: 1px solid #262d38; border-radius: 12px; background: rgba(22,27,34,.72); }
.sp-turn { font-weight: 700; }
.sp-muted { color: #8b98a7; font-size: 12px; }
.sp-badge { border: 1px solid #2c3745; border-radius: 999px; padding: 2px 9px; font-size: 11px; color: #c3ccd8; }
.sp-badge.warn { border-color: rgba(210,153,34,.6); color: #e3b341; }
.sp-main { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 12px; align-items: start; }
.sp-board { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid #262d38; border-radius: 14px; background: radial-gradient(circle at 50% 0%, rgba(76,141,255,.08), rgba(15,20,27,.9)); }
.sp-row { display: flex; align-items: center; gap: 10px; }
.sp-row-label { width: 74px; flex: none; display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: #8b98a7; }
.sp-row-cards { flex: 1 1 auto; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.sp-card { box-sizing: border-box; width: 104px; height: 144px; border-radius: 10px; border: 2px solid #3a4656; background: linear-gradient(160deg, #1e2634, #141a23); display: flex; flex-direction: column; padding: 7px 7px 8px; gap: 2px; cursor: pointer; position: relative; overflow: hidden; transition: transform .08s ease, box-shadow .08s ease; }
.sp-card:hover { transform: translateY(-2px); box-shadow: 0 6px 14px rgba(0,0,0,.35); }
.sp-card.empty { border-style: dashed; border-color: #2c3745; background: rgba(16,20,26,.5); cursor: default; }
.sp-card.empty:hover { transform: none; box-shadow: none; }
.sp-card.picked { outline: 2px dashed #f2c94c; outline-offset: 2px; }
.sp-card.occupied { padding-left: 15px; }
.sp-card-top { display: flex; justify-content: space-between; align-items: flex-start; min-height: 18px; }
.sp-pts { font-size: 21px; font-weight: 800; line-height: 1; color: #f5f7fa; }
.sp-bonus { width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(255,255,255,.35); box-shadow: inset 0 1px 2px rgba(255,255,255,.45); flex: none; display: block; }
.sp-card-mid { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; gap: 3px; min-height: 20px; }
.sp-fort { width: 10px; height: 18px; border-radius: 3px; box-shadow: 0 0 0 1px rgba(0,0,0,.45), inset 0 1px 2px rgba(255,255,255,.25); }
.sp-cost { margin-top: auto; display: flex; gap: 2px; flex-wrap: wrap; justify-content: center; position: relative; z-index: 2; }
.sp-pip { width: 17px; height: 17px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; color: #1b2029; border: 1px solid rgba(255,255,255,.35); box-shadow: inset 0 0 0 1px rgba(0,0,0,.16); font-variant-numeric: tabular-nums; }
.sp-deck { width: 104px; height: 144px; border-radius: 10px; border: 2px solid #2c3745; background: repeating-linear-gradient(135deg, #1b2230, #1b2230 6px, #232c3c 6px, #232c3c 12px); display: flex; align-items: center; justify-content: center; color: #8b98a7; font-size: 12px; flex: none; margin-left: auto; }
.sp-side { display: flex; flex-direction: column; gap: 10px; }
.sp-panel { border: 1px solid #262d38; border-radius: 12px; background: rgba(20,25,32,.82); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.sp-panel-title { font-size: 12px; color: #8b98a7; display: flex; justify-content: space-between; gap: 8px; }
.sp-gems { display: flex; flex-wrap: wrap; gap: 8px; }
.sp-gem { display: flex; align-items: center; gap: 5px; border: 1px solid #2c3745; border-radius: 10px; padding: 4px 7px; background: rgba(12,16,22,.6); cursor: pointer; font-size: 12px; }
.sp-gem.sel { outline: 2px solid #4c8dff; outline-offset: 1px; }
.sp-gem.empty { opacity: .35; cursor: default; }
.sp-dot { width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(0,0,0,.35); box-shadow: inset 0 1px 3px rgba(255,255,255,.45); flex: none; }
.sp-nobles { display: flex; flex-wrap: wrap; gap: 8px; }
.sp-noble { width: 58px; height: 68px; border-radius: 9px; border: 2px solid #b28a3a; background: linear-gradient(160deg, #3d3220, #221a0e); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; cursor: pointer; flex: none; }
.sp-noble .pts { font-size: 15px; font-weight: 800; color: #f7e6a8; }
.sp-noble .req { display: flex; gap: 3px; }
.sp-noble .req i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; border: 1px solid rgba(255,255,255,.3); }
.sp-noble-pip { width: 15px; height: 15px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 800; color: #1b2029; border: 1px solid rgba(255,255,255,.3); }
.sp-noble.pick { outline: 2px solid #4c8dff; outline-offset: 1px; }
.sp-players { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.sp-player { border: 1px solid #262d38; border-radius: 12px; background: rgba(20,25,32,.82); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.sp-player.me { border-color: #4c8dff; box-shadow: 0 0 0 1px rgba(76,141,255,.28); }
.sp-player.active { background: rgba(76,141,255,.1); }
.sp-player-head { display: flex; align-items: center; gap: 8px; }
.sp-seat-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.sp-line { display: flex; gap: 8px; align-items: center; }
.sp-line-label { font-size: 11px; color: #8b98a7; width: 26px; flex: none; }
.sp-player-name { font-weight: 650; display: inline-flex; align-items: center; gap: 6px; }
.sp-score { margin-left: auto; font-size: 20px; font-weight: 800; }
.sp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.sp-chip { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; border: 1px solid #2c3745; border-radius: 999px; padding: 1px 6px; color: #c3ccd8; }
.sp-chip.discardable { cursor: pointer; border-color: rgba(214,69,69,.5); }
.sp-chip.discardable:hover { background: rgba(214,69,69,.15); }
.sp-bonuses { display: flex; gap: 6px; flex-wrap: wrap; }
.sp-bonus-cell { display: flex; align-items: center; gap: 3px; font-size: 11px; color: #c3ccd8; }
.sp-bonus-cell i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.sp-reserved { display: flex; gap: 4px; flex-wrap: wrap; }
.sp-mini { width: 26px; height: 36px; border-radius: 4px; border: 1px solid #3a4656; background: #1a212b; font-size: 9px; color: #c3ccd8; display: flex; align-items: center; justify-content: center; }
.sp-mini.back { background: repeating-linear-gradient(135deg, #1b2230, #1b2230 3px, #232c3c 3px, #232c3c 6px); }
.sp-detail { border: 1px solid #2c3745; border-radius: 12px; background: rgba(22,27,34,.94); padding: 12px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.sp-detail-card { width: 120px; height: 165px; border-radius: 12px; border: 3px solid #3a4656; background: linear-gradient(160deg, #1e2634, #141a23); padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.sp-detail-card .sp-pts { font-size: 26px; }
.sp-detail-card .sp-bonus { width: 26px; height: 26px; }
.sp-detail-card .sp-pip { width: 24px; height: 24px; font-size: 12px; }
.sp-detail-info { display: flex; flex-direction: column; gap: 8px; min-width: 160px; }
.sp-btn { padding: 7px 12px; border-radius: 9px; border: 1px solid #2c3745; background: #1a212b; color: #e6edf3; cursor: pointer; font-size: 13px; }
.sp-btn:hover:not(:disabled) { border-color: #4c8dff; }
.sp-btn.primary { background: linear-gradient(180deg, #4c8dff, #3a72d8); border-color: transparent; font-weight: 650; }
.sp-btn:disabled { opacity: .38; cursor: default; }
.sp-hint { border: 1px dashed #2c3745; border-radius: 10px; padding: 7px 9px; color: #aab6c4; font-size: 12px; }
.sp-hint.warn { border-color: rgba(242,153,74,.55); color: #f0b37e; }
.sp-power { display: flex; gap: 8px; align-items: center; border: 1px solid #2c3745; border-radius: 10px; padding: 6px 8px; font-size: 11px; color: #aab6c4; }
.sp-power.reach { border-color: #4c8dff; color: #e6edf3; cursor: pointer; }
.sp-power .name { color: #e6edf3; font-weight: 600; font-size: 12px; }
.sp-power .req { display: flex; gap: 2px; }
.sp-power .req i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.sp-req-noble { font-size: 10px; color: #e6c06a; }
.sp-seats { display: flex; gap: 3px; }
.sp-seat { width: 6px; height: 16px; border-radius: 2px; background: #2c3745; }
.sp-seat.on { background: #4c8dff; }
.sp-strong { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; color: #f0b37e; }
.sp-strong i { width: 7px; height: 7px; border-radius: 2px; background: #d0904a; display: inline-block; }
.sp-modal { position: absolute; inset: 0; background: rgba(6,9,13,.7); display: flex; align-items: center; justify-content: center; z-index: 9; padding: 16px; }
.sp-modal-card { width: min(460px, 100%); border: 1px solid #3a4656; border-radius: 16px; background: #121821; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.sp-modal h3 { margin: 0; font-size: 16px; }
.sp-modal-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sp-table th, .sp-table td { padding: 4px 6px; border-bottom: 1px solid rgba(44,55,69,.6); text-align: left; }
.sp-table th { color: #8b98a7; font-weight: 500; }
.sp-wait { color: #8b98a7; font-size: 13px; }
.sp-city-list { display: flex; flex-direction: column; gap: 8px; }
.sp-city { border: 1px solid #2c3745; border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: rgba(12,16,22,.55); }
.sp-city.reach { border-color: #4c8dff; cursor: pointer; box-shadow: 0 0 0 1px rgba(76,141,255,.3); }
.sp-city.owned { border-color: #b28a3a; }
.sp-city-head { display: flex; align-items: baseline; gap: 8px; }
.sp-city-head b { font-size: 21px; color: #f7e6a8; }
.sp-city-head span { font-size: 12px; color: #aab6c4; }
.sp-city-req { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; color: #8b98a7; }
.sp-any { display: inline-flex; gap: 2px; align-items: center; }
.sp-any i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; border: 1px solid rgba(255,255,255,.25); }
.sp-city-owner { font-size: 11px; color: #e3b341; }
/* 牌桌右侧还有日志栏，实际可用宽度比视口窄很多：按容器宽度收成单列 */
@container (max-width: 900px) {
  .sp-main { grid-template-columns: 1fr; }
  .sp-side { flex-direction: row; flex-wrap: wrap; align-items: stretch; }
  .sp-side > .sp-panel { flex: 1 1 220px; }
}
`;

const esc = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

function dot(color: TokenColor): string {
  return `<i class="sp-dot" style="background:${GEM_HEX[color]}"></i>`;
}

function pip(color: Gem, count: number): string {
  return `<span class="sp-pip" style="background:${GEM_HEX[color]}" title="${esc(COLOR_NAME[color])}">${count}</span>`;
}

function cardCost(card: Card): string {
  return GEMS.filter((gem) => card.cost[gem] > 0)
    .map((gem) => pip(gem, card.cost[gem]))
    .join('');
}

function cardHtml(
  card: Card,
  options: { picked?: boolean; strongholds?: number; strongholdColor?: string } = {},
): string {
  return `<div class="sp-card${options.picked ? ' picked' : ''}" data-act="card" data-card="${card.id}" style="border-color:${LEVEL_COLOR[String(card.level) as '1' | '2' | '3']}${options.strongholds ? `;outline:2px solid ${options.strongholdColor ?? '#d0904a'};outline-offset:2px` : ''}">
    <div class="sp-card-top">
      <span class="sp-pts">${card.prestige > 0 ? card.prestige : ''}</span>
      <span class="sp-bonus" style="background:${GEM_HEX[card.bonus]}" title="${esc(COLOR_NAME[card.bonus])} 红利"></span>
    </div>
    <div class="sp-card-mid" title="要塞 ×${options.strongholds ?? 0}">${options.strongholds ? `<span class="sp-fort" style="background:${options.strongholdColor ?? '#d0904a'}"></span>`.repeat(options.strongholds) : ''}</div>
    <div class="sp-cost">${cardCost(card)}</div>
  </div>`;
}

function anyDots(count: number): string {
  const colors: TokenColor[] = ['white', 'blue', 'green', 'red', 'black'];
  return `<span class="sp-any">${colors.map((color) => `<i style="background:${GEM_HEX[color]}"></i>`).join('')}</span><span>×${count}</span>`;
}

function cityRequirementHtml(side: CitySide): string {
  const requirement = side.requirement;
  if (requirement.kind === 'none') return '<span>只要声望</span>';
  if (requirement.kind === 'fixed') {
    return GEMS.filter((gem) => (requirement.need[gem] ?? 0) > 0)
      .map((gem) => pip(gem, requirement.need[gem]!))
      .join('');
  }
  if (requirement.kind === 'any') return anyDots(requirement.count);
  return `${pip(requirement.base, requirement.count)}<span>+</span>${anyDots(requirement.count)}`;
}

function cityHtml(city: ViewCity, pending: boolean, ownerName: string | null): string {
  const tile = CITY_BY_ID[city.tileId];
  if (!tile) return '';
  const side = tile.sides[city.side];
  return `<div class="sp-city${pending ? ' reach' : ''}${ownerName ? ' owned' : ''}" ${pending ? `data-act="city" data-key="${city.key}"` : ''} title="${esc(tile.name)} · ${side.prestige} 分">
    <div class="sp-city-head"><b>${side.prestige}</b><span>${esc(tile.name)}</span></div>
    <div class="sp-city-req">${cityRequirementHtml(side)}</div>
    ${ownerName ? `<div class="sp-city-owner">${esc(ownerName)}</div>` : ''}
  </div>`;
}

function nobleHtml(nobleId: string, picked: boolean): string {  const noble = NOBLE_BY_ID[nobleId];
  if (!noble) return '';
  const req = GEMS.filter((gem) => (noble.need[gem] ?? 0) > 0)
    .map(
      (gem) =>
        `<span class="sp-noble-pip" style="background:${GEM_HEX[gem]}" title="${esc(COLOR_NAME[gem])} ×${noble.need[gem]}">${noble.need[gem]}</span>`,
    )
    .join('');
  return `<div class="sp-noble${picked ? ' pick' : ''}"${picked ? ` data-act="noble" data-noble="${noble.id}"` : ''}>
    <span class="pts">${noble.prestige}</span><span class="req">${req}</span>
  </div>`;
}

export function createSplendorClient(): GameClient {
  let context: GameClientContext | null = null;
  let snapshot: ClientSnapshot | null = null;
  let selected: Gem[] = [];
  let focusCard: string | null = null;
  let names: Record<string, string> = {};

  function data(): ViewData | null {
    const view = snapshot?.view as PublicView | null;
    if (!view) return null;
    return view.data as unknown as ViewData;
  }

  function me(): string | null {
    return context?.me ?? null;
  }

  function can(type: string, match?: (payload: Record<string, unknown>) => boolean): boolean {
    return (snapshot?.legalMoves ?? []).some(
      (move) => move.type === type && (!match || match((move.payload ?? {}) as Record<string, unknown>)),
    );
  }

  function moves(): { type: string; payload?: unknown }[] {
    return snapshot?.legalMoves ?? [];
  }

  function myTurn(): boolean {
    const view = snapshot?.view as PublicView | null;
    return Boolean(view && view.turn === me() && !view.finished);
  }

  function takeConfirmed(): boolean {
    if (selected.length === 3) {
      const want = [...selected].sort().join(',');
      return can('take3', (payload) => {
        const colors = payload.colors as string[] | undefined;
        if (!Array.isArray(colors) || colors.length !== 3 || new Set(colors).size !== 3) return false;
        return [...colors].sort().join(',') === want;
      });
    }
    if (selected.length === 2 && selected[0] === selected[1]) {
      return can('take2', (payload) => payload.color === selected[0]);
    }
    return false;
  }

  /** 这张牌在牌桌上的位置（预留的牌没有位置） */
  function boardPosition(cardId: string): { level: '1' | '2' | '3'; index: number } | null {
    const d = data();
    if (!d) return null;
    for (const level of ['3', '2', '1'] as const) {
      const index = d.board[level].indexOf(cardId);
      if (index >= 0) return { level, index };
    }
    return null;
  }

  function seatColor(d: ViewData, playerId: string): string {
    const index = d.players.findIndex((player) => player.id === playerId);
    return SEAT_COLOR[Math.max(0, index) % SEAT_COLOR.length]!;
  }

  function render(): void {
    const host = context?.root;
    const view = snapshot?.view as PublicView | null;
    const d = data();
    if (!host || !view || !d) {
      if (host) host.querySelector('.sp-root')?.replaceChildren();
      return;
    }

    const turnName = view.turn ? names[view.turn] ?? view.turn : null;
    const my = me();
    const active = view.turn === my && !view.finished;
    const badges = (d.expansions ?? [])
      .map((id) => `<span class="sp-badge">${esc(EXPANSION_LABEL[id] ?? id)}</span>`)
      .join('');

    const boardRows = (['3', '2', '1'] as const)
      .map((level) => {
        const cards = d.board[level]
          .map((cardId) => {
            if (!cardId) return `<div class="sp-card empty"></div>`;
            const spot = d.strongholds[cardId];
            return cardHtml(CARD_BY_ID[cardId]!, {
              picked: focusCard === cardId,
              strongholds: spot?.count ?? 0,
              strongholdColor: spot ? seatColor(d, spot.owner) : undefined,
            });
          })
          .join('');
        return `<div class="sp-row">
          <div class="sp-row-label">
            <span style="color:${LEVEL_COLOR[level]};font-weight:650">${LEVEL_NAME[level]}</span>
            <span>牌堆 ${d.deckCounts[level]} 张</span>
          </div>
          <div class="sp-row-cards">${cards}</div>
          <div class="sp-deck" title="牌堆剩余 ${d.deckCounts[level]} 张">${d.deckCounts[level]}</div>
        </div>`;
      })
      .join('');

    const supply = (['white', 'blue', 'green', 'red', 'black', 'gold'] as TokenColor[])
      .map((color) => {
        const count = d.supply[color];
        const picked = selected.filter((item) => item === color).length;
        return `<div class="sp-gem ${count <= 0 ? 'empty' : ''} ${picked > 0 ? 'sel' : ''}" data-act="gem" data-color="${color}" title="${esc(COLOR_NAME[color])}">
          ${dot(color)}<span>${count}</span>${picked > 0 ? `<span style="color:#4c8dff">×${picked}</span>` : ''}
        </div>`;
      })
      .join('');

    const nobles = d.nobles.length
      ? d.nobles.map((id) => nobleHtml(id, d.pendingNobles.includes(id))).join('')
      : '<span class="sp-muted">没有贵族了</span>';

    const cityPanel =
      d.expansions.includes('cities')
        ? `<div class="sp-panel">
            <div class="sp-panel-title"><span>城市</span><span>3 座</span></div>
            <div class="sp-city-list">${d.cities
              .map((city) =>
                cityHtml(
                  city,
                  d.pendingCities.includes(city.key),
                  city.owner ? names[city.owner] ?? city.owner : null,
                ),
              )
              .join('')}</div>
          </div>`
        : `<div class="sp-panel">
            <div class="sp-panel-title"><span>贵族</span><span>${d.nobles.length} 位</span></div>
            <div class="sp-nobles">${nobles}</div>
          </div>`;

    const powers = d.expansions.includes('trading-posts')
      ? TRADING_POWERS.map((power) => {
          const reach = d.pendingPowers.includes(power.id);
          const owners = d.players.filter((player) => player.seals.includes(power.id));
          const req = GEMS.filter((gem) => (power.need[gem] ?? 0) > 0)
            .map((gem) => `<i style="background:${GEM_HEX[gem]}"></i>`.repeat(power.need[gem] ?? 0))
            .join('');
          return `<div class="sp-power ${reach ? 'reach' : ''}" ${reach ? `data-act="power" data-power="${power.id}"` : ''} title="${esc(power.description)}">
            <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">
              <span class="name">${esc(power.name)}${owners.length ? ` · ${owners.map((player) => esc(names[player.id] ?? player.id)).join('、')}` : ''}</span>
              <span class="req">${req}</span>
            </div>
          </div>`;
        }).join('')
      : '';

    const players = d.players
      .map((player) => {
        const isMe = player.id === my;
        const isActive = view.turn === player.id && !view.finished;
        const chips = (['white', 'blue', 'green', 'red', 'black', 'gold'] as TokenColor[])
          .map((color) => {
            const count = player.tokens[color];
            if (!count) return '';
            const discard = isMe && view.phase === 'discard' && can('discardToken', (payload) => payload.color === color);
            return `<span class="sp-chip${discard ? ' discardable' : ''}" ${discard ? `data-act="discard" data-color="${color}"` : ''} title="${esc(COLOR_NAME[color])}${discard ? '（点掉）' : ''}">${dot(color)}${count}</span>`;
          })
          .join('');
        const bonuses = GEMS.filter((gem) => player.bonuses[gem] > 0)
          .map((gem) => `<span class="sp-bonus-cell"><i style="background:${GEM_HEX[gem]}"></i>${player.bonuses[gem]}</span>`)
          .join('');
        const reserved = player.reserved
          .map((cardId) =>
            cardId
              ? `<span class="sp-mini" title="${esc(CARD_BY_ID[cardId]?.prestige ? `${CARD_BY_ID[cardId]!.prestige} 分` : '0 分')}">${CARD_BY_ID[cardId]!.prestige || '·'}</span>`
              : `<span class="sp-mini back"></span>`,
          )
          .join('');
        const nobles = player.nobles
          .map((id) => `<span class="sp-mini" title="${esc(id)}">${NOBLE_BY_ID[id]?.prestige ?? 3}</span>`)
          .join('');
        const ownedCity = d.cities.find((city) => city.owner === player.id);
        const cityLabel = ownedCity
          ? `${CITY_BY_ID[ownedCity.tileId]?.name ?? ''} · ${CITY_BY_ID[ownedCity.tileId]?.sides[ownedCity.side].prestige ?? 0} 分`
          : '';
        return `<div class="sp-player ${isMe ? 'me' : ''} ${isActive ? 'active' : ''}">
          <div class="sp-player-head">
            <span class="sp-player-name"><i class="sp-seat-dot" style="background:${seatColor(d, player.id)}"></i>${esc(names[player.id] ?? player.id)}</span>
            ${isActive ? '<span class="sp-badge">行动中</span>' : ''}
            <span class="sp-score">${player.prestige}</span>
          </div>
          <div class="sp-chips">${chips || '<span class="sp-muted">没有指示物</span>'}</div>
          <div class="sp-line"><span class="sp-line-label">红利</span><div class="sp-bonuses">${bonuses || '<span class="sp-muted">—</span>'}</div></div>
          ${reserved ? `<div class="sp-line"><span class="sp-line-label">预留</span><div class="sp-reserved" title="预留${isMe ? '' : '（对手看不到牌面）'}">${reserved}</div></div>` : ''}
          ${nobles ? `<div class="sp-line"><span class="sp-line-label">贵族</span><div class="sp-reserved">${nobles}</div></div>` : ''}
          ${cityLabel ? `<div class="sp-city-owner">🏙️ ${esc(cityLabel)}</div>` : ''}
          ${d.expansions.includes('trading-posts') && player.seals.length ? `<div class="sp-seats">${'<span class="sp-seat on"></span>'.repeat(player.seals.length)}<span class="sp-muted">纹章 ${player.seals.length}/5</span></div>` : ''}
        </div>`;
      })
      .join('');

    const focus = focusCard ? CARD_BY_ID[focusCard] : null;
    const detail = focus
      ? (() => {
          const affordable = can('buy', (payload) => payload.cardId === focus.id);
          const position = boardPosition(focus.id);
          const reservable = Boolean(
            position &&
              can(
                'reserve',
                (payload) =>
                  payload.from === 'board' && payload.level === position.level && payload.index === position.index,
              ),
          );
          const place = can('placeStronghold', (payload) => payload.cardId === focus.id && !payload.from);
          const move = moves().find(
            (move) =>
              move.type === 'placeStronghold' &&
              (move.payload as { cardId?: string }).cardId === focus.id &&
              Boolean((move.payload as { from?: string }).from),
          );
          const remove = can('removeStronghold', (payload) => payload.cardId === focus.id);
          const reservedHere = d.players.find((player) => player.id === my)?.reserved.includes(focus.id) ?? false;
          return `<div class="sp-detail">
            <div class="sp-detail-card" style="border-color:${LEVEL_COLOR[String(focus.level) as '1' | '2' | '3']}">
              <div class="sp-card-top"><span class="sp-pts">${focus.prestige || ''}</span><span class="sp-bonus" style="background:${GEM_HEX[focus.bonus]}"></span></div>
              <div class="sp-cost">${cardCost(focus)}</div>
            </div>
            <div class="sp-detail-info">
              <div class="sp-muted">${LEVEL_NAME[String(focus.level) as '1' | '2' | '3']}${focus.prestige ? ` · ${focus.prestige} 分` : ' · 0 分'}${reservedHere ? ' · 你预留的' : ''}</div>
              <div class="sp-modal-row">
                <button class="sp-btn primary" data-act="buy" data-card="${focus.id}" ${affordable ? '' : 'disabled'}>买入</button>
                ${reservable ? `<button class="sp-btn" data-act="reserve" data-card="${focus.id}">预留</button>` : ''}
                ${place ? `<button class="sp-btn" data-act="stronghold" data-mode="place" data-card="${focus.id}">放置要塞</button>` : ''}
                ${move ? `<button class="sp-btn" data-act="stronghold" data-mode="move" data-from="${String((move.payload as { from?: string }).from)}" data-card="${focus.id}">移动要塞到此</button>` : ''}
                ${remove ? `<button class="sp-btn" data-act="stronghold" data-mode="remove" data-card="${focus.id}">移除对手要塞</button>` : ''}
                <button class="sp-btn" data-act="close">关闭</button>
              </div>
            </div>
          </div>`;
        })()
      : '';

    const hint = (() => {
      if (view.finished) return '';
      if (view.phase === 'discard') return `<div class="sp-hint warn">手上超过 10 个指示物，点自己面板里的指示物弃回。</div>`;
      if (view.phase === 'noble') return `<div class="sp-hint warn">满足多位贵族，点一张贵族选择拜访。</div>`;
      if (view.phase === 'city') return `<div class="sp-hint warn">同时满足多座城市，点一张城市板块拿走（只能拿一张）。</div>`;
      if (view.phase === 'seal') return `<div class="sp-hint warn">满足多条贸易之路能力，点一条占下纹章。</div>`;
      if (view.phase === 'stronghold') return `<div class="sp-hint warn">买完卡必须处理要塞：点一张正面朝上的牌放置/移动，或点对手要塞移除。</div>`;
      if (view.phase === 'conquest') return `<div class="sp-hint warn">三枚要塞压顶，可以立刻买下那张牌。</div>`;
      if (view.phase === 'deck-pick') return `<div class="sp-hint warn">贸易之路：从摸到的两张里挑一张预留。</div>`;
      if (view.phase === 'buy-gem') return `<div class="sp-hint warn">贸易之路能力：买卡后拿 1 个宝石，点宝石堆。</div>`;
      if (view.phase === 'extra-gem') return `<div class="sp-hint warn">贸易之路能力：拿 2 个同色后额外拿 1 个异色。</div>`;
      if (!active) return `<div class="sp-hint">等 ${esc(turnName ?? '对手')} 行动。</div>`;
      if (selected.length > 0) return `<div class="sp-hint">已选 ${selected.map((gem) => dot(gem)).join('')}：${takeConfirmed() ? '可以拿取' : '再选一个，或点同一颜色拿两个'}</div>`;
      return `<div class="sp-hint">点宝石拿取、点卡牌买入或预留。</div>`;
    })();

    const conquest = view.phase === 'conquest' && active
      ? `<div class="sp-modal"><div class="sp-modal-card">
          <h3>要塞控制</h3>
          <div class="sp-muted">你的三枚要塞压在同一张牌上，可以立刻买下它。</div>
          <div class="sp-modal-row">
            ${d.conquestTargets.map((cardId) => `<button class="sp-btn primary" data-act="conquest" data-card="${cardId}">买下 ${esc(CARD_BY_ID[cardId]?.prestige ? `${CARD_BY_ID[cardId]!.prestige} 分卡` : '这张卡')}</button>`).join('')}
            <button class="sp-btn" data-act="skip-conquest">跳过</button>
          </div>
        </div></div>`
      : '';

    const deckPick = view.phase === 'deck-pick' && active && d.pendingDeck.length > 0
      ? `<div class="sp-modal"><div class="sp-modal-card">
          <h3>牌堆二选一</h3>
          <div class="sp-muted">贸易之路：挑一张留下，另一张放回牌堆底。</div>
          <div class="sp-modal-row">
            ${d.pendingDeck
              .map((cardId) => {
                const card = CARD_BY_ID[cardId];
                if (!card) return '';
                return `<div class="sp-card" data-act="deck-card" data-card="${cardId}" style="border-color:${LEVEL_COLOR[String(card.level) as '1' | '2' | '3']}">
                  <div class="sp-card-top"><span class="sp-pts">${card.prestige || ''}</span><span class="sp-bonus" style="background:${GEM_HEX[card.bonus]}" title="${esc(COLOR_NAME[card.bonus])}"></span></div>
                  <div class="sp-card-mid"></div>
                  <div class="sp-cost">${cardCost(card)}</div>
                </div>`;
              })
              .join('')}
          </div>
        </div></div>`
      : '';

    const takeButton = `<button class="sp-btn primary" data-act="take" ${takeConfirmed() ? '' : 'disabled'}>拿取</button>`;

    const html = `<div class="sp-root">
      <div class="sp-top">
        <span class="sp-turn">${view.finished ? '对局结束' : `${esc(turnName ?? '—')} 的回合`}</span>
        <span class="sp-muted">第 ${view.round} 轮</span>
        ${d.endTriggered && !view.finished ? '<span class="sp-badge warn">本轮结束就结算</span>' : ''}
        ${badges}
        <span style="flex:1"></span>
        ${takeButton}
        <button class="sp-btn" data-act="clear" ${selected.length ? '' : 'disabled'}>清空</button>
      </div>
      <div class="sp-main">
        <div class="sp-board">${boardRows}</div>
        <div class="sp-side">
          <div class="sp-panel">
            <div class="sp-panel-title"><span>宝石堆</span><span>${selected.length ? `已选 ${selected.length}` : ''}</span></div>
            <div class="sp-gems">${supply}</div>
          </div>
          ${cityPanel}
          ${powers ? `<div class="sp-panel"><div class="sp-panel-title"><span>贸易之路</span><span>5 条能力</span></div><div style="display:flex;flex-direction:column;gap:6px">${powers}</div></div>` : ''}
        </div>
      </div>
      ${detail}
      ${hint}
      <div class="sp-players">${players}</div>
      ${conquest}
      ${deckPick}
    </div>`;

    const root = host.querySelector('.sp-root') as HTMLElement | null;
    if (root) root.outerHTML = html;
    else host.insertAdjacentHTML('beforeend', html);
  }

  function onRootClick(event: Event): void {
    const target = (event.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!target) return;
    const act = target.dataset.act;
    const view = snapshot?.view as PublicView | null;
    if (!view) return;

    if (act === 'gem') {
      const color = target.dataset.color as Gem;
      if (!myTurn() || view.phase !== 'turn') return;
      const d = data();
      if (!d || d.supply[color] <= 0) return;
      const count = selected.filter((item) => item === color).length;
      // 只能是「三个不同色」或「两个同色」，不能混
      if (selected.length >= 3) return;
      if (count >= 2) return;
      if (selected.length === 2 && selected[0] === selected[1]) return; // 已经拿了两个同色
      if (selected.length === 2 && count > 0) return; // 会变成 2+1 的混合
      selected = [...selected, color];
      render();
      return;
    }

    if (act === 'clear') {
      selected = [];
      render();
      return;
    }

    if (act === 'take') {
      if (!takeConfirmed()) return;
      if (selected.length === 3) context?.send({ type: 'take3', payload: { colors: [...selected] } });
      else context?.send({ type: 'take2', payload: { color: selected[0] } });
      selected = [];
      return;
    }

    if (act === 'card') {
      const cardId = target.dataset.card;
      if (!cardId) return;
      focusCard = focusCard === cardId ? null : cardId;
      render();
      return;
    }

    if (act === 'close') {
      focusCard = null;
      render();
      return;
    }

    if (act === 'buy') {
      const cardId = target.dataset.card;
      if (cardId) context?.send({ type: 'buy', payload: { cardId } });
      focusCard = null;
      return;
    }

    if (act === 'reserve') {
      const cardId = target.dataset.card;
      if (!cardId) return;
      const index = (['3', '2', '1'] as const)
        .flatMap((level) => (data()?.board[level] ?? []).map((id, index) => ({ level, id, index })))
        .find((item) => item.id === cardId);
      if (index) {
        context?.send({ type: 'reserve', payload: { from: 'board', level: index.level, index: index.index } });
      }
      focusCard = null;
      return;
    }

    if (act === 'stronghold') {
      const cardId = target.dataset.card;
      const mode = target.dataset.mode;
      if (!cardId) return;
      if (mode === 'remove') context?.send({ type: 'removeStronghold', payload: { cardId } });
      else if (mode === 'move') {
        const from = target.dataset.from;
        if (from) context?.send({ type: 'placeStronghold', payload: { cardId, from } });
      } else context?.send({ type: 'placeStronghold', payload: { cardId } });
      focusCard = null;
      return;
    }

    if (act === 'noble') {
      const nobleId = target.dataset.noble;
      if (nobleId) context?.send({ type: 'chooseNoble', payload: { nobleId } });
      return;
    }

    if (act === 'power') {
      const powerId = target.dataset.power;
      if (powerId) context?.send({ type: 'choosePower', payload: { powerId } });
      return;
    }

    if (act === 'city') {
      const key = target.dataset.key;
      if (key) context?.send({ type: 'chooseCity', payload: { key } });
      return;
    }

    if (act === 'discard') {
      const color = target.dataset.color as TokenColor;
      if (color) context?.send({ type: 'discardToken', payload: { color } });
      return;
    }

    if (act === 'deck-card') {
      const cardId = target.dataset.card;
      if (cardId) context?.send({ type: 'chooseDeckCard', payload: { cardId } });
      return;
    }

    if (act === 'conquest') {
      const cardId = target.dataset.card;
      if (cardId) context?.send({ type: 'buyConquest', payload: { cardId } });
      return;
    }

    if (act === 'skip-conquest') {
      context?.send({ type: 'skipConquest', payload: {} });
    }
  }

  return {
    mount(ctx) {
      context = ctx;
      names = Object.fromEntries(ctx.players.map((player) => [player.id, player.name]));
      let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.append(style);
      }
      style.textContent = CSS;
      ctx.root.addEventListener('click', onRootClick);
      render();
    },

    update(next) {
      snapshot = next;
      // 换人 / 换阶段时清掉旧选择，避免拿错
      const view = next.view as PublicView | null;
      if (!view || view.phase !== 'turn') selected = [];
      render();
    },

    unmount() {
      context?.root.removeEventListener('click', onRootClick);
      context = null;
      snapshot = null;
    },

    formatLog(entry: LogEntry): string | null {
      const args = (entry.args ?? {}) as Record<string, unknown>;
      const name = (id: unknown) => names[String(id)] ?? String(id);
      const colorName = (color: unknown) => COLOR_SHORT[String(color) as TokenColor] ?? String(color);
      switch (entry.key) {
        case 'sp.take3':
          return `${name(args.player)} 拿了 ${(args.colors as string[]).map(colorName).join('、')}`;
        case 'sp.take2':
          return `${name(args.player)} 拿了 2 个${colorName(args.color)}宝石`;
        case 'sp.extraGem':
          return `${name(args.player)} 用贸易之路额外拿了 1 个${colorName(args.color)}宝石`;
        case 'sp.buyGem':
          return `${name(args.player)} 买卡后拿了 1 个${colorName(args.color)}宝石`;
        case 'sp.deckPeek':
          return `${name(args.player)} 用贸易之路摸了两张牌堆顶的牌，二选一`;
        case 'sp.reserve':
          return `${name(args.player)} 预留了一张牌`;
        case 'sp.buy': {
          const card = CARD_BY_ID[String(args.card)];
          return `${name(args.player)} 买下 ${card ? colorName(card.bonus) + '色卡' : '一张牌'}${card?.prestige ? `（+${card.prestige} 分）` : ''}`;
        }
        case 'sp.conquestBuy': {
          const card = CARD_BY_ID[String(args.card)];
          return `${name(args.player)} 用在要塞压顶的牌上又买了一张${card?.prestige ? `（+${card.prestige} 分）` : ''}`;
        }
        case 'sp.noble':
          return `${name(args.player)} 请到一位贵族（+3 分）`;
        case 'sp.seal':
          return `${name(args.player)} 占下贸易之路「${String(args.name)}」`;
        case 'sp.city': {
          const tile = CITY_BY_ID[String(args.city)];
          return `${name(args.player)} 拿下了${tile?.name ?? '一座城市'}（${String(args.prestige)} 分）`;
        }
        case 'sp.strongholdPlace':
          return `${name(args.player)} 放置了一枚要塞`;
        case 'sp.strongholdRemove':
          return `${name(args.player)} 拆掉了对手一枚要塞`;
        case 'sp.discard':
          return `${name(args.player)} 弃回 1 个${colorName(args.color)}宝石`;
        case 'sp.pass':
          return `${name(args.player)} 无牌可拿，跳过`;
        case 'sp.gameEnd': {
          const ranking = args.ranking as string[] | undefined;
          const scores = (args.scores ?? {}) as Record<string, number>;
          return `对局结束：${(ranking ?? []).map(name).join('、')} 获胜（${(ranking ?? []).map((id) => scores[id]).join(' / ')} 分）`;
        }
        default:
          return null;
      }
    },
  };
}

/** 宿主直接拿这个实例的三件套（mount / update / unmount），和别的插件一致 */
const client = createSplendorClient();

export default client;
export { client };