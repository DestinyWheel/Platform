/**
 * 花砖物语 —— 前端。原生 DOM + 内联 CSS，无图片。
 */
import type { ClientSnapshot, GameClient, GameClientContext, LogEntry } from '@platform/sdk';
import { BLACK_ICON_PATHS } from './icons';
import {
  COLOR_NAME,
  COLORS,
  PROFILES,
  printedColor,
  type AzulColor,
  type AzulTile,
  type BoardProfile,
  type BoardProfileId,
  type FinalBonus,
} from './shared';

const STYLE_ID = 'azul-style';

const COLOR_HEX: Record<AzulColor, string> = {
  blue: '#2d5f9e',
  yellow: '#e8c34a',
  red: '#d05050',
  black: '#2a2f36',
  white: '#a9dbe0',
};

/** 灰墙/墙格上印的颜色要亮一点 */
const PRINT_STROKE: Record<AzulColor, string> = {
  blue: '#6d9dd6',
  yellow: '#e8c34a',
  red: '#e08383',
  black: '#8b98a7',
  white: '#5aa6b3',
};

const EXPANSION_NAME: Record<string, string> = {
  'crystal-mosaic-x2': '马赛克水晶 · ×2 面',
  'crystal-mosaic-mosaic': '马赛克水晶 · 新图案面',
  'joker-tiles': '百搭砖',
  'special-factories': '特殊工厂',
  'double-score-markers': '双倍标记',
};

const TILE_NAME: Record<string, string> = {
  blue: '蓝砖',
  yellow: '黄砖',
  red: '红砖',
  black: '黑砖',
  white: '白砖',
  joker: '百搭砖',
};

const JOKER_STAR_ORDER: AzulColor[] = ['blue', 'white', 'yellow', 'red', 'black'];
const JOKER_STAR_PATHS = [
  'M32 32 L24.95 22.29 L32 4 L39.05 22.29 Z',
  'M32 32 L39.05 22.29 L58.63 23.35 L43.41 35.71 Z',
  'M32 32 L43.41 35.71 L48.46 54.65 L32 44 Z',
  'M32 32 L32 44 L15.54 54.65 L20.59 35.71 Z',
  'M32 32 L20.59 35.71 L5.37 23.35 L24.95 22.29 Z',
];

let blackInkSeq = 0;

/** 每种颜色的砖面图案；fill 是砖块内挖掉/绘制的颜色 */
function colorIcon(color: AzulColor, fill: string, stroke = COLOR_HEX[color]): string {
  const round = `stroke-linejoin="round" stroke-linecap="round"`;
  const solid = `fill="${fill}" stroke="${stroke}" stroke-width="2" ${round}`;
  switch (color) {
    case 'blue':
      return `<polygon points="4,32 32,20 60,32 32,44" ${solid}/><polygon points="32,4 44,32 32,60 20,32" ${solid}/>`;
    case 'black': {
      const paths = BLACK_ICON_PATHS.map((d) => `<path d="${d}"/>`).join('');
      const transform = 'translate(2 13) scale(0.142857)';
      if (fill === '#fff') {
        blackInkSeq += 1;
        const id = `az-black-${blackInkSeq}`;
        return `<defs>
            <mask id="${id}-ink"><rect width="64" height="64" fill="#fff"/><g fill="#000" stroke="#000" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" transform="${transform}">${paths}</g></mask>
            <clipPath id="${id}-area"><circle cx="32" cy="32" r="18.2"/><ellipse cx="32" cy="32" rx="29" ry="6.8"/></clipPath>
          </defs>
          <rect width="64" height="64" fill="#fff" mask="url(#${id}-ink)" clip-path="url(#${id}-area)"/>
          <g fill="none" stroke="${stroke}" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" transform="${transform}">${paths}</g>`;
      }
      const body = fill === 'none' ? 'none' : stroke;
      return `<g fill="${body}" stroke="${stroke}" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" transform="${transform}">${paths}</g>`;
    }
    case 'red':
      return `<g transform="translate(32,32) scale(1.35) translate(-32,-32)">
        <path d="M 35 13 L 26 22 L 26 33 L 36 42 L 36 53 L 45 44 L 45 33 L 35 24 Z" fill="${fill}" stroke="${stroke}" stroke-width="1.55" ${round}/>
        <path d="M 22 33 L 18 37 L 18 43 L 23 47 L 23 53 L 27 49 L 27 43 L 22 39 Z" fill="${fill}" stroke="${stroke}" stroke-width="1.55" ${round}/>
      </g>`;
    case 'white': {
      const arm = `<polygon points="32,2 38,10 32,18 26,10" ${solid}/><path d="M 32,28.5 L 22,12 L 32,20 L 42,12 Z" ${solid}/>`;
      return `<g>${[0, 60, 120, 180, 240, 300]
        .map((angle) => `<g transform="rotate(${angle} 32 32)">${arm}</g>`)
        .join('')}<circle cx="32" cy="32" r="3.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/></g>`;
    }
    default:
      return `<polygon points="32,4 38,22 52,12 42,26 60,32 42,38 52,52 38,42 32,60 26,42 12,52 22,38 4,32 22,26 12,12 26,22" ${solid}/><circle cx="32" cy="32" r="6" fill="${stroke}" stroke="${stroke}" stroke-width="2"/>`;
  }
}

function jokerStar(): string {
  return JOKER_STAR_PATHS.map(
    (d, index) =>
      `<path d="${d}" fill="none" stroke="${COLOR_HEX[JOKER_STAR_ORDER[index]!]}" stroke-width="2.2" stroke-linejoin="round"/>`,
  ).join('');
}

function svgIcon(inner: string, extra = ''): string {
  return `<svg class="az-ico${extra}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}

function tileHtml(tile: AzulTile, cls = 'az-tile'): string {
  if (tile === 'joker') {
    return `<span class="${cls} az-tile-joker">${svgIcon(jokerStar())}</span>`;
  }
  return `<span class="${cls}" style="background:${COLOR_HEX[tile]}">${svgIcon(
    colorIcon(tile, '#fff'),
  )}</span>`;
}

function printHtml(color: AzulColor, cls = ''): string {
  return svgIcon(colorIcon(color, 'none', PRINT_STROKE[color]), ` az-print ${cls}`.trim());
}

const CSS = `
.az-root { display:flex; flex-direction:column; gap:10px; color:#e6edf3; min-width:0; }
.az-top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:9px 12px; border:1px solid #262d38; border-radius:12px; background:rgba(22,27,34,.72); }
.az-round { font-weight:700; }
.az-muted { color:#8b98a7; font-size:12px; }
.az-chip { border:1px solid #2c3745; border-radius:999px; padding:2px 8px; font-size:11px; color:#c3ccd8; }
.az-status { margin-left:auto; color:#c3ccd8; font-size:12px; }
.az-status.mine { color:#8db6ff; font-weight:650; }
.az-supply { border:1px solid #262d38; border-radius:12px; background:rgba(20,25,32,.82); padding:10px; display:flex; flex-direction:column; gap:10px; }
.az-factories { display:grid; grid-template-columns:repeat(auto-fit,minmax(100px,1fr)); gap:8px; }
.az-factory { border:1px solid #2c3745; border-radius:12px; background:rgba(22,27,34,.7); padding:8px; display:flex; flex-direction:column; gap:6px; align-items:center; min-width:0; }
.az-factory.special { border-color:#6a5a3a; }
.az-factory-type { font-size:10px; color:#c9b27a; letter-spacing:.04em; }
.az-factory-type.normal { color:#6f7c8d; }
.az-factory-grid { display:grid; grid-template-columns:1fr 1fr; gap:4px; }
.az-factory-slot { width:30px; height:30px; border-radius:50%; border:1px dashed #2c3745; display:flex; align-items:center; justify-content:center; }
.az-tile-btn { border:none; background:none; padding:0; cursor:pointer; border-radius:50%; line-height:0; }
.az-tile-btn:disabled { cursor:default; }
.az-tile-btn.selected { box-shadow:0 0 0 2px #4c8dff; border-radius:50%; }
.az-center { border-top:1px dashed #2c3745; padding-top:8px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.az-double { display:flex; gap:5px; flex-wrap:wrap; align-items:center; }
.az-double .used { opacity:.22; filter:grayscale(1); }
.az-double-item { display:inline-flex; align-items:center; gap:2px; font-size:10px; color:#c9b27a; }
.az-center-title { font-size:11px; color:#8b98a7; margin-right:4px; }
.az-group { display:inline-flex; align-items:center; gap:4px; border:1px solid #2c3745; border-radius:999px; padding:3px 7px 3px 4px; background:#1a212b; color:#e6edf3; cursor:pointer; }
.az-group.selected { border-color:#4c8dff; box-shadow:0 0 0 1px rgba(76,141,255,.4); }
.az-group:disabled { opacity:.55; cursor:default; }
.az-count { font-size:12px; color:#c3ccd8; }
.az-marker { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:50%; background:radial-gradient(circle at 35% 30%,#f5df9a,#c89b3c); color:#4a3410; font-weight:800; font-size:12px; border:1px solid #8d6b24; }
.az-marker.big { width:26px; height:26px; font-size:15px; }
.az-tile { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:50%; flex:none; overflow:hidden; box-shadow: inset 0 -2px 4px rgba(0,0,0,.28), inset 0 1px 1px rgba(255,255,255,.22), 0 1px 2px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.18); }
.az-tile .az-ico { width:82%; height:82%; }
.az-tile-joker { background:#3b3324; }
.az-tile-joker .az-ico { width:92%; height:92%; }
.az-tile.mini { width:22px; height:22px; }
.az-tile.tiny { width:19px; height:19px; }
.az-ico { display:block; }
.az-print { width:82%; height:82%; opacity:.32; }
.az-hint { border:1px dashed #2c3745; border-radius:10px; padding:7px 9px; color:#aab6c4; font-size:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.az-hint .active { color:#8db6ff; font-weight:650; }
.az-btn { display:inline-flex; align-items:center; justify-content:center; gap:5px; line-height:1.2; padding:5px 10px; border-radius:8px; border:1px solid #2c3745; background:#1a212b; color:#e6edf3; cursor:pointer; font-size:12px; }
.az-btn:hover { border-color:#4c8dff; }
.az-btn.primary { background:linear-gradient(180deg,#4c8dff,#3a72d8); border-color:transparent; font-weight:650; }
.az-btn:disabled { opacity:.4; cursor:default; }
.az-btns { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.az-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:10px; }
.az-card { border:1px solid #262d38; border-radius:12px; background:rgba(20,25,32,.82); padding:10px; display:flex; flex-direction:column; gap:8px; min-width:0; }
.az-card.active { border-color:#4c8dff; box-shadow:0 0 0 1px rgba(76,141,255,.28); }
.az-card.me { background:rgba(24,32,44,.9); }
.az-card-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.az-name { font-weight:650; }
.az-score { font-size:18px; font-weight:750; margin-left:auto; }
.az-board { display:flex; gap:12px; align-items:flex-start; justify-content:center; min-width:0; }
.az-patterns { display:flex; flex-direction:column; gap:2px; flex:none; min-width:0; }
.az-prow { display:flex; justify-content:flex-end; align-items:center; gap:3px; height:21px; border-radius:7px; padding:0 2px; }
.az-prow.target { background:rgba(76,141,255,.12); outline:1px dashed #4c8dff; cursor:pointer; }
.az-prow.dead { opacity:.45; }
.az-slot { width:19px; height:19px; border-radius:50%; border:1px dashed #2c3745; display:flex; align-items:center; justify-content:center; }
.az-slot .az-tile { width:19px; height:19px; }
.az-wall { display:grid; grid-template-columns:repeat(5,21px); gap:2px; flex:none; }
.az-wall-cell { width:21px; height:21px; border-radius:4px; border:1px solid #2c3745; background:#151a21; display:flex; align-items:center; justify-content:center; position:relative; }
.az-wall-cell.free { background:#1b2027; }
.az-wall-cell.locked { border-color:rgba(255,255,255,.16); }
.az-wall-cell.filled { border-color:rgba(0,0,0,.45); }
.az-wall-cell.target { outline:1px solid #4c8dff; outline-offset:1px; }
.az-wall-cell .az-tile { width:19px; height:19px; }
.az-wall-cell .az-print { width:82%; height:82%; }
.az-x2 { position:absolute; right:1px; bottom:0; font-size:8px; font-weight:800; color:#f5df9a; text-shadow:0 0 2px #000; pointer-events:none; }
.az-floor { display:flex; gap:3px; align-items:center; justify-content:center; border-top:1px dashed #2c3745; padding-top:5px; }
.az-floor-slot { width:23px; height:25px; border-radius:5px; border:1px solid #2c3745; display:flex; flex-direction:column; align-items:center; justify-content:center; position:relative; color:#6f7c8d; font-size:9px; }
.az-floor-slot.filled { border-color:rgba(255,255,255,.15); }
.az-floor-slot.target { outline:1px solid #4c8dff; cursor:pointer; }
.az-floor-slot .az-tile { width:18px; height:18px; }
.az-floor.target { outline:1px dashed #4c8dff; outline-offset:2px; border-radius:8px; background:rgba(76,141,255,.08); cursor:pointer; }
.az-penalty { position:absolute; bottom:0; right:1px; font-size:8px; }
.az-tiling { border:1px solid #6a5a3a; border-radius:12px; background:rgba(45,38,24,.75); padding:9px 11px; display:flex; flex-direction:column; gap:7px; }
.az-tiling-title { color:#f0d9a0; font-size:13px; font-weight:650; }
.az-final { border:1px solid #3a4a63; border-radius:12px; background:rgba(24,32,44,.9); padding:12px; display:flex; flex-direction:column; gap:8px; }
.az-final h3 { margin:0; font-size:15px; }
.az-final-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:13px; }
.az-final-row .win { color:#f5df9a; font-weight:700; }
.az-final small { color:#8b98a7; font-size:11px; }
@media (max-width:900px) {
  .az-cards { grid-template-columns:1fr; }
  .az-board { gap:8px; }
}
@media (max-width:560px) {
  .az-wall { grid-template-columns:repeat(5,20px); }
  .az-patterns { flex:none; }
}
`;

interface BoardView {
  id: string;
  patterns: AzulTile[][];
  wall: (AzulColor | 'joker' | null)[][];
  floor: (AzulTile | 'marker')[];
  score: number;
  usedDouble: boolean;
}

interface TilingView {
  player: string;
  line: number;
  tile: AzulTile;
  color: AzulColor | null;
  joker: boolean;
  columns: number[];
  doubleColumns: number[];
  x2Columns: number[];
}

interface AzulViewData {
  expansions: string[];
  profile: BoardProfileId;
  factories: { type: 'normal' | 'stay' | 'shift'; tiles: AzulTile[] }[];
  center: AzulTile[];
  bagCount: number;
  lidCount: number;
  markerInCenter: boolean;
  starter: string | null;
  firstPlayer: string | null;
  doubleMarkers: AzulColor[];
  tiling: TilingView | null;
  players: BoardView[];
  finalBonuses: Record<string, FinalBonus> | null;
  endReason: 'row' | 'exhausted' | null;
}

interface Selection {
  factory: number | null;
  color: AzulColor | null;
  includeJokers: boolean;
  shift: Record<string, 'left' | 'right'>;
}

let context: GameClientContext | null = null;
let snapshot: ClientSnapshot | null = null;
let root: HTMLElement | null = null;
let selection: Selection | null = null;
let lastTurn: string | null = null;
let lastPhase = '';

function ensureStyle(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = CSS;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function data(): AzulViewData | null {
  if (!snapshot?.view) return null;
  return snapshot.view.data as unknown as AzulViewData;
}

function profile(data: AzulViewData): BoardProfile {
  return PROFILES[data.profile] ?? PROFILES.base;
}

function nameOf(id: string): string {
  return context?.players.find((player) => player.id === id)?.name ?? id;
}

function meIsPlayer(data: AzulViewData): boolean {
  return Boolean(context && data.players.some((player) => player.id === context!.me));
}

function isMyTurn(data: AzulViewData): boolean {
  return meIsPlayer(data) && snapshot?.view?.turn === context?.me && !snapshot?.view?.finished;
}

function hasMove(predicate: (payload: Record<string, unknown>) => boolean): boolean {
  return (snapshot?.legalMoves ?? []).some((move) => {
    if (move.type !== 'takeTiles') return false;
    return predicate((move.payload ?? {}) as Record<string, unknown>);
  });
}

function selectionPayloadMatches(
  payload: Record<string, unknown>,
  sel: Selection,
  line: number,
): boolean {
  if (payload.factory !== sel.factory) return false;
  if ((payload.color ?? null) !== sel.color) return false;
  if (Boolean(payload.includeJokers) !== sel.includeJokers) return false;
  if ((payload.line ?? 0) !== line) return false;
  const shift = (payload.shift ?? {}) as Record<string, 'left' | 'right'>;
  const shiftKeys = Object.keys(shift);
  if (shiftKeys.length !== Object.keys(sel.shift).length) return false;
  return shiftKeys.every((key) => shift[key] === sel.shift[key]);
}

function canPlace(line: number): boolean {
  if (!selection) return false;
  return hasMove((payload) => selectionPayloadMatches(payload, selection!, line));
}

function sourceTiles(data: AzulViewData, sel: Selection): AzulTile[] {
  return sel.factory === null ? data.center : data.factories[sel.factory]?.tiles ?? [];
}

function selectedTiles(data: AzulViewData, sel: Selection): AzulTile[] {
  return sourceTiles(data, sel).filter(
    (tile) =>
      (sel.color !== null && tile === sel.color) ||
      (sel.color === null && tile === 'joker') ||
      (sel.color !== null && sel.includeJokers && tile === 'joker'),
  );
}

function leftoverGroups(data: AzulViewData, sel: Selection): string[] {
  const taken = selectedTiles(data, sel);
  const remaining = [...sourceTiles(data, sel)];
  for (const tile of taken) {
    const index = remaining.indexOf(tile);
    if (index >= 0) remaining.splice(index, 1);
  }
  return [...new Set(remaining)];
}

function factoryHasJoker(data: AzulViewData, factory: number | null): boolean {
  return sourceTiles(data, { factory, color: null, includeJokers: false, shift: {} }).includes(
    'joker',
  );
}

function makeSelection(data: AzulViewData, factory: number | null, color: AzulColor | null): Selection {
  const includeJokers = color !== null && factoryHasJoker(data, factory);
  const sel: Selection = { factory, color, includeJokers, shift: {} };
  const groups = leftoverGroups(data, sel);
  if (factory !== null && data.factories[factory]!.type === 'shift') {
    for (const group of groups) sel.shift[group] = 'left';
  }
  return sel;
}

function tileLabel(tile: AzulTile): string {
  return TILE_NAME[tile] ?? tile;
}

function selectionCount(data: AzulViewData): number {
  return selection ? selectedTiles(data, selection).length : 0;
}

function renderTiling(data: AzulViewData): string {
  if (!data.tiling) return '';
  const tiling = data.tiling;
  const isMine = tiling.player === context?.me;
  const title = `上墙：第 ${tiling.line + 1} 行 · ${tileLabel(tiling.tile)}`;
  if (!isMine) {
    return `<div class="az-tiling"><div class="az-tiling-title">${title}</div><div class="az-muted">等待 ${esc(nameOf(tiling.player))} 选择位置</div></div>`;
  }
  const buttons: string[] = [];
  for (const col of tiling.columns) {
    const label = tiling.columns.length === 1 ? '上墙' : `第 ${col + 1} 列`;
    buttons.push(
      `<button class="az-btn primary" data-act="wall" data-line="${tiling.line}" data-col="${col}">${label}</button>`,
    );
    if (tiling.doubleColumns.includes(col)) {
      buttons.push(
        `<button class="az-btn" data-act="wall" data-line="${tiling.line}" data-col="${col}" data-double="1">×2 ${tiling.columns.length === 1 ? '上墙' : `第 ${col + 1} 列`}</button>`,
      );
    }
  }
  return `<div class="az-tiling">
    <div class="az-tiling-title">${title}</div>
    <div class="az-btns">${buttons.join('')}</div>
    <div class="az-muted">${tiling.joker ? '百搭砖不会触发 ×2，也不计同色奖励。' : '灰色空格按横/竖不重复同色选择；预印格只能放对应颜色。'}</div>
  </div>`;
}

function renderTop(data: AzulViewData): string {
  const current = snapshot?.view?.turn ? nameOf(snapshot.view.turn) : null;
  const expansionChips = data.expansions
    .map((id) => `<span class="az-chip">${esc(EXPANSION_NAME[id] ?? id)}</span>`)
    .join('');
  const status = snapshot?.view?.finished
    ? '对局结束'
    : data.tiling
      ? data.tiling.player === context?.me
        ? `上墙决策：选择第 ${data.tiling.line + 1} 行的位置`
        : `等待 ${nameOf(data.tiling.player)} 上墙`
      : isMyTurn(data)
        ? selection
          ? `已选 ${selectionCount(data)} 块${selection.color ? COLOR_NAME[selection.color] : selection.color === null ? '百搭' : ''}砖，点击目标`
          : '轮到你了：选择工厂或中央的砖'
        : current
          ? `等待 ${current}`
          : '等待中';
  return `<div class="az-top">
    <span class="az-round">第 ${data ? snapshot?.view?.round : 1} 轮</span>
    <span class="az-chip">袋 ${data.bagCount}</span>
    <span class="az-chip">弃砖 ${data.lidCount}</span>
    <span class="az-chip">先手 ${data.firstPlayer ? esc(nameOf(data.firstPlayer)) : '—'}</span>
    ${data.markerInCenter ? '<span class="az-marker" title="首玩家标记在中央">1</span>' : ''}
    ${expansionChips}
    <span class="az-status ${isMyTurn(data) ? 'mine' : ''}">${esc(status)}</span>
  </div>`;
}

function renderFactory(data: AzulViewData, factoryIndex: number): string {
  const factory = data.factories[factoryIndex]!;
  const typeLabel =
    factory.type === 'stay' ? '留盘工厂' : factory.type === 'shift' ? '分拣工厂' : '工厂';
  const canPick = isMyTurn(data) && !data.tiling;
  const slots: string[] = [];
  // 分拣工厂可能收到其他工厂的余砖，数量可以超过 4
  const slotCount = Math.max(4, factory.tiles.length);
  for (let index = 0; index < slotCount; index += 1) {
    const tile = factory.tiles[index];
    if (!tile) {
      slots.push('<span class="az-factory-slot"></span>');
      continue;
    }
    const selected =
      selection?.factory === factoryIndex &&
      ((selection.color === null && tile === 'joker') ||
        (selection.color !== null && tile === selection.color));
    slots.push(
      `<button class="az-tile-btn ${selected ? 'selected' : ''}" data-act="source" data-src="factory" data-factory="${factoryIndex}" data-color="${tile === 'joker' ? 'joker' : tile}" ${canPick ? '' : 'disabled'} aria-label="${tileLabel(tile)}">${tileHtml(tile)}</button>`,
    );
  }
  return `<div class="az-factory ${factory.type === 'normal' ? '' : 'special'}">
    <div class="az-factory-type ${factory.type === 'normal' ? 'normal' : ''}">${typeLabel}</div>
    <div class="az-factory-grid">${slots.join('')}</div>
  </div>`;
}

function centerGroups(data: AzulViewData): string {
  const groups: string[] = [];
  for (const color of COLORS) {
    const count = data.center.filter((tile) => tile === color).length;
    if (count === 0) continue;
    const selected = selection?.factory === null && selection.color === color;
    groups.push(
      `<button class="az-group ${selected ? 'selected' : ''}" data-act="source" data-src="center" data-color="${color}" ${isMyTurn(data) && !data.tiling ? '' : 'disabled'}>${tileHtml(color, 'az-tile mini')}<span class="az-count">×${count}</span></button>`,
    );
  }
  const jokers = data.center.filter((tile) => tile === 'joker').length;
  if (jokers > 0) {
    const selected = selection?.factory === null && selection.color === null;
    groups.push(
      `<button class="az-group ${selected ? 'selected' : ''}" data-act="source" data-src="center" data-color="joker" ${isMyTurn(data) && !data.tiling ? '' : 'disabled'}>${tileHtml('joker', 'az-tile mini')}<span class="az-count">×${jokers}</span></button>`,
    );
  }
  return groups.length > 0
    ? groups.join('')
    : '<span class="az-muted">中央已空</span>';
}

function renderSupply(data: AzulViewData): string {
  return `<div class="az-supply">
    <div class="az-factories">${data.factories.map((_factory, index) => renderFactory(data, index)).join('')}</div>
    <div class="az-center">
      <span class="az-center-title">中央</span>
      ${centerGroups(data)}
      ${data.markerInCenter ? '<span class="az-marker big" title="本轮第一个从中央拿砖的人拿走">1</span>' : ''}
      ${
        data.expansions.includes('double-score-markers')
          ? `<span class="az-center-title" style="margin-left:auto">双倍标记</span>
             <span class="az-double">${COLORS.map((color) => {
               const available = data.doubleMarkers.includes(color);
               return `<span class="az-double-item ${available ? '' : 'used'}" title="${available ? '可用' : '已被拿走'}">${tileHtml(color, 'az-tile mini')}<span>×2</span></span>`;
             }).join('')}</span>`
          : ''
      }
    </div>
  </div>`;
}

function selectionHint(data: AzulViewData): string {
  if (!selection) {
    if (data.tiling) return '';
    return `<div class="az-hint">${isMyTurn(data) ? '选择一家工厂或中央的砖。' : '等待当前玩家行动。'}</div>`;
  }
  const source = selection.factory === null ? '中央' : `工厂 ${selection.factory + 1}`;
  const colorName = selection.color ? COLOR_NAME[selection.color] : '百搭';
  const jokers = factoryHasJoker(data, selection.factory);
  const groups = leftoverGroups(data, selection);
  const shift =
    selection.factory !== null && data.factories[selection.factory]!.type === 'shift' && groups.length > 0
      ? `<span class="az-muted">余砖：</span>${groups
          .map(
            (group) =>
              `<span class="az-chip">${tileLabel(group as AzulTile)}</span><span class="az-btns">${(['left', 'right'] as const)
                .map(
                  (direction) =>
                    `<button class="az-btn ${selection!.shift[group] === direction ? 'primary' : ''}" data-act="shift" data-group="${group}" data-direction="${direction}">${direction === 'left' ? '←左' : '右→'}</button>`,
                )
                .join('')}</span>`,
          )
          .join('')}`
      : '';
  const jokerToggle =
    selection.color !== null && jokers
      ? `<button class="az-btn ${selection.includeJokers ? 'primary' : ''}" data-act="include">${selection.includeJokers ? '同时拿' : '不拿'}百搭砖</button>`
      : '';
  return `<div class="az-hint">
    <span class="active">${esc(source)} · ${colorName} · ${selectionCount(data)} 块</span>
    ${jokerToggle}
    ${shift}
    <button class="az-btn" data-act="cancel">取消</button>
  </div>`;
}

function renderPatterns(data: AzulViewData, board: BoardView, mine: boolean): string {
  return board.patterns
    .map((pattern, line) => {
      const capacity = line + 1;
      const target = mine && selection && canPlace(line);
      const dead = mine && selection && !target;
      const cells: string[] = [];
      const offset = capacity - pattern.length;
      for (let index = 0; index < capacity; index += 1) {
        const tile = pattern[index - offset];
        cells.push(
          tile
            ? `<span class="az-slot">${tileHtml(tile, 'az-tile')}</span>`
            : '<span class="az-slot"></span>',
        );
      }
      return `<div class="az-prow ${target ? 'target' : ''} ${dead ? 'dead' : ''}" ${
        target ? `data-act="line" data-line="${line}"` : ''
      }>${cells.join('')}</div>`;
    })
    .join('');
}

function renderWall(data: AzulViewData, board: BoardView, mine: boolean): string {
  const profileDef = profile(data);
  const cells: string[] = [];
  const tiling = data.tiling && data.tiling.player === board.id ? data.tiling : null;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const placed = board.wall[row]![col];
      const printed = printedColor(profileDef, row, col);
      const x2 = profileDef.x2[row]![col];
      const target = mine && tiling && tiling.line === row && tiling.columns.includes(col);
      if (placed) {
        cells.push(
          `<div class="az-wall-cell filled ${target ? 'target' : ''}">${tileHtml(placed, 'az-tile tiny')}${x2 && placed !== 'joker' ? '<span class="az-x2">×2</span>' : ''}</div>`,
        );
      } else if (printed) {
        cells.push(
          `<div class="az-wall-cell locked ${target ? 'target' : ''}">${printHtml(printed)}${x2 ? '<span class="az-x2">×2</span>' : ''}</div>`,
        );
      } else {
        cells.push(`<div class="az-wall-cell free ${target ? 'target' : ''}"></div>`);
      }
    }
  }
  return `<div class="az-wall">${cells.join('')}</div>`;
}

function renderFloor(data: AzulViewData, board: BoardView, mine: boolean): string {
  const target = mine && selection && canPlace(-1);
  const slots: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const item = board.floor[index];
    const penalty = profile(data).floor[index] ?? 0;
    if (item === 'marker') {
      slots.push(`<div class="az-floor-slot filled"><span class="az-marker">1</span><span class="az-penalty">${penalty}</span></div>`);
    } else if (item) {
      slots.push(
        `<div class="az-floor-slot filled">${tileHtml(item, 'az-tile tiny')}<span class="az-penalty">${penalty}</span></div>`,
      );
    } else {
      slots.push(
        `<div class="az-floor-slot"><span class="az-penalty">${penalty}</span></div>`,
      );
    }
  }
  return `<div class="az-floor ${target ? 'target' : ''}" ${target ? 'data-act="line" data-line="-1"' : ''}>${slots.join('')}</div>`;
}

function renderCard(data: AzulViewData, board: BoardView): string {
  const mine = board.id === context?.me;
  const active = snapshot?.view?.turn === board.id && !snapshot?.view?.finished;
  const marker = data.firstPlayer === board.id;
  return `<div class="az-card ${active ? 'active' : ''} ${mine ? 'me' : ''}">
    <div class="az-card-head">
      <span class="az-name">${esc(nameOf(board.id))}${mine ? '（你）' : ''}</span>
      ${marker ? '<span class="az-marker" title="先手标记持有者">1</span>' : ''}
      ${board.usedDouble ? '<span class="az-chip">已用 ×2</span>' : ''}
      <span class="az-score">${board.score}</span>
    </div>
    <div class="az-board">
      <div class="az-patterns">${renderPatterns(data, board, mine)}</div>
      ${renderWall(data, board, mine)}
    </div>
    ${renderFloor(data, board, mine)}
  </div>`;
}

function renderFinal(data: AzulViewData): string {
  if (!snapshot?.view?.finished) return '';
  const ranking = snapshot.view.ranking ?? [];
  const winners = ranking[0] ?? [];
  const rows: string[] = [];
  ranking.forEach((group, groupIndex) => {
    for (const player of group) {
      const board = data.players.find((item) => item.id === player);
      const bonus = data.finalBonuses?.[player];
      rows.push(`<div class="az-final-row">
        <span>${groupIndex + 1}.</span>
        <span class="${groupIndex === 0 ? 'win' : ''}">${esc(nameOf(player))}</span>
        <span>${board?.score ?? 0} 分</span>
        ${bonus ? `<small>横 ${bonus.rows}×${profile(data).final.row} · 竖 ${bonus.columns}×${profile(data).final.column} · 同色 ${bonus.colors}×${profile(data).final.color} = +${bonus.total}</small>` : ''}
      </div>`);
    }
  });
  return `<div class="az-final">
    <h3>对局结束 · ${winners.length > 1 ? '并列获胜' : '获胜'}：${winners.map((id) => esc(nameOf(id))).join('、')}</h3>
    ${rows.join('')}
    <small>${data.endReason === 'exhausted' ? '砖块耗尽，提前结算。' : '有人完成横排，按终局奖励结算。'}</small>
  </div>`;
}

function render(): void {
  if (!root) return;
  const dataValue = data();
  const view = snapshot?.view;
  if (!dataValue || !view) {
    root.innerHTML = '<div class="az-root"><div class="az-hint">等待开局…</div></div>';
    return;
  }
  const finished = view.finished === true;
  root.innerHTML = `<div class="az-root">
    ${renderTop(dataValue)}
    ${finished ? renderFinal(dataValue) : renderSupply(dataValue)}
    ${finished ? '' : renderTiling(dataValue)}
    ${finished ? '' : selectionHint(dataValue)}
    <div class="az-cards">${dataValue.players.map((board) => renderCard(dataValue, board)).join('')}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

function onClick(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!target || !context || !snapshot) return;
  const dataValue = data();
  if (!dataValue) return;
  const act = target.dataset.act;

  if (act === 'cancel') {
    selection = null;
    render();
    return;
  }
  if (act === 'include') {
    if (!selection) return;
    selection = {
      ...selection,
      includeJokers: !selection.includeJokers,
    };
    selection.shift = {};
    const groups = leftoverGroups(dataValue, selection);
    if (selection.factory !== null && dataValue.factories[selection.factory]!.type === 'shift') {
      for (const group of groups) selection.shift[group] = 'left';
    }
    render();
    return;
  }
  if (act === 'shift') {
    if (!selection) return;
    const group = target.dataset.group!;
    const direction = target.dataset.direction as 'left' | 'right';
    selection = { ...selection, shift: { ...selection.shift, [group]: direction } };
    render();
    return;
  }
  if (act === 'source') {
    if (!isMyTurn(dataValue) || dataValue.tiling) return;
    const factory =
      target.dataset.src === 'center' ? null : Number(target.dataset.factory ?? -1);
    const color = target.dataset.color === 'joker' ? null : (target.dataset.color as AzulColor);
    const next = makeSelection(dataValue, factory, color);
    const same =
      selection &&
      selection.factory === factory &&
      selection.color === color &&
      selection.includeJokers === next.includeJokers;
    selection = same ? null : next;
    render();
    return;
  }
  if (act === 'line') {
    if (!selection) return;
    const line = Number(target.dataset.line);
    if (!canPlace(line)) return;
    context.send({
      type: 'takeTiles',
      payload: {
        factory: selection.factory,
        color: selection.color,
        ...(selection.includeJokers ? { includeJokers: true } : {}),
        line,
        ...(Object.keys(selection.shift).length > 0 ? { shift: selection.shift } : {}),
      },
    });
    selection = null;
    render();
    return;
  }
  if (act === 'wall') {
    if (!dataValue.tiling || dataValue.tiling.player !== context.me) return;
    const line = Number(target.dataset.line);
    const col = Number(target.dataset.col);
    context.send({
      type: 'placeWall',
      payload: {
        line,
        col,
        ...(target.dataset.double === '1' ? { useDouble: true } : {}),
      },
    });
    render();
  }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

function mount(next: GameClientContext): void {
  ensureStyle();
  context = next;
  root = document.createElement('div');
  next.root.replaceChildren(root);
  next.root.addEventListener('click', onClick);
  render();
}

function update(next: ClientSnapshot): void {
  snapshot = next;
  const phase = next.view?.phase ?? '';
  const turn = next.view?.turn ?? null;
  if (phase !== lastPhase || turn !== lastTurn) {
    selection = null;
    lastPhase = phase;
    lastTurn = turn;
  }
  render();
}

function unmount(): void {
  context?.root.removeEventListener('click', onClick);
  root?.remove();
  root = null;
  context = null;
  snapshot = null;
  selection = null;
}

function formatLog(entry: LogEntry): string | null {
  const args = (entry.args ?? {}) as Record<string, unknown>;
  const player = typeof args.player === 'string' ? nameOf(args.player) : '有人';
  const color = typeof args.color === 'string' ? args.color : '';
  const colorName = TILE_NAME[color] ?? color;
  switch (entry.key) {
    case 'az.take': {
      const source = args.factory === null ? '中央' : `工厂 ${Number(args.factory) + 1}`;
      const target = Number(args.line) < 0 ? '地面线' : `第 ${Number(args.line) + 1} 行`;
      const joker = args.jokers ? ' + 百搭' : '';
      return `${player} 从${source}拿了 ${Number(args.count)} 块${colorName}${joker}，放进${target}`;
    }
    case 'az.marker':
      return `${player} 拿到先手标记（进地面线）`;
    case 'az.place':
      return `${player} 上墙${args.joker ? '百搭' : colorName} +${Number(args.points)} 分${args.doubled ? '（×2）' : ''}`;
    case 'az.blocked':
      return `${player} 第 ${Number(args.line) + 1} 行没有合法墙格，${Number(args.count)} 块砖进地面线`;
    case 'az.floor':
      return `${player} 地面线 ${Number(args.penalty)} 分，总分 ${Number(args.score)}`;
    case 'az.round':
      return `第 ${Number(args.round)} 轮开始`;
    case 'az.finalScore':
      return `${player} 终局奖励 +${Number(args.bonus)}（横 ${Number(args.rows)} / 竖 ${Number(args.columns)} / 同色 ${Number(args.colors)}），总分 ${Number(args.score)}`;
    case 'az.gameEnd': {
      const ranking = Array.isArray(args.ranking) ? (args.ranking as string[][]) : [];
      const winners = (ranking[0] ?? []).map((id) => nameOf(id)).join('、');
      return `对局结束${winners ? `，${winners} 获胜` : ''}`;
    }
    default:
      return null;
  }
}

const client: GameClient = { mount, update, unmount, formatLog };
export default client;
export { client };
