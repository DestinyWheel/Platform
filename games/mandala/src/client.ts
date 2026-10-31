/**
 * 曼荼罗（Mandala）前端 —— 原生 DOM + 内联 SVG，不依赖任何框架、不加载任何图片。
 *
 * 视觉目标：让"曼荼罗"这个符号真的成立。
 *   · 圆心 = 我的原野，中环 = 高山，外环 = 对方原野（离你越远越靠外）
 *   · 六个 60° 扇区 = 六种颜色，一只扇区里谁在哪一环，一眼就能看出"这色只能在一个区域"
 *   · 牌不是数字，是彩砂：每格用一层带颗粒的砂纹填充，粒子的抖动是算出来的，不用贴图
 *   · 结算时被拿走的那一格会散开消失（CSS 动画），这是实体桌游做不到的部分
 *
 * 没有任何图片资源，所以不存在授权问题，也不会有 2x / 加载失败 / 缓存失效这些事。
 */
import type {
  ClientSnapshot,
  GameClient,
  GameClientContext,
  LogEntry,
  PlayerId,
} from '@platform/sdk';

const STYLE_ID = 'mandala-client-style';

const COLOR_HEX: Record<number, string> = {
  1: '#d1495b',
  2: '#3f7fd1',
  3: '#2fa46b',
  4: '#e3c341',
  5: '#9b5fc0',
  6: '#e08b3a',
};

const COLOR_NAME: Record<number, string> = {
  1: '红',
  2: '蓝',
  3: '绿',
  4: '黄',
  5: '紫',
  6: '橙',
};

type Counts = Record<string, number>;

interface PlayerInfo {
  id: PlayerId;
  handCount: number;
  cupCount: number;
  river: (number | null)[];
  cup: number[] | null;
}

interface MandalaView {
  fields: Counts[];
  mountain: Counts;
  colorCount: number;
}

interface MandalaData {
  colors: { id: number; name: string }[];
  deckRemaining: number;
  deckExhausted: boolean;
  mandalas: MandalaView[];
  players: PlayerInfo[];
  you: (PlayerInfo & { hand: number[] }) | null;
  opponent: PlayerInfo | null;
  settlement: { mandalaIdx: number; picker: PlayerId } | null;
  /** 结算中和结束后才有：双方当前总分 */
  scores: Record<PlayerId, number> | null;
  /** 本回合内还能撤销几步 */
  undoCount: number;
  /** 不限时房间：不自动换手 */
  untimed: boolean;
  revealed: boolean;
}

/* ------------------------------------------------------------------ */
/* 几何：一个 260×260 的圆                                           */
/* ------------------------------------------------------------------ */

const CX = 130;
const CY = 130;
/** 三环：圆心是我的原野，往外依次是高山、对方原野 */
const RING = {
  mine: [14, 48],
  mountain: [48, 88],
  theirs: [88, 122],
} as const;

/** 空格的底色：三环各给一点不同的色温，空着也能看出这是三个区域 */
const RING_FILL = {
  mine: '#1b2740',
  mountain: '#262e39',
  theirs: '#1b212a',
} as const;

const RIM = 127;

/** 角度以 12 点方向为 0，顺时针为正 */
function polar(radius: number, angle: number): [number, number] {
  const rad = (angle * Math.PI) / 180;
  return [round(CX + radius * Math.sin(rad)), round(CY - radius * Math.cos(rad))];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 环形扇区路径（60°，用不上大弧） */
function sectorPath(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  return `M${x0},${y0} A${r1},${r1} 0 0 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 0 ${x3},${y3} Z`;
}

/**
 * 彩砂纹样：12×12 的一块瓦片，颗粒位置由固定种子算出来。
 * 用白色和黑色两种小点做颗粒感 —— 比 feTurbulence 便宜得多，而且渲染稳定。
 */
function sandPattern(colorId: number): string {
  let seed = colorId * 7919;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const grains: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    const x = round(rnd() * 12);
    const y = round(rnd() * 12);
    const r = round(0.55 + rnd() * 0.85);
    const light = rnd() > 0.45;
    grains.push(
      `<circle cx="${x}" cy="${y}" r="${r}" fill="${light ? '#fff' : '#000'}" opacity="${light ? 0.34 : 0.3}"/>`,
    );
  }

  return `<pattern id="md-sand-${colorId}" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(${(colorId * 13) % 60})">${grains.join('')}</pattern>`;
}

function sandDefs(): string {
  return `<defs>
    <radialGradient id="md-mat" cx="50%" cy="45%" r="60%">
      <stop offset="0%" stop-color="#1b2330"/>
      <stop offset="100%" stop-color="#0e131a"/>
    </radialGradient>
    ${[1, 2, 3, 4, 5, 6].map(sandPattern).join('')}
  </defs>`;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                              */
/* ------------------------------------------------------------------ */

const CSS = `
.md { display:flex; flex-direction:column; gap:14px; padding:10px 4px 20px; color:#e6edf3; }
.md-bar { display:flex; align-items:center; justify-content:center; gap:14px; flex-wrap:wrap; font-size:13px; color:#8b98a7; }
.md-bar b { color:#e6edf3; font-weight:600; }
.md-turn { padding:2px 10px; border-radius:999px; border:1px solid #262d38; }
.md-turn.on { border-color:#4c8dff; color:#4c8dff; }

.md-legend { display:flex; gap:18px; justify-content:center; flex-wrap:wrap; font-size:11px; color:#6b7787; }
.md-legend i { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:5px; vertical-align:middle; border:1px solid rgba(255,255,255,.18); }

/* 两幅曼荼罗并排：grid + minmax(0,1fr) 保证它们分得掉，不会因为放不下就换行堆起来 */
.md-mandalas { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:24px; align-items:start; }
.md-m { display:flex; flex-direction:column; align-items:center; gap:6px; min-width:0; }
.md-m-title { font-size:12px; letter-spacing:.06em; color:#8b98a7; }
.md-m-title b { color:#c9d4e0; }
.md-svg { width:100%; max-width:340px; height:auto; display:block; overflow:visible; }

@media (max-width: 560px) {
  .md-mandalas { grid-template-columns: 1fr; }
}

.md-cell { transition:fill .18s, stroke .18s; }
.md-zone.can { cursor:pointer; }
.md-zone.can .md-hl { opacity:1; }
.md-zone.can .md-cell { stroke:#4c8dff; stroke-width:1.2; }
.md-zone.can:hover .md-hl { opacity:.55; }

.md-count {
  font: 700 13px/1 ui-sans-serif, system-ui, sans-serif;
  fill:#fff; stroke:rgba(0,0,0,.55); stroke-width:2.6; paint-order:stroke;
  pointer-events:none;
}
.md-count.tiny { font-size:11px; }

/* 被拿走的那一格：砂散开 */
@keyframes md-dissolve {
  0% { opacity:.95; transform:scale(1); }
  55% { opacity:.45; }
  100% { opacity:0; transform:scale(1.22); }
}
.md-ghost {
  transform-box: fill-box; transform-origin:center;
  animation: md-dissolve .75s ease-out forwards; pointer-events:none;
}

/* 正在结算的曼荼罗：外环缓缓呼吸 */
@keyframes md-breathe { 0%,100% { opacity:.25; } 50% { opacity:.85; } }
.md-settling .md-halo { animation: md-breathe 1.8s ease-in-out infinite; }

.md-rivers { display:flex; gap:24px; justify-content:center; align-items:flex-start; flex-wrap:wrap; }
/* 自己的那一栏：沙杯（带手牌数）在上，长河在下 */
.md-mine { display:flex; flex-direction:column; align-items:center; gap:8px; }
.md-mine-top { display:flex; align-items:center; gap:16px; flex-wrap:wrap; justify-content:center; }
.md-handcount { font-size:12px; color:#8b98a7; }
.md-handcount b { color:#e6edf3; }
.md-river { display:flex; flex-direction:column; gap:6px; align-items:center; }
.md-river-title { font-size:12px; color:#8b98a7; }
.md-slots { display:flex; gap:4px; }
.md-slot {
  width:42px; height:48px; border-radius:9px; border:1px solid #2c3540;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
  background:#141a22; font-size:10px; color:#5d6874;
}
.md-slot.filled { border-color:#3d4856; background:#1a222c; }
.md-slot .dot { width:15px; height:15px; border-radius:50%; background:var(--c); box-shadow:0 0 8px color-mix(in srgb, var(--c) 60%, transparent); animation:none; }
.md-slot .mult { font-size:9px; color:#6b7787; letter-spacing:.02em; }

.md-cup { font-size:12px; color:#8b98a7; display:flex; align-items:center; gap:6px; }
.md-cup b { color:#e6edf3; }
.md-cupchip {
  display:inline-flex; align-items:center; gap:4px; padding:2px 8px 2px 4px;
  border-radius:999px; background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.08); color:#c9d4e0; font-size:11px;
}
.md-cupchip i { width:10px; height:10px; border-radius:50%; background:var(--c); display:inline-block; }

.md-hand { display:flex; gap:9px; flex-wrap:wrap; justify-content:center; min-height:74px; align-items:center; }
.md-card {
  width:46px; height:66px; border-radius:10px; cursor:pointer; position:relative;
  background-color:var(--c);
  background-image:linear-gradient(160deg, color-mix(in srgb, var(--c) 82%, #fff 8%), color-mix(in srgb, var(--c) 70%, #000 18%));
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 3px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.18);
  display:flex; align-items:flex-end; justify-content:center; padding-bottom:6px;
  font-size:11px; font-weight:700; color:rgba(0,0,0,.7);
  transition:transform .12s, box-shadow .12s, border-color .12s;
}
.md-card::after {
  content:''; position:absolute; inset:3px; border-radius:8px;
  border:1px solid rgba(0,0,0,.18);
  background:
    radial-gradient(circle at 30% 26%, rgba(255,255,255,.22), transparent 42%),
    repeating-linear-gradient(45deg, rgba(255,255,255,.05) 0 2px, transparent 2px 5px);
}
.md-card:hover { transform:translateY(-7px); }
.md-card.sel { border-color:#f0d264; transform:translateY(-11px); box-shadow:0 0 18px rgba(240,210,100,.4); }
.md-card span { position:relative; z-index:1; }

.md-actions { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
.md-btn {
  font:inherit; font-size:13px; padding:7px 16px; border-radius:9px; cursor:pointer;
  border:1px solid #2c3540; background:#1c232c; color:#e6edf3;
}
.md-btn:hover:not(:disabled) { border-color:#4c8dff; }
.md-btn.primary { background:linear-gradient(180deg,#4c8dff,#3a72d8); border-color:transparent; color:#fff; font-weight:600; }
.md-btn:disabled { opacity:.4; cursor:not-allowed; }

.md-settle {
  max-width: 520px; margin: 0 auto; width: 100%;
  border:1px solid #d29922; background:rgba(210,153,34,.1);
  border-radius:12px; padding:12px 16px; text-align:center;
  display:flex; flex-direction:column; gap:10px; align-items:center;
}
.md-settle h4 { margin:0; font-size:14px; color:#e3b341; }
.md-scores { display:flex; align-items:center; justify-content:center; gap:14px; }
.md-score { display:flex; align-items:baseline; gap:6px; color:#8b98a7; }
.md-score .who { font-size:12px; }
.md-score b { font-size:20px; color:#e6edf3; font-variant-numeric:tabular-nums; }
.md-score.lead b { color:#e3b341; }
.md-score-sep { color:#4a5563; }
.md-picks { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; }
.md-pick {
  width:46px; height:46px; border-radius:50%; border:2px solid rgba(255,255,255,.12); cursor:pointer;
  background-color:var(--c);
  background-image:radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--c) 78%, #fff 22%), var(--c));
  font-size:11px; font-weight:700; color:rgba(0,0,0,.75);
  box-shadow:0 2px 8px rgba(0,0,0,.4);
}
.md-pick:hover:not(:disabled) { border-color:#f0d264; transform:translateY(-2px); }
.md-pick:disabled { opacity:.45; cursor:default; }
.md-hint { text-align:center; font-size:12px; color:#8b98a7; }
.md-discard-hint { flex-basis:100%; }

/* 「会抽牌、且不可撤销」的动作，先确认一下 */
.md-confirm {
  max-width: 520px; margin: 0 auto; width: 100%;
  display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:center;
  border:1px solid #d29922; background:rgba(210,153,34,.12);
  border-radius:10px; padding:10px 14px;
}
.md-confirm-text { font-size:12px; color:#e3b341; }
.md-result { text-align:center; font-size:16px; font-weight:700; color:#e3b341; }
`;

/** 等玩家确认的"会抽牌、且不可撤销"的动作 */
type PendingAction =
  | { kind: 'mountain'; card: number; mandala: number }
  | { kind: 'discard'; cards: number[] };

interface UiState {
  selected: number | null;
  discardMode: boolean;
  discardSel: Set<number>;
  pending: PendingAction | null;
}

let context: GameClientContext | null = null;
let root: HTMLElement | null = null;
let snapshot: ClientSnapshot | null = null;
let ui: UiState = { selected: null, discardMode: false, discardSel: new Set(), pending: null };

/** 结算时"刚被拿空"的格子，用来播一次散开动画 */
const ghosts = new Map<string, { count: number; at: number }>();
const GHOST_MS = 900;
let ghostTimer: number | undefined;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function nameOf(id: PlayerId): string {
  return context?.players.find((player) => player.id === id)?.name ?? id.slice(0, 6);
}

function colorOf(id: number): string {
  return COLOR_HEX[id] ?? '#666';
}

/* ------------------------------- 曼荼罗 ------------------------------- */

interface CellSpec {
  color: number;
  kind: 'mine' | 'mountain' | 'theirs';
  count: number;
  a0: number;
  a1: number;
  mid: number;
}

function cellHtml(cell: CellSpec, mandalaIndex: number, now: number): string {
  const ring = RING[cell.kind];
  const d = sectorPath(ring[0], ring[1], cell.a0, cell.a1);
  const [tx, ty] = polar((ring[0] + ring[1]) / 2, cell.mid);
  const play = cell.kind === 'mountain' ? 'mountain' : 'field';
  const ghostKey = `${mandalaIndex}:${cell.color}:mountain`;
  const ghost = cell.kind === 'mountain' ? ghosts.get(ghostKey) : undefined;
  const showGhost = ghost && cell.count === 0 && now - ghost.at < GHOST_MS;

  const emptyFill = RING_FILL[cell.kind];

  const body = cell.count > 0
    ? `<path class="md-cell" d="${d}" fill="${colorOf(cell.color)}" stroke="${colorOf(cell.color)}" stroke-opacity="0.9" stroke-width="0.9"/>
       <path class="md-cell" d="${d}" fill="url(#md-sand-${cell.color})"/>
       <text class="md-count" x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="central">${cell.count}</text>`
    : `<path class="md-cell" d="${d}" fill="${emptyFill}" stroke="rgba(255,255,255,0.07)" stroke-width="0.9"/>`;

  const ghostHtml = showGhost
    ? `<g class="md-ghost">
         <path d="${d}" fill="${colorOf(cell.color)}" stroke="${colorOf(cell.color)}" stroke-opacity="0.9" stroke-width="0.9"/>
         <path d="${d}" fill="url(#md-sand-${cell.color})"/>
         <text class="md-count" x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="central">${ghost.count}</text>
       </g>`
    : '';

  return `<g class="md-zone" data-play="${play}" data-mandala="${mandalaIndex}" data-color="${cell.color}">
      ${body}${ghostHtml}
      <path class="md-hl" d="${d}" fill="#4c8dff" fill-opacity="0.26" stroke="#4c8dff" stroke-width="1.4" opacity="0"/>
    </g>`;
}

function mandalaSvg(
  board: MandalaView,
  index: number,
  myIndex: number,
  theirIndex: number,
  settling: boolean,
  now: number,
): string {
  const cells: string[] = [];

  for (let color = 1; color <= 6; color += 1) {
    const a0 = (color - 1) * 60 - 30;
    const a1 = (color - 1) * 60 + 30;
    const mid = (color - 1) * 60;

    cells.push(
      cellHtml(
        { color, kind: 'theirs', count: board.fields[theirIndex]?.[color] ?? 0, a0, a1, mid },
        index,
        now,
      ),
    );
    cells.push(
      cellHtml(
        { color, kind: 'mountain', count: board.mountain[color] ?? 0, a0, a1, mid },
        index,
        now,
      ),
    );
    cells.push(
      cellHtml(
        { color, kind: 'mine', count: board.fields[myIndex]?.[color] ?? 0, a0, a1, mid },
        index,
        now,
      ),
    );
  }

  // 环与环之间的引导线：中环描金、内环描蓝，和下面的图例对得上
  const guides = [
    `<circle cx="${CX}" cy="${CY}" r="${RING.mine[1]}" fill="none" stroke="#7aa2ff" stroke-opacity="0.28" stroke-width="1.1"/>`,
    `<circle cx="${CX}" cy="${CY}" r="${RING.mountain[1]}" fill="none" stroke="#d6b25e" stroke-opacity="0.3" stroke-width="1.1"/>`,
  ].join('');

  // 六个扇区分隔线
  const spokes = Array.from({ length: 6 }, (_, i) => {
    const [x, y] = polar(RING.mine[0], i * 60 + 30);
    const [x2, y2] = polar(RING.theirs[1], i * 60 + 30);
    return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,0.09)" stroke-width="1"/>`;
  }).join('');

  // 外圈刻度：36 道，每三道一组长一点。曼荼罗的"边"是靠这种重复建立起来的
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const angle = i * 10;
    const major = i % 3 === 0;
    const [x1, y1] = polar(RIM - 6, angle);
    const [x2, y2] = polar(RIM - (major ? 1 : 3), angle);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#d6b25e" stroke-opacity="${major ? 0.5 : 0.2}" stroke-width="${major ? 1.3 : 0.8}"/>`;
  }).join('');

  // 圆心：六瓣莲
  const rosette = Array.from({ length: 6 }, (_, i) => {
    return `<ellipse cx="${CX}" cy="${CY - 6.5}" rx="2.3" ry="4.4" fill="#d6b25e" opacity="0.42" transform="rotate(${i * 60} ${CX} ${CY})"/>`;
  }).join('');

  return `<svg class="md-svg ${settling ? 'md-settling' : ''}" viewBox="0 0 260 260" role="img" aria-label="曼荼罗 ${index + 1}">
      <defs>${sandDefs()}</defs>
      <circle cx="${CX}" cy="${CY}" r="${RIM}" fill="url(#md-mat)" stroke="rgba(214,178,94,0.25)" stroke-width="1"/>
      <circle class="md-halo" cx="${CX}" cy="${CY}" r="${RIM + 2}" fill="none" stroke="#d6b25e" stroke-width="2" opacity="0.25"/>
      ${ticks}${guides}${spokes}
      ${cells}
      <circle cx="${CX}" cy="${CY}" r="${RING.mine[0]}" fill="#0f141b" stroke="rgba(122,162,255,0.25)" stroke-width="1"/>
      ${rosette}
      <circle cx="${CX}" cy="${CY}" r="2" fill="#d6b25e" opacity="0.6"/>
    </svg>`;
}

/* ------------------------------- 其它块 ------------------------------- */

function riverHtml(player: PlayerInfo, title: string): string {
  const slots = (player.river.length ? player.river : Array(6).fill(null))
    .map((color, index) => {
      if (!color) {
        return `<div class="md-slot"><span class="mult">×${index + 1}</span></div>`;
      }
      return `<div class="md-slot filled"><span class="dot" style="--c:${colorOf(color)}"></span><span class="mult">×${index + 1}</span></div>`;
    })
    .join('');
  return `<div class="md-river"><div class="md-river-title">${title}</div><div class="md-slots">${slots}</div></div>`;
}

function cupHtml(player: PlayerInfo, title: string): string {
  if (player.cup) {
    const counts = new Map<number, number>();
    for (const color of player.cup) counts.set(color, (counts.get(color) ?? 0) + 1);
    const chips = [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([color, count]) =>
          `<span class="md-cupchip" style="--c:${colorOf(color)}" title="${COLOR_NAME[color] ?? ''} ×${count}"><i></i>${count}</span>`,
      )
      .join('');
    return `<div class="md-cup">${title}沙杯 <b>${player.cup.length}</b> ${chips}</div>`;
  }
  return `<div class="md-cup">${title}沙杯 <b>${player.cupCount}</b> 张（盖着）</div>`;
}

function legalMovesFor(card: number, type: string, mandala: number): boolean {
  const moves = snapshot?.legalMoves ?? [];
  return moves.some((move) => {
    const payload = move.payload as { card?: number; mandala?: number } | undefined;
    return move.type === type && payload?.card === card && payload?.mandala === mandala;
  });
}

function render(): void {
  if (!root || !context || !snapshot) return;

  const view = snapshot.view;
  if (!view) {
    root.innerHTML = '<div class="md-hint">等待对局开始…</div>';
    return;
  }

  const data = view.data as unknown as MandalaData;
  const me = data.you;
  const activeId = view.turn;
  const canAct = Boolean(me) && activeId === me!.id && !view.finished;
  const settlement = data.settlement;
  const myTurnToSettle = Boolean(settlement && me && settlement.picker === me.id);

  const myIndex = me ? data.players.findIndex((player) => player.id === me.id) : 0;
  const theirIndex = myIndex === 0 ? 1 : 0;
  const now = Date.now();

  const mandalasHtml = data.mandalas
    .map((board, index) => {
      const settling = settlement?.mandalaIdx === index;
      return `<div class="md-m">
        <div class="md-m-title">曼荼罗 <b>${index + 1}</b> · ${board.colorCount}/6 色</div>
        ${mandalaSvg(board, index, myIndex, theirIndex, settling, now)}
      </div>`;
    })
    .join('');

  const handHtml = me
    ? me.hand
        .map((color, index) => {
          const selected = ui.discardMode ? ui.discardSel.has(index) : ui.selected === index;
          return `<div class="md-card ${selected ? 'sel' : ''}" data-card="${index}" style="--c:${colorOf(color)}" title="${COLOR_NAME[color] ?? ''}"><span>${COLOR_NAME[color] ?? ''}</span></div>`;
        })
        .join('')
    : '<div class="md-hint">观战中</div>';

  const opponentHtml = data.opponent
    ? `<div class="md-bar">
         <span>对手 <b>${nameOf(data.opponent.id)}</b></span>
         <span>手牌 <b>${data.opponent.handCount}</b></span>
         ${cupHtml(data.opponent, '')}
       </div>
       <div class="md-rivers">${riverHtml(data.opponent, '对方长河')}</div>`
    : '';

  const settleHtml = settlement ? renderSettlement(settlement, data, myTurnToSettle) : '';

  const resultHtml =
    view.finished && view.ranking
      ? `<div class="md-result">🏆 ${view.ranking[0]!.map(nameOf).join('、')} 获胜</div>${scoreboard(data)}`
      : '';

  // 弃牌只能同色：选中的牌颜色一致才允许确认（服务端也会拦，这里先挡住）
  const discardColors = new Set(
    [...ui.discardSel].map((index) => me?.hand[index]).filter((color) => color !== undefined),
  );
  const canDiscard = ui.discardSel.size > 0 && discardColors.size <= 1;

  const confirmText = ui.pending
    ? ui.pending.kind === 'mountain'
      ? '打高山会抽牌，抽到的牌进了手牌，这一步就不能撤销了'
      : `弃 ${ui.pending.cards.length} 张会补抽同样张数，抽完这一步就不能撤销了`
    : '';
  const confirmHtml = ui.pending
    ? `<div class="md-confirm">
         <span class="md-confirm-text">${confirmText}</span>
         <button class="md-btn primary" data-action="confirm-yes">确定</button>
         <button class="md-btn" data-action="confirm-no">取消</button>
       </div>`
    : '';

  const actionsHtml = view.finished
    ? ''
    : `<div class="md-actions">
        <button class="md-btn" data-action="undo" ${canAct && data.undoCount > 0 ? '' : 'disabled'}>
          ↩ 撤销${data.undoCount > 0 ? `（${data.undoCount}）` : ''}
        </button>
        <button class="md-btn ${ui.discardMode ? 'primary' : ''}" data-action="discard" ${canAct ? '' : 'disabled'}>
          ${ui.discardMode ? '退出弃牌' : '弃牌'}
        </button>
        ${
          ui.discardMode
            ? `<button class="md-btn primary" data-action="confirm-discard" ${canDiscard ? '' : 'disabled'}>确认弃 ${ui.discardSel.size} 张</button>`
            : ''
        }
        <button class="md-btn" data-action="end-turn" ${canAct ? '' : 'disabled'}>结束回合</button>
        ${
          ui.discardMode
            ? `<div class="md-hint md-discard-hint">弃牌只能选同一种颜色：弃几张补几张，混色不行</div>`
            : ''
        }
      </div>`;

  const turnHint = view.finished
    ? '对局结束'
    : settlement
      ? `${nameOf(settlement.picker)} 选色中`
      : activeId
        ? `轮到 ${nameOf(activeId)}`
        : '';

  root.innerHTML = `
    <div class="md">
      <div class="md-bar">
        <span class="md-turn ${activeId === me?.id ? 'on' : ''}">${turnHint}</span>
        <span>牌堆 <b>${data.deckRemaining}</b>${data.deckExhausted ? '（已抽空）' : ''}</span>
        <span>第 <b>${view.round}</b> 轮</span>
        ${data.untimed ? '<span>不限时 · 需手动结束回合</span>' : ''}
      </div>
      ${opponentHtml}
      <div class="md-mandalas">${mandalasHtml}</div>
      <div class="md-legend">
        <span><i style="background:#191f28;border-color:#6b7787"></i>外环 对方原野</span>
        <span><i style="background:#232a34;border-color:#d6b25e"></i>中环 高山</span>
        <span><i style="background:#182338;border-color:#7aa2ff"></i>圆心 我的原野</span>
      </div>
      ${settleHtml}
      ${resultHtml}
      <div class="md-mine">
        ${
          me
            ? `<div class="md-mine-top">
                 <span class="md-handcount">手牌 <b>${me.handCount}</b></span>
                 ${cupHtml(me, '我的')}
               </div>`
            : ''
        }
        ${me ? riverHtml(me, '我的长河') : ''}
      </div>
      <div class="md-hand">${handHtml}</div>
      ${confirmHtml}
      ${actionsHtml}
    </div>
  `;

  // 高亮：选中的牌能落到哪些格子（颜色由牌决定，所以只亮那一格）
  if (canAct && ui.selected !== null && !ui.discardMode && me) {
    const color = me.hand[ui.selected];
    for (const zone of Array.from(root.querySelectorAll<HTMLElement>('.md-zone'))) {
      const mandala = Number(zone.dataset.mandala);
      const kind = zone.dataset.play === 'mountain' ? 'playMountain' : 'playField';
      if (Number(zone.dataset.color) !== color) continue;
      if (legalMovesFor(ui.selected, kind, mandala)) zone.classList.add('can');
    }
  }

  // 动画放完就清掉幽灵，避免下次重绘又播一遍
  if (ghosts.size > 0 && ghostTimer === undefined) {
    ghostTimer = window.setTimeout(() => {
      ghostTimer = undefined;
      for (const [key, entry] of ghosts) {
        if (Date.now() - entry.at >= GHOST_MS) ghosts.delete(key);
      }
      render();
    }, GHOST_MS + 60);
  }
}

/** 结算 / 对局结束时的比分条：名字 + 总分，领先的一方数字是金色 */
function scoreboard(data: MandalaData): string {
  if (!data.scores) return '';
  const scores = data.scores;
  const valueOf = (id: PlayerId): number => scores[id] ?? 0;
  const best = Math.max(...data.players.map((player) => valueOf(player.id)));

  const items = data.players.map(
    (player) =>
      `<div class="md-score${best > 0 && valueOf(player.id) === best ? ' lead' : ''}"><span class="who">${nameOf(player.id)}</span><b>${valueOf(player.id)}</b></div>`,
  );
  return `<div class="md-scores">${items.join('<span class="md-score-sep">:</span>')}</div>`;
}

function renderSettlement(
  settlement: { mandalaIdx: number; picker: PlayerId },
  data: MandalaData,
  myTurn: boolean,
): string {
  const board = data.mandalas[settlement.mandalaIdx];
  if (!board) return '';

  const colors = Object.keys(board.mountain)
    .map(Number)
    .filter((color) => (board.mountain[color] ?? 0) > 0)
    .sort((a, b) => a - b);

  const picks = colors
    .map(
      (color) =>
        `<button class="md-pick" data-action="pick" data-color="${color}" style="--c:${colorOf(color)}" ${myTurn ? '' : 'disabled'} title="${COLOR_NAME[color] ?? ''}">${board.mountain[color]} 张</button>`,
    )
    .join('');

  return `<div class="md-settle">
      <h4>曼荼罗 ${settlement.mandalaIdx + 1} 已集齐六色 · ${nameOf(settlement.picker)} 先选</h4>
      ${scoreboard(data)}
      <div class="md-picks">${picks}</div>
      <div class="md-hint">${myTurn ? '点一种颜色，拿走高山上该颜色的全部牌' : '等待对方选色'}</div>
    </div>`;
}

/* ------------------------------- 交互 ------------------------------- */

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target || !snapshot) return;
  const data = snapshot.view?.data as unknown as MandalaData | undefined;
  if (!data) return;

  const cardEl = target.closest<HTMLElement>('[data-card]');
  if (cardEl) {
    const index = Number(cardEl.dataset.card);
    if (ui.discardMode) {
      const hand = data.you?.hand ?? [];
      if (ui.discardSel.has(index)) {
        ui.discardSel.delete(index);
      } else {
        // 只能弃同色：点了别的颜色，就把它当成"改成弃这一色"
        const first = [...ui.discardSel][0];
        if (first !== undefined && hand[first] !== hand[index]) ui.discardSel.clear();
        ui.discardSel.add(index);
      }
    } else {
      ui.selected = ui.selected === index ? null : index;
    }
    render();
    return;
  }

  const zoneEl = target.closest<HTMLElement>('.md-zone.can');
  if (zoneEl && ui.selected !== null) {
    const mandala = Number(zoneEl.dataset.mandala);
    if (zoneEl.dataset.play === 'mountain') {
      // 打高山会抽牌，而且抽完不能撤销 → 先问一句
      ui.pending = { kind: 'mountain', card: ui.selected, mandala };
    } else {
      context?.send({ type: 'playField', payload: { card: ui.selected, mandala } });
      ui.selected = null;
    }
    render();
    return;
  }

  const button = target.closest<HTMLElement>('[data-action]');
  if (!button) return;

  const action = button.dataset.action;
  if (action === 'end-turn') {
    context?.send({ type: 'endTurn', payload: {} });
  } else if (action === 'undo') {
    context?.send({ type: 'undo', payload: {} });
    ui.selected = null;
    ui.discardMode = false;
    ui.discardSel.clear();
  } else if (action === 'discard') {
    ui.discardMode = !ui.discardMode;
    ui.discardSel.clear();
    ui.selected = null;
    ui.pending = null;
  } else if (action === 'confirm-discard') {
    // 这里只是把选择挂起来，真正发出去要再点一次「确定」
    const cards = [...ui.discardSel].sort((a, b) => a - b);
    if (cards.length > 0) ui.pending = { kind: 'discard', cards };
  } else if (action === 'confirm-yes' && ui.pending) {
    const pending = ui.pending;
    ui.pending = null;
    if (pending.kind === 'mountain') {
      context?.send({
        type: 'playMountain',
        payload: { card: pending.card, mandala: pending.mandala },
      });
      ui.selected = null;
    } else {
      context?.send({ type: 'discard', payload: { cards: pending.cards } });
      ui.discardMode = false;
      ui.discardSel.clear();
    }
  } else if (action === 'confirm-no') {
    ui.pending = null;
  } else if (action === 'pick') {
    const color = Number(button.dataset.color);
    context?.send({ type: 'pickColor', payload: { color } });
  }
  render();
}

function mount(ctx: GameClientContext): void {
  ensureStyle();
  context = ctx;
  ui = { selected: null, discardMode: false, discardSel: new Set(), pending: null };
  ghosts.clear();

  root = document.createElement('div');
  root.className = 'md-root';
  root.addEventListener('click', onClick);
  ctx.root.replaceChildren(root);
  render();
}

function update(next: ClientSnapshot): void {
  const previous = snapshot;
  snapshot = next;

  // 结算时某一种颜色被拿空 → 记下来播一次散开动画
  const before = previous?.view?.data as unknown as MandalaData | undefined;
  const after = next.view?.data as unknown as MandalaData | undefined;
  if (before && after) {
    after.mandalas.forEach((board, index) => {
      const old = before.mandalas[index];
      if (!old) return;
      for (let color = 1; color <= 6; color += 1) {
        const was = old.mountain[color] ?? 0;
        const now = board.mountain[color] ?? 0;
        if (was > 0 && now === 0) {
          ghosts.set(`${index}:${color}:mountain`, { count: was, at: Date.now() });
        }
      }
    });
  }

  // 手牌变少了就清掉可能失效的选中
  if (ui.selected !== null) {
    const hand = after?.you?.hand ?? [];
    if (ui.selected >= hand.length) ui.selected = null;
  }
  render();
}

function unmount(): void {
  if (ghostTimer !== undefined) window.clearTimeout(ghostTimer);
  ghostTimer = undefined;
  ghosts.clear();
  root?.removeEventListener('click', onClick);
  root?.remove();
  root = null;
  context = null;
  snapshot = null;
}

function formatLog(entry: LogEntry): string | null {
  const args = entry.args ?? {};
  const who = nameOf(String(args.player ?? args.picker ?? ''));

  switch (entry.key) {
    case 'mandala.playMountain':
      return `${who} 把 ${COLOR_NAME[Number(args.color)]} 打到曼荼罗 ${args.mandala} 的高山`;
    case 'mandala.playField':
      return `${who} 把 ${COLOR_NAME[Number(args.color)]} 打到曼荼罗 ${args.mandala} 的原野`;
    case 'mandala.discard':
      return `${who} 弃了 ${args.count} 张，补回 ${args.drawn} 张`;
    case 'mandala.endTurn':
      return `${who} 结束回合`;
    case 'mandala.undo':
      return `${who} 撤销了一步`;
    case 'mandala.settleStart':
      return `⚡ 曼荼罗 ${args.mandala} 集齐六色，${who} 先选${args.tie ? '（原野牌数相同）' : ''}`;
    case 'mandala.pick':
      return `${who} 拿走 ${args.count} 张 ${COLOR_NAME[Number(args.color)]}`;
    case 'mandala.settleEnd':
      return `曼荼罗 ${args.mandala} 结算完成，区域已清空`;
    case 'mandala.gameEnd':
      return `对局结束：${who} 获胜`;
    default:
      return null;
  }
}

const client: GameClient = { mount, update, unmount, formatLog };

export default client;
export { client };
