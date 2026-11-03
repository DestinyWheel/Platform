/**
 * 花砖物语：对决 —— 前端。原生 DOM + 内联 CSS，无图片。
 */
import type { ClientSnapshot, GameClient, GameClientContext, LogEntry } from '@platform/sdk';
import { BLACK_ICON_PATHS } from './icons';
import {
  CHIP_BY_ID,
  CHIP_COLOR_NAME,
  COLOR_NAME,
  PLATE_BY_ID,
  rotatedCells,
  type AzulColor,
  type PlateCell,
  type ScoringGoal,
} from './plates';

const STYLE_ID = 'azul-duel-style';

const COLOR_HEX: Record<AzulColor, string> = {
  navy: '#2d5f9e',
  turquoise: '#4fb7b0',
  yellow: '#e8c34a',
  red: '#d05050',
  black: '#2a2f36',
};

/** 穹顶板上印的空格：深色底上用亮一点的颜色才看得清 */
const PRINT_STROKE: Record<AzulColor, string> = {
  navy: '#6d9dd6',
  turquoise: '#6fd6cf',
  yellow: '#e8c34a',
  red: '#e08383',
  black: '#8b98a7',
};

const PAPER_BG = '#f3ead8';

type TileKind = AzulColor | 'special';

/** 白色镂空图案：fill 是砖块里挖掉的部分，stroke 默认和砖块同色 */
function colorIcon(color: AzulColor, fill: string, stroke = COLOR_HEX[color]): string {
  const round = `stroke-linejoin="round" stroke-linecap="round"`;
  const solid = `fill="${fill}" stroke="${stroke}" stroke-width="2" ${round}`;
  switch (color) {
    case 'navy':
      return `<polygon points="4,32 32,20 60,32 32,44" ${solid}/><polygon points="32,4 44,32 32,60 20,32" ${solid}/>`;
    case 'black': {
      const paths = BLACK_ICON_PATHS.map((d) => `<path d="${d}"/>`).join('');
      const transform = 'translate(2 13) scale(0.142857)';
      if (fill === '#fff') {
        // 黑砖：保留原始线稿，白色按线稿挖出（两个半圆 + 空心飞盘），不带外围白圆
        blackInkSeq += 1;
        const id = `ad-black-${blackInkSeq}`;
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
    case 'turquoise': {
      const arm = `<polygon points="32,2 38,10 32,18 26,10" ${solid}/><path d="M 32,28.5 L 22,12 L 32,20 L 42,12 Z" ${solid}/>`;
      return `<g>${[0, 60, 120, 180, 240, 300]
        .map((angle) => `<g transform="rotate(${angle} 32 32)">${arm}</g>`)
        .join('')}<circle cx="32" cy="32" r="3.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/></g>`;
    }
    default:
      return `<polygon points="32,4 38,22 52,12 42,26 60,32 42,38 52,52 38,42 32,60 26,42 12,52 22,38 4,32 22,26 12,12 26,22" ${solid}/><circle cx="32" cy="32" r="6" fill="${stroke}" stroke="${stroke}" stroke-width="2"/>`;
  }
}

const SPECIAL_RING = (stroke: string) =>
  `<circle cx="32" cy="32" r="21" fill="none" stroke="${stroke}" stroke-width="6"/>`;

/** 万能图案：五角星线稿，一个角一种颜色 */
const JOKER_STAR_ORDER: AzulColor[] = ['navy', 'turquoise', 'yellow', 'red', 'black'];
const JOKER_STAR_PATHS = [
  'M32 32 L24.95 22.29 L32 4 L39.05 22.29 Z',
  'M32 32 L39.05 22.29 L58.63 23.35 L43.41 35.71 Z',
  'M32 32 L43.41 35.71 L48.46 54.65 L32 44 Z',
  'M32 32 L32 44 L15.54 54.65 L20.59 35.71 Z',
  'M32 32 L20.59 35.71 L5.37 23.35 L24.95 22.29 Z',
];

function jokerStar(colors: Record<AzulColor, string> = COLOR_HEX): string {
  return JOKER_STAR_PATHS.map(
    (d, index) =>
      `<path d="${d}" fill="none" stroke="${colors[JOKER_STAR_ORDER[index]!]}" stroke-width="2" stroke-linejoin="round"/>`,
  ).join('');
}

function svgIcon(inner: string, extra = ''): string {
  return `<svg class="ad-ico${extra}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}

function tileHtml(kind: TileKind, cls = 'ad-tile'): string {
  if (kind === 'special') {
    return `<span class="${cls} ad-tile-special">${svgIcon(SPECIAL_RING('#fff'))}</span>`;
  }
  return `<span class="${cls}" style="background:${COLOR_HEX[kind]}">${svgIcon(
    colorIcon(kind, '#fff'),
  )}</span>`;
}

const CSS = `
.ad-root { display: flex; flex-direction: column; gap: 12px; color: #e6edf3; }
.ad-topbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 14px; border: 1px solid #262d38; border-radius: 12px; background: rgba(22,27,34,.72); }
.ad-turn { font-weight: 700; }
.ad-muted { color: #8b98a7; font-size: 12px; }
.ad-badge { border: 1px solid #2c3745; border-radius: 999px; padding: 2px 8px; font-size: 11px; color: #c3ccd8; }
.ad-panel { border: 1px solid #262d38; border-radius: 12px; background: rgba(20,25,32,.82); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.ad-panel.me { border-color: #4c8dff; box-shadow: 0 0 0 1px rgba(76,141,255,.28); }
.ad-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ad-score { font-size: 18px; font-weight: 750; }
.ad-start { color: #d8c07a; font-weight: 700; }
.ad-factories { display: flex; gap: 10px; flex-wrap: wrap; }
.ad-factory { border: 1px solid #2c3745; border-radius: 12px; padding: 8px; background: rgba(22,27,34,.7); display: flex; flex-direction: column; gap: 6px; min-width: 106px; }
.ad-factory.large { border-color: #7a6ac0; min-width: 150px; }
.ad-factory-title { font-size: 12px; color: #8b98a7; display: flex; justify-content: space-between; gap: 8px; }
.ad-dots { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; min-height: 20px; }
.ad-tile { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; flex: none; overflow: hidden; box-shadow: inset 0 -2px 4px rgba(0,0,0,.28), inset 0 1px 1px rgba(255,255,255,.22), 0 1px 2px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.18); }
.ad-tile .ad-ico { width: 82%; height: 82%; }
.ad-tile-special { background: #d9c9a3; }
.ad-ico { display: block; }
.ad-dot { width: 22px; height: 22px; }
.ad-moon { border-top: 1px dashed #2c3745; padding-top: 5px; display: flex; gap: 4px; flex-wrap: wrap; }
.ad-chip { width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(0,0,0,.4); display: inline-flex; overflow: hidden; vertical-align: middle; flex: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.16); }
.ad-chip-half { position: relative; width: 50%; height: 100%; overflow: hidden; }
.ad-chip-art { position: absolute; top: 0; width: 30px; height: 30px; }
.ad-chip-half.left .ad-chip-art { left: 0; }
.ad-chip-half.right .ad-chip-art { right: 0; }
.ad-chip-art .ad-ico { width: 100%; height: 100%; }
.ad-chip.back { background: repeating-linear-gradient(90deg, #2a3342, #2a3342 4px, #364153 4px, #364153 8px); }
.ad-plates { display: flex; gap: 10px; flex-wrap: wrap; }
.ad-plate { width: 76px; display: flex; flex-direction: column; gap: 4px; align-items: center; cursor: pointer; border: 1px solid transparent; border-radius: 10px; padding: 4px; }
.ad-plate:hover { border-color: #4c8dff; }
.ad-plate-back { display: flex; flex-direction: column; align-items: center; gap: 4px; background: none; border: 1px solid transparent; border-radius: 10px; padding: 4px; color: #e6edf3; cursor: pointer; }
.ad-plate-back:hover { border-color: #4c8dff; }
.ad-plate-back:disabled { cursor: default; opacity: .8; }
.ad-plate-stack { position: relative; width: 64px; height: 64px; margin: 5px 4px 3px; }
.ad-plate-stack::before, .ad-plate-stack::after { content: ''; position: absolute; inset: 0; border-radius: 8px; background: #26313e; border: 1px solid #4a5a70; }
.ad-plate-stack::before { transform: translate(4px, -4px) rotate(3deg); }
.ad-plate-stack::after { transform: translate(-3px, 2px) rotate(-3deg); }
.ad-plate-back-card { position: absolute; inset: 0; z-index: 1; border-radius: 8px; border: 1px solid rgba(0,0,0,.3); background: #f3ead8; display: flex; align-items: center; justify-content: center; box-shadow: 0 3px 8px rgba(0,0,0,.45); overflow: hidden; }
.ad-plate-back-card .ad-ico { width: 82%; height: 82%; }
.ad-plate-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; width: 64px; }
.ad-plate-cell { width: 31px; height: 31px; border-radius: 4px; border: 1px solid rgba(0,0,0,.22); background: #f3ead8; display: flex; align-items: center; justify-content: center; }
.ad-plate-cell .ad-ico { width: 88%; height: 88%; }
.ad-plate-cell .ad-ico-big { width: 100%; height: 100%; }
.ad-plate-cell.special { background: #efe0c0; }
.ad-patterns { display: flex; flex-direction: column; gap: 4px; }
.ad-line { display: flex; align-items: center; gap: 6px; }
.ad-line-label { width: 18px; color: #8b98a7; font-size: 11px; }
.ad-line-cells { display: flex; gap: 3px; }
.ad-cell { width: 24px; height: 24px; border-radius: 50%; border: 1px dashed #2c3745; display: flex; align-items: center; justify-content: center; }
.ad-cell.filled { border: none; overflow: hidden; }
.ad-cell.filled .ad-ico { width: 86%; height: 86%; }
.ad-dome { display: grid; grid-template-columns: repeat(6, 32px); gap: 2px; }
.ad-dome-cell { width: 32px; height: 32px; border-radius: 6px; border: 1px solid #2c3745; background: #151a21; display: flex; align-items: center; justify-content: center; }
.ad-dome-cell.colored { border-color: rgba(255,255,255,.14); }
.ad-dome-cell.tile { border-color: rgba(0,0,0,.45); box-shadow: inset 0 0 0 1px rgba(255,255,255,.16); }
.ad-dome-cell .ad-print { width: 86%; height: 86%; opacity: .85; }
.ad-dome-tile { width: 26px; height: 26px; }
.ad-broken { display: flex; gap: 4px; flex-wrap: wrap; min-height: 20px; }
.ad-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ad-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; line-height: 1.2; padding: 6px 11px; border-radius: 8px; border: 1px solid #2c3745; background: #1a212b; color: #e6edf3; cursor: pointer; font-size: 12px; }
.ad-btn:hover { border-color: #4c8dff; }
.ad-btn.primary { background: linear-gradient(180deg, #4c8dff, #3a72d8); border-color: transparent; font-weight: 650; }
.ad-btn:disabled { opacity: .4; cursor: default; }
.ad-hint { border: 1px dashed #2c3745; border-radius: 10px; padding: 7px 9px; color: #aab6c4; font-size: 12px; }
.ad-panel-line { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.ad-side { display: flex; flex-direction: column; gap: 10px; }
.ad-slots { display: grid; grid-template-columns: repeat(3, 42px); gap: 6px; }
.ad-slot { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 8px; border: 1px solid #2c3745; background: #151a21; color: #e6edf3; cursor: pointer; font-size: 11px; }
.ad-slot:disabled { opacity: .35; cursor: default; }
.ad-modal { position: absolute; inset: 0; background: rgba(6,9,13,.75); display: flex; align-items: center; justify-content: center; z-index: 8; padding: 16px; }
.ad-modal-card { width: min(560px, 100%); border: 1px solid #3a4656; border-radius: 16px; background: #121821; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ad-modal h3 { margin: 0; font-size: 16px; }
.ad-mini { display: flex; gap: 6px; flex-wrap: wrap; }
`;

interface PlatePlacement {
  plateId: string;
  rotation: number;
}
interface PlayerView {
  id: string;
  patterns: AzulColor[][];
  plates: (PlatePlacement | null)[];
  dome: (AzulColor | 'special' | null)[];
  broken: AzulColor[];
  chips: string[];
  usedChips: string[];
  score: number;
  tokensUsed: number;
  chipsTaken: number;
}
interface SmallFactoryView {
  sun: AzulColor[];
  moon: AzulColor[];
  chipPresent: boolean;
  chipRevealed: boolean;
  chipId: string | null;
}
interface AdData {
  round: number;
  bagCount: number;
  towerCount: number;
  platePileCount: number;
  platePileTopKind: 'joker' | 'special' | null;
  plateDisplay: string[];
  specialTiles: number;
  startTile: string;
  startingPlayer: string;
  setupPicks: number;
  factories: {
    small: SmallFactoryView[];
    large: { sun: AzulColor[]; moon: (AzulColor | null)[] };
  };
  chipSupplyCount: number;
  players: PlayerView[];
  scoringGoals: ScoringGoal[];
  tilingDone: Record<string, boolean>;
  lastRound: { round: number; scores: Record<string, number> } | null;
}

let root: HTMLElement | null = null;
let context: GameClientContext | null = null;
let snapshot: ClientSnapshot | null = null;
let selectedPlate: { kind: 'setup' | 'take' | 'draw'; plateId?: string; rotation: number } | null = null;
let selectedTiles: { factory: number; mode: 'sun' | 'moon'; color: AzulColor } | null = null;
let selectedTilingLine: number | null = null;
let lastPhase = '';
let lastTurn = '';
let blackInkSeq = 0;

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

function dataOf(): AdData | null {
  return (snapshot?.view?.data as unknown as AdData | undefined) ?? null;
}

function meId(): string | null {
  if (!snapshot?.view) return null;
  return snapshot.view.players.includes(context?.me ?? '') ? context!.me : null;
}

function isMyTurn(): boolean {
  const view = snapshot?.view;
  const me = meId();
  return !!view && !!me && view.turn === me && !view.finished;
}

function playerOf(id: string): PlayerView | null {
  return dataOf()?.players.find((player) => player.id === id) ?? null;
}

function dot(color: AzulColor): string {
  return `<span class="ad-tile ad-dot" title="${COLOR_NAME[color]}" style="background:${
    COLOR_HEX[color]
  }">${svgIcon(colorIcon(color, '#fff'))}</span>`;
}

function plateCellHtml(color: PlateCell): string {
  if (color === 'joker') {
    return `<span class="ad-plate-cell">${svgIcon(jokerStar(), ' ad-ico-big')}</span>`;
  }
  if (color === 'special') {
    return `<span class="ad-plate-cell special">${svgIcon(
      SPECIAL_RING('#8a6a2f'),
      ' ad-ico-big',
    )}</span>`;
  }
  return `<span class="ad-plate-cell">${svgIcon(colorIcon(color, PAPER_BG))}</span>`;
}

function platePreview(plateId: string | null, rotation: number): string {
  if (!plateId) {
    return '<div class="ad-plate-grid"><span class="ad-plate-cell" style="font-size:22px;font-weight:700;color:#6b5a3a">?</span></div>';
  }
  const plate = PLATE_BY_ID[plateId];
  if (!plate) return '';
  const cells = rotatedCells(plate, rotation);
  return `<div class="ad-plate-grid">${cells.map((cell) => plateCellHtml(cell)).join('')}</div>`;
}

function chipHalf(color: AzulColor | 'white', side: 'left' | 'right'): string {
  if (color === 'white') {
    // 奖励片里的白色半块改用特殊砖：石色底 + 白圈
    return `<span class="ad-chip-half ${side}" style="background:#d9c9a3"><span class="ad-chip-art">${svgIcon(
      SPECIAL_RING('#fff'),
    )}</span></span>`;
  }
  return `<span class="ad-chip-half ${side}" style="background:${COLOR_HEX[color]}"><span class="ad-chip-art">${svgIcon(
    colorIcon(color, '#fff'),
  )}</span></span>`;
}

function chipHtml(chipId: string | null, back = false): string {
  if (!chipId) return '<span class="ad-chip back" title="未翻开的奖励片"></span>';
  const chip = CHIP_BY_ID[chipId];
  if (!chip) return '<span class="ad-chip back"></span>';
  // 红色永远占右半块
  const left = chip.a === 'red' ? chip.b : chip.a;
  const right = chip.a === 'red' ? chip.a : chip.b;
  return `<span class="ad-chip" title="${CHIP_COLOR_NAME[chip.a]} / ${CHIP_COLOR_NAME[chip.b]}">${chipHalf(
    left,
    'left',
  )}${chipHalf(right, 'right')}</span>`;
}

function cellColorOf(player: PlayerView, row: number, col: number): PlateCell | null {
  const slot = Math.floor(row / 2) * 3 + Math.floor(col / 2);
  const placed = player.plates[slot];
  if (!placed) return null;
  const plate = PLATE_BY_ID[placed.plateId];
  if (!plate) return null;
  return rotatedCells(plate, placed.rotation)[(row % 2) * 2 + (col % 2)] ?? null;
}

function renderPatterns(player: PlayerView): string {
  return `<div class="ad-patterns">${player.patterns
    .map((line, index) => {
      const capacity = index + 1;
      const cells = Array.from({ length: capacity }, (_, slot) => {
        const color = line[slot];
        return color
          ? `<span class="ad-cell filled ad-tile" title="${COLOR_NAME[color]}" style="background:${COLOR_HEX[color]}">${svgIcon(colorIcon(color, '#fff'))}</span>`
          : '<span class="ad-cell"></span>';
      }).join('');
      return `<div class="ad-line"><span class="ad-line-label">${index + 1}</span><span class="ad-line-cells">${cells}</span></div>`;
    })
    .join('')}</div>`;
}

function renderDome(player: PlayerView): string {
  const cells: string[] = [];
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const base = cellColorOf(player, row, col);
      const tile = player.dome[row * 6 + col];
      const classes = ['ad-dome-cell'];
      let style = '';
      let inner = '';
      let title = '';
      if (base) classes.push('colored');

      if (tile === 'special') {
        classes.push('tile');
        inner = tileHtml('special', 'ad-tile ad-dome-tile');
        title = '特殊砖';
      } else if (tile) {
        classes.push('tile');
        inner = tileHtml(tile, 'ad-tile ad-dome-tile');
        title = COLOR_NAME[tile];
      } else if (base === 'special') {
        classes.push('print-special');
        inner = svgIcon(SPECIAL_RING('#b89b62'), ' ad-ico ad-print');
        title = '特殊格';
      } else if (base === 'joker') {
        classes.push('print-joker');
        inner = svgIcon(jokerStar(PRINT_STROKE), ' ad-ico ad-print');
        title = '万能格';
      } else if (base) {
        inner = svgIcon(colorIcon(base, 'none', PRINT_STROKE[base]), ' ad-ico ad-print');
        title = `${COLOR_NAME[base]}格`;
      }

      cells.push(
        `<span class="${classes.join(' ')}" style="${style}"${title ? ` title="${title}"` : ''}>${inner}</span>`,
      );
    }
  }
  return `<div class="ad-dome">${cells.join('')}</div>`;
}

function renderPlayerPanel(player: PlayerView, isMe: boolean): string {
  const chips = player.chips.map((chipId) => chipHtml(chipId)).join('');
  const used = player.usedChips.length ? `<span class="ad-muted">已用 ${player.usedChips.length}</span>` : '';
  return `<div class="ad-panel${isMe ? ' me' : ''}">
    <div class="ad-head">
      <span class="ad-score">${nameOf(player.id)}${isMe ? '（你）' : ''}</span>
      <span class="ad-score">${player.score} 分</span>
      <span class="ad-badge">棋子 ${player.tokensUsed}/2</span>
      <span class="ad-badge">奖励片 ${player.chipsTaken}/2</span>
    </div>
    <div class="ad-panel-line">
      <div>${renderPatterns(player)}</div>
      <div>${renderDome(player)}</div>
    </div>
    <div class="ad-btns">${chips || '<span class="ad-muted">没有奖励片</span>'}${used}</div>
    <div class="ad-btns"><span class="ad-muted">破损区</span><div class="ad-broken">${
      player.broken.map((color) => dot(color)).join('') || '<span class="ad-muted">空</span>'
    }</div></div>
  </div>`;
}

function hasMove(type: string, predicate?: (payload: Record<string, unknown>) => boolean): boolean {
  return (snapshot?.legalMoves ?? []).some((move) => {
    if (move.type !== type) return false;
    if (!predicate) return true;
    return predicate((move.payload ?? {}) as Record<string, unknown>);
  });
}

function renderFactories(data: AdData): string {
  const parts: string[] = [];
  data.factories.small.forEach((factory, index) => {
    const colors = [...new Set(factory.sun)];
    const sunButtons = colors
      .map((color) => {
        const can = hasMove('takeTiles', (payload) => payload.factory === index && payload.mode === 'sun' && payload.color === color);
        return `<button class="ad-btn" data-act="sun" data-factory="${index}" data-color="${color}" ${
          can ? '' : 'disabled'
        }>${dot(color)} 太阳</button>`;
      })
      .join('');
    const moonTop = factory.moon[factory.moon.length - 1];
    parts.push(`<div class="ad-factory">
      <div class="ad-factory-title"><span>小工厂 ${index + 1}</span><span>${factory.moon.length} 月亮</span></div>
      <div class="ad-dots">${factory.sun.map((color) => dot(color)).join('') || '<span class="ad-muted">空</span>'}</div>
      <div class="ad-moon">${factory.moon.map((color) => dot(color)).join('') || '<span class="ad-muted">—</span>'}</div>
      <div class="ad-btns">${
        moonTop
          ? `<button class="ad-btn" data-act="moon" data-color="${moonTop}" ${
              hasMove('takeTiles', (payload) => payload.mode === 'moon' && payload.color === moonTop) ? '' : 'disabled'
            }>拿月亮顶部 ${COLOR_NAME[moonTop]}</button>`
          : ''
      }</div>
      <div class="ad-btns">${
        factory.chipRevealed
          ? `<button class="ad-btn" data-act="bonus" data-factory="${index}" ${
              hasMove('takeBonus', (payload) => payload.factory === index) ? '' : 'disabled'
            }>拿奖励片 ${chipHtml(factory.chipId)}</button>`
          : `${chipHtml(null, true)} <span class="ad-muted">未翻开</span>`
      }</div>
      <div class="ad-btns">${sunButtons}</div>
    </div>`);
  });

  const large = data.factories.large;
  const largeColors = [...new Set(large.sun)];
  const largeButtons = largeColors
    .map((color) => {
      const can = hasMove('takeTiles', (payload) => payload.factory === 4 && payload.mode === 'sun' && payload.color === color);
      return `<button class="ad-btn" data-act="sun" data-factory="4" data-color="${color}" ${
        can ? '' : 'disabled'
      }>${dot(color)} 太阳</button>`;
    })
    .join('');
  const largeMoonColors = [...new Set(large.moon.filter((tile): tile is AzulColor => tile != null))];
  parts.push(`<div class="ad-factory large">
    <div class="ad-factory-title"><span>大工厂</span><span class="ad-start" title="先手砖">① ${data.startTile === 'factory' ? '工厂' : nameOf(data.startTile)}</span></div>
    <div class="ad-dots">${large.sun.map((color) => dot(color)).join('') || '<span class="ad-muted">空</span>'}</div>
    <div class="ad-moon">${large.moon.map((color) => (color ? dot(color) : '<span class="ad-muted">·</span>')).join('')}</div>
    <div class="ad-btns">${
      largeMoonColors
        .map(
          (color) =>
            `<button class="ad-btn" data-act="moon" data-color="${color}" ${
              hasMove('takeTiles', (payload) => payload.mode === 'moon' && payload.color === color) ? '' : 'disabled'
            }>拿月亮 ${COLOR_NAME[color]}</button>`,
        )
        .join('') || ''
    }</div>
    <div class="ad-btns">${largeButtons}</div>
  </div>`);
  return `<div class="ad-factories">${parts.join('')}</div>`;
}

function renderPlayActions(data: AdData): string {
  if (!isMyTurn() || !snapshot?.view) return '<div class="ad-muted">等对手行动…</div>';
  const view = snapshot.view;
  const me = playerOf(meId() ?? '');
  if (!me) return '<div class="ad-muted">你在观战</div>';

  if (view.phase === 'setup') {
    return `<div class="ad-hint">选一块穹顶板，旋转后放到自己的穹顶空位。${
      data.setupPicks === 0 ? '（你先选）' : '（对手已选，轮到你）'
    }</div>`;
  }

  if (view.phase === 'tiling') {
    const completes = me.patterns
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => line.length === index + 1)
      .map(({ index }) => index);
    const placeButtons = completes
      .filter((line) => hasMove('placeDomeTile', (payload) => payload.line === line))
      .map(
        (line) =>
          `<button class="ad-btn primary" data-act="tiling-line" data-line="${line}">铺第 ${line + 1} 行</button>`,
      )
      .join('');
    const bonusButtons = me.patterns
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => line.length > 0 && line.length < index + 1)
      .filter(({ index }) => hasMove('spendBonus', (payload) => payload.line === index))
      .map(
        ({ index }) =>
          `<button class="ad-btn" data-act="spend-bonus" data-line="${index}">奖励片补第 ${index + 1} 行</button>`,
      )
      .join('');
    const end = hasMove('endTiling')
      ? '<button class="ad-btn primary" data-act="end-tiling">结束铺砖</button>'
      : '';
    return `<div class="ad-panel"><div class="ad-hint">铺砖阶段：先放完整的图案行，或用奖励片补完；放完再结束。</div>
      <div class="ad-btns">${placeButtons}${bonusButtons}${end || '<span class="ad-muted">先把能铺的完整行铺掉</span>'}</div></div>`;
  }

  if (view.phase !== 'playing') return '';

  const canDraw = hasMove('drawPlate');
  const canPlate = hasMove('takePlate');
  const pass = hasMove('pass');
  return `<div class="ad-panel">
    <div class="ad-hint">${
      data.round >= 5 ? '第五轮：不用玩家棋子，只能拿砖和奖励片。' : `棋子 ${me.tokensUsed}/2；点工厂太阳/月亮取砖，或拿穹顶板。`
    }</div>
    <div class="ad-btns">
      ${canDraw ? '<button class="ad-btn" data-act="draw-start">抽背面板（-1 分）</button>' : ''}
      ${canPlate ? '<span class="ad-badge">点展示区的板拿取</span>' : ''}
      ${pass ? '<button class="ad-btn" data-act="pass">跳过</button>' : ''}
    </div>
  </div>`;
}

function renderPlateDisplay(data: AdData): string {
  const plates = data.plateDisplay
    .map((plateId) => {
      const can = hasMove('takePlate', (payload) => payload.plateId === plateId) || hasMove('placeSetupPlate', (payload) => payload.plateId === plateId);
      return `<button class="ad-btn" data-act="plate" data-plate="${plateId}" ${can ? '' : 'disabled'} style="display:flex;flex-direction:column;gap:4px;align-items:center;background:transparent;border-color:transparent">${platePreview(
        plateId,
        0,
      )}</button>`;
    })
    .join('');
  const kind = data.platePileTopKind;
  const pile = kind
    ? `<button class="ad-plate-back" data-act="draw-start" title="背面板堆顶上是 ${kind}，可以花 1 分抽" ${
        hasMove('drawPlate') ? '' : 'disabled'
      }>
        <span class="ad-plate-stack"><span class="ad-plate-back-card">${
          kind === 'joker'
            ? svgIcon(jokerStar(), ' ad-ico-big')
            : svgIcon(SPECIAL_RING('#8a6a2f'), ' ad-ico-big')
        }</span></span>
        <span class="ad-muted">背面 ×${data.platePileCount}</span>
        <span class="ad-badge">${kind === 'joker' ? '万能板' : '特殊板'}</span>
      </button>`
    : `<span class="ad-muted">背面板堆已空</span>`;
  return `<div class="ad-panel"><div class="ad-head"><span class="ad-muted">穹顶板展示</span><span class="ad-muted">板堆顶上的背面会显示类型</span></div><div class="ad-plates">${
    plates || '<span class="ad-muted">展示区空了</span>'
  }${pile}</div></div>`;
}

function renderSelection(data: AdData): string {
  if (selectedPlate) {
    const slots = Array.from({ length: 9 }, (_, slot) => {
      const occupied = !!playerOf(meId() ?? '')?.plates[slot];
      return `<button class="ad-slot" data-act="slot" data-slot="${slot}" ${occupied ? 'disabled' : ''}>${
        occupied ? '×' : slot + 1
      }</button>`;
    }).join('');
    return `<div class="ad-modal"><div class="ad-modal-card">
      <h3>${selectedPlate.kind === 'setup' ? '开局选板' : selectedPlate.kind === 'draw' ? '抽背面板' : '拿穹顶板'}</h3>
      <div class="ad-panel-line">${platePreview(selectedPlate.plateId ?? null, selectedPlate.rotation)}<div class="ad-slots">${slots}</div></div>
      <div class="ad-btns">
        <button class="ad-btn" data-act="rotate" data-delta="-1">逆时针</button>
        <button class="ad-btn" data-act="rotate" data-delta="1">顺时针</button>
        <button class="ad-btn" data-act="cancel">取消</button>
      </div>
    </div></div>`;
  }

  if (selectedTiles) {
    const tiles = selectedTiles;
    const me = playerOf(meId() ?? '');
    if (!me) return '';
    const buttons = Array.from({ length: 6 }, (_, line) => {
      const color = tiles.color;
      const capacity = line + 1;
      const current = me.patterns[line]!;
      const fits = current.length === 0 || current[0] === color;
      const label = `${line + 1} 行 ${current.length}/${capacity}${fits ? '' : ' · 会破损'}`;
      return `<button class="ad-btn" data-act="line" data-line="${line}">${label}</button>`;
    }).join('');
    return `<div class="ad-modal"><div class="ad-modal-card">
      <h3>把 ${COLOR_NAME[selectedTiles.color]} 砖放进哪条图案行？</h3>
      <div class="ad-muted">同一条图案行只能放一种颜色；放不下的进破损区。</div>
      <div class="ad-btns">${buttons}</div>
      <div class="ad-btns"><button class="ad-btn" data-act="cancel">取消</button></div>
    </div></div>`;
  }

  if (selectedTilingLine != null) {
    const line = selectedTilingLine;
    const cells = (snapshot?.legalMoves ?? [])
      .filter((move) => move.type === 'placeDomeTile')
      .map((move) => move.payload as { line?: number; row?: number; col?: number } | undefined)
      .filter((payload) => payload?.line === line)
      .map(
        (payload) =>
          `<button class="ad-btn primary" data-act="place-cell" data-line="${line}" data-col="${payload!.col}">第 ${(payload!.col ?? 0) + 1} 列</button>`,
      )
      .join('');
    return `<div class="ad-modal"><div class="ad-modal-card">
      <h3>铺第 ${line + 1} 行</h3>
      <div class="ad-muted">选一个同色或万能格。</div>
      <div class="ad-btns">${cells || '<span class="ad-muted">没有可放的格子</span>'}</div>
      <div class="ad-btns"><button class="ad-btn" data-act="cancel">取消</button></div>
    </div></div>`;
  }

  return '';
}

function render(): void {
  if (!root || !context) return;
  const view = snapshot?.view;
  if (!view) {
    root.innerHTML = '<div class="ad-muted">等待对局开始…</div>';
    return;
  }
  const data = dataOf();
  if (!data) {
    root.innerHTML = '<div class="ad-muted">等待牌桌数据…</div>';
    return;
  }
  const me = meId();
  const opponents = view.players.filter((id) => id !== me);
  const myBoard = me ? playerOf(me) : null;
  const phaseName: Record<string, string> = {
    setup: '选板',
    playing: '抢砖',
    tiling: '铺砖',
    finished: '结束',
  };
  const lastRound = data.lastRound
    ? `<span class="ad-badge">上轮 ${Object.entries(data.lastRound.scores)
        .map(([id, score]) => `${nameOf(id)} ${score}`)
        .join(' · ')}</span>`
    : '';

  root.innerHTML = `<div class="ad-root">
    <div class="ad-topbar">
      <span class="ad-turn">${view.finished ? '对局结束' : `${nameOf(view.turn ?? '')} 的回合`}</span>
      <span class="ad-badge">第 ${data.round} / 5 轮</span>
      <span class="ad-badge">${phaseName[view.phase] ?? view.phase}</span>
      <span class="ad-muted">特殊砖 ${data.specialTiles}</span>
      ${lastRound}
      ${me ? '' : '<span class="ad-badge">观战 / 回放</span>'}
    </div>
    ${opponents.map((id) => (playerOf(id) ? renderPlayerPanel(playerOf(id)!, false) : '')).join('')}
    <div class="ad-side">
      ${renderFactories(data)}
      ${renderPlateDisplay(data)}
      ${renderPlayActions(data)}
    </div>
    ${myBoard ? renderPlayerPanel(myBoard, true) : ''}
    ${renderSelection(data)}
  </div>`;
}

function onClick(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!target || !context) return;
  const act = target.dataset.act;
  if (!act) return;

  if (act === 'plate') {
    const plateId = target.dataset.plate;
    if (!plateId) return;
    const data = dataOf();
    if (!data) return;
    if (snapshot?.view?.phase === 'setup') {
      selectedPlate = { kind: 'setup', plateId, rotation: 0 };
    } else {
      selectedPlate = { kind: 'take', plateId, rotation: 0 };
    }
  } else if (act === 'draw-start') {
    selectedPlate = { kind: 'draw', rotation: 0 };
  } else if (act === 'rotate') {
    if (selectedPlate) {
      const delta = Number(target.dataset.delta ?? 0);
      selectedPlate = { ...selectedPlate, rotation: (selectedPlate.rotation + delta + 4) % 4 };
    }
  } else if (act === 'slot') {
    if (!selectedPlate) return;
    const slot = Number(target.dataset.slot);
    if (!Number.isFinite(slot)) return;
    if (selectedPlate.kind === 'setup' && selectedPlate.plateId) {
      context.send({
        type: 'placeSetupPlate',
        payload: { plateId: selectedPlate.plateId, rotation: selectedPlate.rotation, slot },
      });
    } else if (selectedPlate.kind === 'take' && selectedPlate.plateId) {
      context.send({
        type: 'takePlate',
        payload: { plateId: selectedPlate.plateId, rotation: selectedPlate.rotation, slot },
      });
    } else if (selectedPlate.kind === 'draw') {
      context.send({
        type: 'drawPlate',
        payload: { rotation: selectedPlate.rotation, slot },
      });
    }
    selectedPlate = null;
  } else if (act === 'sun') {
    const factory = Number(target.dataset.factory);
    const color = target.dataset.color as AzulColor | undefined;
    if (Number.isFinite(factory) && color) selectedTiles = { factory, mode: 'sun', color };
  } else if (act === 'moon') {
    const color = target.dataset.color as AzulColor | undefined;
    if (color) selectedTiles = { factory: 0, mode: 'moon', color };
  } else if (act === 'line') {
    if (!selectedTiles) return;
    const line = Number(target.dataset.line);
    if (!Number.isFinite(line)) return;
    context.send({
      type: 'takeTiles',
      payload: { ...selectedTiles, line },
    });
    selectedTiles = null;
  } else if (act === 'bonus') {
    const factory = Number(target.dataset.factory);
    if (Number.isFinite(factory)) context.send({ type: 'takeBonus', payload: { factory } });
  } else if (act === 'tiling-line') {
    const line = Number(target.dataset.line);
    if (Number.isFinite(line)) selectedTilingLine = line;
  } else if (act === 'place-cell') {
    const line = Number(target.dataset.line);
    const col = Number(target.dataset.col);
    if (Number.isFinite(line) && Number.isFinite(col)) {
      context.send({ type: 'placeDomeTile', payload: { line, row: line, col } });
    }
    selectedTilingLine = null;
  } else if (act === 'spend-bonus') {
    const line = Number(target.dataset.line);
    if (Number.isFinite(line)) context.send({ type: 'spendBonus', payload: { line } });
  } else if (act === 'end-tiling') {
    context.send({ type: 'endTiling', payload: {} });
  } else if (act === 'pass') {
    context.send({ type: 'pass', payload: {} });
  } else if (act === 'cancel') {
    selectedPlate = null;
    selectedTiles = null;
    selectedTilingLine = null;
  }
  render();
}

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
  const turn = next.view?.turn ?? '';
  if (phase !== lastPhase || turn !== lastTurn) {
    selectedPlate = null;
    selectedTiles = null;
    selectedTilingLine = null;
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
  selectedPlate = null;
  selectedTiles = null;
  selectedTilingLine = null;
  lastPhase = '';
  lastTurn = '';
}

function formatLog(entry: LogEntry): string | null {
  const args = entry.args ?? {};
  const who = nameOf(String(args.player ?? args.winner ?? ''));
  switch (entry.key) {
    case 'ad.setupPlate':
      return `${who} 选了一块穹顶板`;
    case 'ad.takePlate':
      return `${who} 拿了一块穹顶板`;
    case 'ad.drawPlate':
      return `${who} 抽了一块背面板（-1 分）`;
    case 'ad.takeTiles':
      return `${who} 拿了 ${args.count ?? 0} 个${COLOR_NAME[String(args.color) as AzulColor] ?? ''}砖（第 ${args.line} 行）`;
    case 'ad.takeBonus':
      return `${who} 拿了一个奖励片`;
    case 'ad.spendBonus':
      return `${who} 用 ${args.chips} 个奖励片补了第 ${args.line} 行`;
    case 'ad.placeTile':
      return `${who} 铺砖 +${args.points ?? 0} 分${args.special ? '（特殊砖）' : ''}`;
    case 'ad.endTiling':
      return `${who} 结束铺砖`;
    case 'ad.broken':
      return `${who} 破损 ${args.tiles} 砖，-${args.penalty} 分`;
    case 'ad.startPenalty':
      return `${who} 持有先手砖，-2 分`;
    case 'ad.round':
      return `进入第 ${args.round} 轮`;
    case 'ad.finalScore': {
      const lines = (args.lines as string[] | undefined) ?? [];
      return `${who} 终局计分：${lines.join('，')}（${args.score} 分）`;
    }
    case 'ad.gameEnd': {
      const scores = (args.scores as Record<string, number> | undefined) ?? {};
      return `${who} 获胜！${Object.entries(scores)
        .map(([id, score]) => `${nameOf(id)} ${score}`)
        .join(' · ')}`;
    }
    case 'ad.pass':
      return `${who} 跳过`;
    default:
      return null;
  }
}

const client: GameClient = { mount, update, unmount, formatLog };
export default client;
export { client };
