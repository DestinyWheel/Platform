/**
 * 纸牌帮：前端。
 *
 * 原生 DOM，不依赖任何框架；所有状态都从 snapshot.view.data 里读，
 * 隐藏信息（别人的底牌）根本不会传到这里。
 */

import type { ClientSnapshot, GameClient, GameClientContext, LogEntry, PublicView } from '@platform/sdk';

const STYLE_ID = 'the-gang-style';

const CHIP_CLASS = ['', 'w', 'y', 'o', 'r'];
const CHIP_NAME = ['', '白', '黄', '橙', '红'];
const ROUND_NAME = ['翻牌前', '翻牌', '转牌', '河牌'];

interface Seat {
  player: string;
  chip: number;
  name: string;
  best?: string[];
  hand: string[];
  score: number[];
}

interface LastResult {
  heist: number;
  ok: boolean;
  seats: Seat[];
  community: string[];
  badAt: number | null;
}

interface GangData {
  heist: number;
  vaults: number;
  alarms: number;
  round: number;
  community: string[];
  chips: Record<string, (number | null)[]>;
  ready: Record<string, boolean>;
  hands: Record<string, string[]>;
  handsCount: Record<string, number>;
  you: string;
  revealed: boolean;
  last: LastResult | null;
  history: LastResult[];
  win: boolean | null;
}

const CSS = `
.gang {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0 8px;
  color: #e6edf3;
  font-size: 14px;
}
.gang-top {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid #262d38;
  border-radius: 12px;
  background: rgba(22, 27, 34, 0.72);
}
.gang-heist { font-weight: 650; }
.gang-progress { display: flex; gap: 18px; color: #8b98a7; font-size: 13px; }
.gang-dots { letter-spacing: 2px; }
.gang-dots.vault { color: #d9a521; }
.gang-dots.alarm { color: #f85149; }
.gang-round { margin-left: auto; color: #8b98a7; font-size: 13px; }
.gang-table {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.gang-seat {
  border: 1px solid #262d38;
  border-radius: 12px;
  background: rgba(20, 25, 32, 0.8);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gang-seat.me { border-color: #4c8dff; box-shadow: 0 0 0 1px rgba(76, 141, 255, 0.35); }
.gang-seat-name { font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gang-seat-name .tag { font-size: 11px; color: #8b98a7; font-weight: 400; }
.gang-seat-name .ready { color: #2ea043; font-size: 11px; }
.gang-chips { display: flex; gap: 6px; }
.gang-chip {
  width: 30px; height: 30px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #0e1116;
  border: 2px dotted rgba(0, 0, 0, 0.25);
  opacity: 0.5;
}
.gang-chip.w { background: #e7ecf3; }
.gang-chip.y { background: #f2c94c; }
.gang-chip.o { background: #f2994a; }
.gang-chip.r { background: #ef5f5f; }
.gang-chip.on { opacity: 1; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.12); }
.gang-center {
  border: 1px solid #262d38;
  border-radius: 12px;
  background: radial-gradient(circle at 50% 0%, rgba(46, 92, 60, 0.18), rgba(16, 22, 18, 0.9));
  padding: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.gang-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
.gang-card {
  width: 42px; height: 60px; border-radius: 7px;
  background: #f5f7fa; color: #10151c;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 15px;
  border: 1px solid #c9d3df;
}
.gang-card.dim { background: rgba(245, 247, 250, 0.07); color: transparent; border-style: dashed; border-color: #2f3a48; }
.gang-muted { color: #8b98a7; font-size: 12px; }
.gang-hand { display: flex; align-items: center; gap: 10px; }
.gang-hand .gang-card { width: 52px; height: 74px; font-size: 17px; }
.gang-controls {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  border: 1px solid #262d38; border-radius: 12px; padding: 10px 12px;
  background: rgba(22, 27, 34, 0.72);
}
.gang-pick {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 10px; cursor: pointer;
  border: 1px solid #2c3745; background: #1a212b;
}
.gang-pick:hover { border-color: #4c8dff; }
.gang-pick.held { border-color: #d9a521; background: rgba(217, 165, 33, 0.12); }
.gang-pick .who { font-size: 11px; color: #f2994a; }
.gang-btn {
  padding: 8px 16px; border-radius: 10px; border: 1px solid #2c3745;
  background: #1a212b; color: #e6edf3; cursor: pointer;
}
.gang-btn.primary { background: linear-gradient(180deg, #4c8dff, #3a72d8); border-color: transparent; font-weight: 600; }
.gang-btn.success { background: linear-gradient(180deg, #2ea043, #238636); border-color: transparent; font-weight: 600; }
.gang-result {
  border: 1px solid #262d38; border-radius: 14px; padding: 16px;
  background: rgba(20, 25, 32, 0.92);
  display: flex; flex-direction: column; gap: 10px;
}
.gang-result h3 { margin: 0; font-size: 16px; }
.gang-result.ok h3 { color: #3fb950; }
.gang-result.fail h3 { color: #f85149; }
.gang-seat-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.gang-seat-line .order { width: 22px; color: #8b98a7; font-size: 12px; }
.gang-seat-line.bad { background: rgba(248, 81, 73, 0.1); border-radius: 8px; padding: 4px 6px; }
.gang-empty { color: #8b98a7; font-size: 13px; }
`;

let root: HTMLElement | null = null;
let context: GameClientContext | null = null;
let snapshot: ClientSnapshot | null = null;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function nameOf(id: string): string {
  const player = (context?.players ?? []).find((item) => item.id === id);
  return player?.name ?? id.slice(0, 6);
}

function cardHtml(card: string): string {
  const suit = card.slice(-1);
  const red = suit === '♥' || suit === '♦';
  return `<span class="gang-card" style="${red ? 'color:#c0392b' : ''}">${card}</span>`;
}

function chipHtml(roundIndex: number, star: number | null): string {
  const color = CHIP_CLASS[roundIndex + 1] ?? 'w';
  if (star == null) return `<span class="gang-chip ${color}"></span>`;
  return `<span class="gang-chip ${color} on">${star}</span>`;
}

function dots(filled: number, total: number, kind: string): string {
  let text = '';
  for (let index = 0; index < total; index += 1) text += index < filled ? '●' : '○';
  return `<span class="gang-dots ${kind}">${text}</span>`;
}

function renderTop(data: GangData): string {
  return `
    <div class="gang-top">
      <div class="gang-heist">第 ${data.heist} 次抢劫</div>
      <div class="gang-progress">
        <span>金库 ${dots(data.vaults, 3, 'vault')}</span>
        <span>警报 ${dots(data.alarms, 3, 'alarm')}</span>
      </div>
      <div class="gang-round">${ROUND_NAME[data.round - 1] ?? ''} · ${CHIP_NAME[data.round] ?? ''}筹码</div>
    </div>`;
}

function renderTable(data: GangData, view: PublicView): string {
  const rows = view.players
    .map((player) => {
      const isMe = player === data.you;
      const ready = data.ready[player];
      const hasChip = data.chips[player]?.[data.round - 1] != null;
      const chips = [0, 1, 2, 3]
        .map((index) => chipHtml(index, data.chips[player]?.[index] ?? null))
        .join('');
      const stateText = hasChip ? (ready ? '<span class="ready">已确认</span>' : '还没确认') : '在挑筹码';
      return `
        <div class="gang-seat${isMe ? ' me' : ''}">
          <div class="gang-seat-name">
            ${nameOf(player)}${isMe ? '<span class="tag">你</span>' : ''}
            <span class="tag">${stateText}</span>
          </div>
          <div class="gang-chips">${chips}</div>
        </div>`;
    })
    .join('');

  return `<div class="gang-table">${rows}</div>`;
}

function renderCenter(data: GangData): string {
  const cards = data.community.length
    ? data.community.map((card) => cardHtml(card)).join('')
    : [0, 1, 2, 3, 4].map(() => '<span class="gang-card dim"></span>').join('');
  return `
    <div class="gang-center">
      <div class="gang-row">${cards}</div>
      <div class="gang-muted">公共牌 ${data.community.length} / 5</div>
    </div>`;
}

function renderHand(data: GangData): string {
  const mine = data.hands[data.you] ?? [];
  const cards = mine.length
    ? mine.map((card) => cardHtml(card)).join('')
    : '<span class="gang-muted">等发牌…</span>';
  return `<div class="gang-hand"><span class="gang-muted">你的底牌</span>${cards}</div>`;
}

function renderControls(data: GangData, view: PublicView): string {
  if (view.phase !== 'draft') return '';
  if (!view.players.includes(data.you)) {
    return '<div class="gang-controls"><span class="gang-muted">你在观战，等他们打</span></div>';
  }
  const roundIndex = data.round - 1;
  const mine = data.chips[data.you]?.[roundIndex] ?? null;
  const ready = data.ready[data.you];
  const total = Object.keys(data.chips).length;

  const holders: Record<number, string> = {};
  for (const [player, stars] of Object.entries(data.chips)) {
    const star = stars[roundIndex];
    if (star != null) holders[star] = player;
  }

  const picks: string[] = [];
  for (let star = 1; star <= total; star += 1) {
    const holder = holders[star];
    const heldByOther = holder != null && holder !== data.you;
    picks.push(`
      <button class="gang-pick${mine === star ? ' held' : ''}" data-act="take" data-star="${star}">
        <span class="gang-chip ${CHIP_CLASS[roundIndex + 1]} on">${star}</span>
        ${heldByOther ? `<span class="who">${nameOf(holder)}</span>` : ''}
      </button>`);
  }

  const confirm =
    mine == null
      ? '<span class="gang-muted">先拿一个筹码</span>'
      : ready
        ? '<span class="gang-muted">已确认，等其他人</span>'
        : '<button class="gang-btn primary" data-act="confirm">确认</button>';

  return `
    <div class="gang-controls">
      <span class="gang-muted">${ROUND_NAME[data.round - 1]} · 你觉得自己排第几？</span>
      ${picks.join('')}
      ${confirm}
    </div>`;
}

function renderResult(data: GangData, view: PublicView): string {
  const last = data.last;
  if (!last) return '';
  if (view.phase !== 'heistResult' && view.phase !== 'finished') return '';

  const lines = last.seats
    .map((seat, index) => {
      const bad = last.badAt === index;
      const cards = (seat.best ?? seat.hand).map((card) => cardHtml(card)).join('');
      return `
        <div class="gang-seat-line${bad ? ' bad' : ''}">
          <span class="order">${index + 1}</span>
          <span class="gang-chip r on">${seat.chip}</span>
          <strong>${nameOf(seat.player)}</strong>
          <span>${seat.name}</span>
          <span class="gang-row">${cards}</span>
        </div>`;
    })
    .join('');

  const title = last.ok ? '✓ 这次抢劫成了' : '✗ 有人排错了，警报响了';
  const footer =
    view.phase === 'heistResult'
      ? '<button class="gang-btn success" data-act="advance">继续下一次</button>'
      : '';

  return `
    <div class="gang-result ${last.ok ? 'ok' : 'fail'}">
      <h3>${title}</h3>
      <div class="gang-muted">按红筹码从小到大亮牌</div>
      ${lines}
      ${footer}
    </div>`;
}

function renderFinish(data: GangData): string {
  if (data.win == null) return '';
  return `
    <div class="gang-result ${data.win ? 'ok' : 'fail'}">
      <h3>${data.win ? '三个金库到手，你们赢了' : '三次警报，这次栽了'}</h3>
      <div class="gang-muted">合作局，不计分。想再来一次就回大厅开新桌。</div>
    </div>`;
}

function render(): void {
  if (!root || !context || !snapshot) return;
  const view = snapshot.view;
  if (!view) {
    root.innerHTML = '<div class="gang-empty">等开局…</div>';
    return;
  }

  const data = view.data as unknown as GangData;
  const parts = [renderTop(data), renderTable(data, view), renderCenter(data), renderHand(data)];

  if (view.finished) {
    parts.push(renderResult(data, view), renderFinish(data));
  } else {
    parts.push(renderControls(data, view), renderResult(data, view));
  }

  root.innerHTML = `<div class="gang">${parts.join('')}</div>`;
}

function onClick(event: Event): void {
  const target = (event.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!target || !context) return;

  const act = target.dataset.act;
  if (act === 'take') {
    const star = Number(target.dataset.star);
    if (Number.isFinite(star)) context.send({ type: 'takeChip', payload: { star } });
  } else if (act === 'confirm') {
    context.send({ type: 'confirm', payload: {} });
  } else if (act === 'advance') {
    context.send({ type: 'advance', payload: {} });
  }
}

function mount(next: GameClientContext): void {
  ensureStyle();
  context = next;
  root = document.createElement('div');
  root.className = 'gang-root';
  next.root.append(root);
  next.root.addEventListener('click', onClick);
  render();
}

function update(next: ClientSnapshot): void {
  snapshot = next;
  render();
}

function unmount(): void {
  context?.root.removeEventListener('click', onClick);
  root?.remove();
  root = null;
  context = null;
  snapshot = null;
}

function formatLog(entry: LogEntry): string | null {
  const args = entry.args ?? {};
  const who = nameOf(String(args.player ?? args.by ?? ''));
  switch (entry.key) {
    case 'thegang.take':
      return `${who} 拿了 ${args.star} 星筹码`;
    case 'thegang.steal':
      return `${who} 从 ${nameOf(String(args.from))} 手里抢走了 ${args.star} 星`;
    case 'thegang.ready':
      return `${who} 确认了`;
    case 'thegang.round':
      return `进入${ROUND_NAME[Number(args.round) - 1] ?? ''}，公共牌 ${args.community}`;
    case 'thegang.heistWin':
      return `✓ 第 ${args.heist} 次抢劫成功，金库卡翻金`;
    case 'thegang.heistFail':
      return `✗ 第 ${args.heist} 次抢劫失败，警报卡翻红`;
    case 'thegang.heist':
      return `第 ${args.heist} 次抢劫开始`;
    case 'thegang.gameEnd':
      return args.win ? '三个金库到手，赢了' : '三次警报，输了';
    default:
      return null;
  }
}

const client: GameClient = { mount, update, unmount, formatLog };

export default client;
export { client };
