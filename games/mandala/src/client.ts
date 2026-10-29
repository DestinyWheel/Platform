/**
 * 曼荼罗（Mandala）前端 —— 原生 DOM，不依赖任何框架。
 *
 * 布局：对手信息 / 两幅曼荼罗（上=对方原野，中=高山，下=己方原野）/ 长河 / 手牌 / 操作
 * 交互：点手牌选中 → 点曼荼罗的某个区域出牌；弃牌与结束回合走按钮。
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
  1: '#cc3333',
  2: '#3366cc',
  3: '#33aa55',
  4: '#e6c832',
  5: '#9944be',
  6: '#e68a28',
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
  /** 本回合内还能撤销几步 */
  undoCount: number;
  /** 不限时房间：不自动换手 */
  untimed: boolean;
  revealed: boolean;
}

const CSS = `
.md { display:flex; flex-direction:column; gap:14px; padding:10px 4px 20px; color:#e6edf3; }
.md-bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:13px; color:#8b98a7; }
.md-bar b { color:#e6edf3; font-weight:600; }
.md-turn { padding:2px 10px; border-radius:999px; border:1px solid #262d38; }
.md-turn.on { border-color:#4c8dff; color:#4c8dff; }

.md-mandalas { display:flex; gap:24px; justify-content:center; flex-wrap:wrap; }
.md-m { display:flex; flex-direction:column; align-items:center; gap:8px; }
.md-m-title { font-size:12px; letter-spacing:.06em; color:#8b98a7; text-transform:uppercase; }

.md-circle {
  width:250px; height:250px; border-radius:50%; overflow:hidden;
  display:flex; flex-direction:column;
  background:#1a212a; border:2px solid #2c3540;
  box-shadow: inset 0 0 40px rgba(0,0,0,.45);
}
.md-zone { flex:1; display:flex; flex-wrap:wrap; gap:5px; align-content:center; justify-content:center; padding:8px; position:relative; transition:background .15s; }
.md-theirs { background:rgba(255,255,255,.02); }
.md-mountain { background:rgba(255,255,255,.06); border-top:1px dashed #2c3540; border-bottom:1px dashed #2c3540; }
.md-mine { background:rgba(76,141,255,.05); }
.md-zone.can { background:rgba(76,141,255,.22); cursor:pointer; box-shadow: inset 0 0 0 2px #4c8dff; }
.md-zone.can:hover { background:rgba(76,141,255,.32); }
.md-zone-label { position:absolute; top:4px; left:8px; font-size:10px; color:#5d6874; letter-spacing:.08em; }

.md-chip {
  min-width:26px; height:26px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-size:11px; font-weight:700; color:#0e1116;
  background:var(--c); box-shadow:0 1px 0 rgba(255,255,255,.25) inset;
}
.md-chip.small { min-width:20px; height:20px; font-size:10px; }

.md-rivers { display:flex; gap:24px; justify-content:center; flex-wrap:wrap; }
.md-river { display:flex; flex-direction:column; gap:6px; align-items:center; }
.md-river-title { font-size:12px; color:#8b98a7; }
.md-slots { display:flex; gap:4px; }
.md-slot {
  width:40px; height:44px; border-radius:8px; border:1px solid #2c3540;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
  background:#161b22; font-size:10px; color:#5d6874;
}
.md-slot.filled { border-color:#3d4856; background:#1c232c; }
.md-slot .dot { width:16px; height:16px; border-radius:50%; background:var(--c); }

.md-cup { font-size:12px; color:#8b98a7; display:flex; align-items:center; gap:6px; }
.md-cup b { color:#e6edf3; }

.md-hand { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; min-height:66px; align-items:center; }
.md-card {
  width:44px; height:62px; border-radius:8px; cursor:pointer;
  background:var(--c); border:2px solid transparent;
  display:flex; align-items:flex-end; justify-content:center; padding-bottom:5px;
  font-size:11px; font-weight:700; color:rgba(0,0,0,.72);
  transition:transform .12s, border-color .12s;
}
.md-card:hover { transform:translateY(-6px); }
.md-card.sel { border-color:#f0d264; transform:translateY(-10px); box-shadow:0 0 16px rgba(240,210,100,.35); }
.md-card.dis { opacity:.45; }

.md-actions { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
.md-btn {
  font:inherit; font-size:13px; padding:7px 16px; border-radius:9px; cursor:pointer;
  border:1px solid #2c3540; background:#1c232c; color:#e6edf3;
}
.md-btn:hover:not(:disabled) { border-color:#4c8dff; }
.md-btn.primary { background:linear-gradient(180deg,#4c8dff,#3a72d8); border-color:transparent; color:#fff; font-weight:600; }
.md-btn:disabled { opacity:.4; cursor:not-allowed; }

.md-settle {
  border:1px solid #d29922; background:rgba(210,153,34,.12);
  border-radius:12px; padding:12px 16px; text-align:center;
  display:flex; flex-direction:column; gap:10px; align-items:center;
}
.md-settle h4 { margin:0; font-size:14px; color:#e3b341; }
.md-picks { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; }
.md-pick {
  width:44px; height:44px; border-radius:50%; border:2px solid transparent; cursor:pointer;
  background:var(--c); font-size:11px; font-weight:700; color:rgba(0,0,0,.75);
}
.md-pick:hover { border-color:#f0d264; }
.md-hint { text-align:center; font-size:12px; color:#8b98a7; }
.md-result { text-align:center; font-size:16px; font-weight:700; color:#e3b341; }
`;

interface UiState {
  selected: number | null;
  discardMode: boolean;
  discardSel: Set<number>;
}

let context: GameClientContext | null = null;
let root: HTMLElement | null = null;
let snapshot: ClientSnapshot | null = null;
let ui: UiState = { selected: null, discardMode: false, discardSel: new Set() };

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

function chip(color: number, count: number, small = false): string {
  const cls = small ? 'md-chip small' : 'md-chip';
  return `<span class="${cls}" style="--c:${COLOR_HEX[color] ?? '#666'}">${count}</span>`;
}

function zoneHtml(
  zone: Counts,
  mandalaIndex: number,
  kind: 'field' | 'mountain',
  label: string,
  extraClass: string,
): string {
  const entries = Object.entries(zone)
    .map(([color, count]) => [Number(color), Number(count)] as const)
    .sort((a, b) => a[0] - b[0]);

  const chips = entries.map(([color, count]) => chip(color, count)).join('');
  return `<div class="md-zone ${extraClass}" data-play="${kind}" data-mandala="${mandalaIndex}">
      <span class="md-zone-label">${label}</span>${chips}
    </div>`;
}

function riverHtml(player: PlayerInfo, title: string): string {
  const slots = (player.river.length ? player.river : Array(6).fill(null))
    .map((color, index) => {
      if (!color) return `<div class="md-slot"><span>${index + 1}</span></div>`;
      return `<div class="md-slot filled"><span class="dot" style="--c:${COLOR_HEX[color] ?? '#666'}"></span><span>${index + 1}</span></div>`;
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
      .map(([color, count]) => chip(color, count, true))
      .join('');
    return `<div class="md-cup">${title} 沙杯 <b>${player.cup.length}</b> ${chips}</div>`;
  }
  return `<div class="md-cup">${title} 沙杯 <b>${player.cupCount}</b> 张（盖着）</div>`;
}

function legalMovesFor(card: number, type: string, mandala: number): boolean {
  const moves = snapshot?.legalMoves ?? [];
  return moves.some((move) => {
    const payload = move.payload as { card?: number; mandala?: number } | undefined;
    return (
      move.type === type && payload?.card === card && payload?.mandala === mandala
    );
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
  const isSpectator = !me;
  const activeId = view.turn;
  const canAct = Boolean(me) && activeId === me!.id && !view.finished;
  const settlement = data.settlement;
  const myTurnToSettle = Boolean(settlement && me && settlement.picker === me.id);

  const mandalasHtml = data.mandalas
    .map((board, index) => {
      const myFieldIndex = me ? data.players.findIndex((player) => player.id === me.id) : -1;
      const theirFieldIndex = myFieldIndex === 0 ? 1 : 0;
      const myField = (myFieldIndex >= 0 ? board.fields[myFieldIndex] : board.fields[0]) ?? {};
      const theirField = (theirFieldIndex >= 0 ? board.fields[theirFieldIndex] : board.fields[1]) ?? {};

      const mountainZone = zoneHtml(board.mountain, index, 'mountain', '⛰ 高山', 'md-mountain');
      const mineZone = zoneHtml(myField, index, 'field', '我的原野', 'md-mine');
      const theirsZone = zoneHtml(theirField, index, 'field', '对方原野', 'md-theirs');

      return `<div class="md-m">
        <div class="md-m-title">曼荼罗 ${index + 1} · ${board.colorCount}/6 色</div>
        <div class="md-circle">${theirsZone}${mountainZone}${mineZone}</div>
      </div>`;
    })
    .join('');

  const handHtml = me
    ? me.hand
        .map((color, index) => {
          const selected = ui.discardMode ? ui.discardSel.has(index) : ui.selected === index;
          const dim = ui.discardMode ? '' : '';
          return `<div class="md-card ${selected ? 'sel' : ''} ${dim}" data-card="${index}" style="--c:${COLOR_HEX[color] ?? '#666'}" title="${COLOR_NAME[color] ?? ''}">${COLOR_NAME[color] ?? ''}</div>`;
        })
        .join('')
    : '<div class="md-hint">观战中</div>';

  const opponentHtml = data.opponent
    ? `<div class="md-bar">
         <span>对手 <b>${nameOf(data.opponent.id)}</b></span>
         <span>手牌 <b>${data.opponent.handCount}</b></span>
         <span>沙杯 <b>${data.opponent.cupCount}</b></span>
         ${cupHtml(data.opponent, '')}
       </div>`
    : '';

  const settleHtml = settlement
    ? renderSettlement(settlement, data, myTurnToSettle)
    : '';

  const resultHtml = view.finished && view.ranking
    ? `<div class="md-result">🏆 ${view.ranking[0]!.map(nameOf).join('、')} 获胜</div>`
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
            ? `<button class="md-btn primary" data-action="confirm-discard" ${ui.discardSel.size > 0 ? '' : 'disabled'}>确认弃 ${ui.discardSel.size} 张</button>`
            : ''
        }
        <button class="md-btn" data-action="end-turn" ${canAct ? '' : 'disabled'}>结束回合</button>
      </div>`;

  const turnHint = view.finished
    ? ''
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
      ${opponentHtml ? `<div class="md-rivers">${riverHtml(data.opponent!, '对方长河')}</div>` : ''}
      <div class="md-mandalas">${mandalasHtml}</div>
      ${settleHtml}
      ${resultHtml}
      <div class="md-rivers">
        ${me ? riverHtml(me, '我的长河') : ''}
        ${me ? cupHtml(me, '我的') : ''}
      </div>
      <div class="md-hand">${handHtml}</div>
      ${actionsHtml}
    </div>
  `;

  // 高亮可落子区域
  if (canAct && ui.selected !== null && !ui.discardMode) {
    for (const zone of Array.from(root.querySelectorAll<HTMLElement>('.md-zone'))) {
      const mandala = Number(zone.dataset.mandala);
      const kind = zone.dataset.play === 'mountain' ? 'playMountain' : 'playField';
      if (legalMovesFor(ui.selected, kind, mandala)) zone.classList.add('can');
    }
  }
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
    .sort((a, b) => a - b);

  const picks = colors
    .map(
      (color) =>
        `<button class="md-pick" data-action="pick" data-color="${color}" style="--c:${COLOR_HEX[color] ?? '#666'}" ${myTurn ? '' : 'disabled'} title="${COLOR_NAME[color] ?? ''}">${COLOR_NAME[color] ?? ''}</button>`,
    )
    .join('');

  return `<div class="md-settle">
      <h4>曼荼罗 ${settlement.mandalaIdx + 1} 结算中 · ${nameOf(settlement.picker)} 先选</h4>
      <div class="md-picks">${picks}</div>
      <div class="md-hint">${myTurn ? '点一种颜色，拿走高山上该颜色的全部牌' : '等待对方选色'}</div>
    </div>`;
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target || !snapshot) return;
  const data = snapshot.view?.data as unknown as MandalaData | undefined;
  if (!data) return;

  const cardEl = target.closest<HTMLElement>('[data-card]');
  if (cardEl) {
    const index = Number(cardEl.dataset.card);
    if (ui.discardMode) {
      if (ui.discardSel.has(index)) ui.discardSel.delete(index);
      else ui.discardSel.add(index);
    } else {
      ui.selected = ui.selected === index ? null : index;
    }
    render();
    return;
  }

  const zoneEl = target.closest<HTMLElement>('.md-zone.can');
  if (zoneEl && ui.selected !== null) {
    const mandala = Number(zoneEl.dataset.mandala);
    const type = zoneEl.dataset.play === 'mountain' ? 'playMountain' : 'playField';
    context?.send({ type, payload: { card: ui.selected, mandala } });
    ui.selected = null;
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
  } else if (action === 'confirm-discard') {
    const cards = [...ui.discardSel].sort((a, b) => a - b);
    if (cards.length > 0) context?.send({ type: 'discard', payload: { cards } });
    ui.discardMode = false;
    ui.discardSel.clear();
  } else if (action === 'pick') {
    const color = Number(button.dataset.color);
    context?.send({ type: 'pickColor', payload: { color } });
  }
  render();
}

function mount(ctx: GameClientContext): void {
  ensureStyle();
  context = ctx;
  ui = { selected: null, discardMode: false, discardSel: new Set() };

  root = document.createElement('div');
  root.className = 'md-root';
  root.addEventListener('click', onClick);
  ctx.root.replaceChildren(root);
  render();
}

function update(next: ClientSnapshot): void {
  snapshot = next;
  // 状态变了（比如轮次切换），清掉可能失效的选中
  if (ui.selected !== null) {
    const data = next.view?.data as unknown as MandalaData | undefined;
    const hand = data?.you?.hand ?? [];
    if (ui.selected >= hand.length) ui.selected = null;
  }
  render();
}

function unmount(): void {
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
