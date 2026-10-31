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
  guess: { kind: 'value' | 'rank'; value: string; ok: boolean } | null;
}

interface CardInfo {
  id: number;
  name: string;
  text: string;
}

interface GuessInfo {
  kind: 'value' | 'rank';
  target: string;
  voted: string[];
  mine: string | null;
}

interface GangData {
  heist: number;
  vaults: number;
  alarms: number;
  alarmsToLose: number;
  mode: string;
  modeName: string;
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
  challenge: number[];
  challengeInfo: CardInfo[];
  specialist: number | null;
  permanent: number | null;
  blackoutRounds: number[];
  guess: GuessInfo | null;
  guessOk: boolean | null;
  specialistInfo: { id: number; name: string; text: string } | null;
  specialistUsed: boolean;
  specialistOwner: string | null;
  notes: { kind: string; player?: string; value?: number | string }[];
  secrets: string[];
  pending: { player: string; kind: string } | null;
  muscle: string | null;
}

const RANKS_ORDER = [
  ['皇家同花顺', '10-A 同花'],
  ['同花顺', '连号同花'],
  ['四条', '四张同点'],
  ['葫芦', '三条 + 一对'],
  ['同花', '五张同花'],
  ['顺子', '五张连号'],
  ['三条', '三张同点'],
  ['两对', '两组对子'],
  ['一对', '两张同点'],
  ['高牌', '什么都没有'],
];

function renderRail(data: GangData): string {
  const ranks = RANKS_ORDER.map(
    ([name, hint], index) =>
      `<li><span>${index + 1}. ${name}</span><span>${hint}</span></li>`,
  ).join('');

  const notes = (data.notes ?? []).map((note) => `<div class="gang-note">${noteText(note)}</div>`).join('');
  const secrets = (data.secrets ?? [])
    .map((card) => `<div class="gang-secret">线人给你看的牌：${card}</div>`)
    .join('');

  return `
    <aside class="gang-rail">
      <div class="gang-rank">
        <h4>牌型顺序</h4>
        <ul class="gang-rank-list">${ranks}</ul>
      </div>
      ${notes || secrets ? `<div class="gang-notes"><h4>牌桌信息</h4>${notes}${secrets}</div>` : ''}
    </aside>`;
}

function noteText(note: GangData['notes'][number]): string {
  const who = note.player ? nameOf(note.player) : '';
  switch (note.kind) {
    case 'investor':
      return `投资人 · ${who}：${note.value} 张人头牌`;
    case 'math':
      return `数学老师 · ${who}：点数合计 ${note.value}`;
    case 'informant':
      return `线人 · ${who} 给 ${nameOf(String(note.value))} 看了一张底牌`;
    case 'driver':
      return `老司机 · ${who}：现在的牌型是 ${note.value}`;
    case 'mastermind':
      return `主谋 · ${who}：${note.value}`;
    case 'muscle':
      return `打手 · ${who}：同牌型时他更大`;
    case 'conartist':
      return '女骗子：底牌全部混洗后重新发过';
    case 'coordinator':
      return '协调者：每人把一张底牌传给了左手边';
    default:
      return `${who} ${note.value ?? ''}`.trim();
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  highcard: '高牌',
  pair: '一对',
  twopair: '两对',
  trips: '三条',
  straight: '顺子',
  flush: '同花',
  fullhouse: '葫芦',
  quads: '四条',
  straightflush: '同花顺',
  royalflush: '皇家同花顺',
};

const VALUE_CHOICES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const CSS = `
.gang {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 208px;
  gap: 14px;
  align-items: start;
  padding: 4px 0 8px;
  color: #e6edf3;
  font-size: 14px;
}
.gang-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.gang-rail { display: flex; flex-direction: column; gap: 10px; position: sticky; top: 12px; }
@media (max-width: 1080px) {
  .gang { grid-template-columns: minmax(0, 1fr); }
  .gang-rail { position: static; }
  .gang-rank-list { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; }
}
.gang-rank {
  border: 1px solid #262d38;
  border-radius: 12px;
  background: rgba(22, 27, 34, 0.72);
  padding: 10px 12px;
}
.gang-rank h4 { margin: 0 0 8px; font-size: 12px; color: #8b98a7; font-weight: 600; letter-spacing: 0.05em; }
.gang-rank-list { display: flex; flex-direction: column; gap: 3px; }
.gang-rank-list li { display: flex; justify-content: space-between; font-size: 12.5px; color: #c9d3df; }
.gang-rank-list li span:last-child { color: #8b98a7; font-size: 11px; }
.gang-notes {
  border: 1px solid #262d38;
  border-radius: 12px;
  background: rgba(22, 27, 34, 0.72);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gang-notes h4 { margin: 0; font-size: 12px; color: #8b98a7; font-weight: 600; }
.gang-note { font-size: 12.5px; color: #c9d3df; }
.gang-secret { font-size: 12.5px; color: #d9a521; }
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
.gang-mode {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #2c3745;
  color: #8b98a7;
}
.gang-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid #3a2f1a;
  border-radius: 12px;
  background: rgba(217, 165, 33, 0.08);
  padding: 10px 12px;
}
.gang-card-item { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 13px; }
.gang-card-item strong { color: #d9a521; font-weight: 600; }
.gang-card-item span { color: #c9d3df; }
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
  width: 46px; height: 64px; border-radius: 7px;
  background: #f5f7fa; color: #10151c;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  border: 1px solid #c9d3df;
  line-height: 1.02;
}
.gang-card b { font-size: 21px; font-weight: 750; letter-spacing: -0.02em; }
.gang-card i { font-size: 18px; font-style: normal; }
.gang-card.dim { background: rgba(245, 247, 250, 0.07); color: transparent; border-style: dashed; border-color: #2f3a48; }
.gang-muted { color: #8b98a7; font-size: 12px; }
.gang-hand { display: flex; align-items: center; gap: 10px; }
.gang-hand .gang-card { width: 66px; height: 92px; }
.gang-hand .gang-card b { font-size: 30px; }
.gang-hand .gang-card i { font-size: 26px; }
.gang-controls {
  display: flex; flex-direction: column; gap: 10px;
  border: 1px solid #262d38; border-radius: 12px; padding: 10px 12px;
  background: rgba(22, 27, 34, 0.72);
}
.gang-picks { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gang-actions { display: flex; align-items: center; gap: 10px; min-height: 36px; }
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
  if (suit === '*') {
    // 老千那张万能 J：没有花色
    return `<span class="gang-card" style="border-color:#d9a521"><b>J</b><i style="color:#8b98a7">★</i></span>`;
  }
  const rank = card.slice(0, -1);
  return `<span class="gang-card" style="${red ? 'color:#c0392b' : ''}"><b>${rank}</b><i>${suit}</i></span>`;
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
      <span class="gang-mode">${data.modeName ?? ''}</span>
      <div class="gang-progress">
        <span>金库 ${dots(data.vaults, 3, 'vault')}</span>
        <span>警报 ${dots(data.alarms, data.alarmsToLose ?? 3, 'alarm')}</span>
      </div>
      <div class="gang-round">${ROUND_NAME[data.round - 1] ?? ''} · ${CHIP_NAME[data.round] ?? ''}筹码</div>
    </div>`;
}

function renderCards(data: GangData): string {
  const cards = data.challengeInfo ?? [];
  const blackout = (data.blackoutRounds ?? []).length > 0;
  if (cards.length === 0 && !blackout) return '';
  const items = cards
    .map(
      (card) =>
        `<div class="gang-card-item"><strong>挑战 · ${card.name}</strong><span>${card.text}</span></div>`,
    )
    .join('');
  const blackoutLine = blackout
    ? `<div class="gang-muted">断电：第 ${data.blackoutRounds.join('、')} 轮的筹码已经丢弃</div>`
    : '';
  return `<div class="gang-cards">${items}${blackoutLine}</div>`;
}

function renderGuess(data: GangData, view: PublicView): string {
  if (view.phase !== 'guess' || !data.guess) return '';
  const guess = data.guess;
  const isTarget = guess.target === data.you;
  const voted = guess.voted.length;
  const total = view.players.length - 1;

  const choices =
    guess.kind === 'value'
      ? VALUE_CHOICES.map(
          (value) =>
            `<button class="gang-pick${guess.mine === value ? ' held' : ''}" data-act="guess" data-value="${value}">${value}</button>`,
        ).join('')
      : Object.entries(CATEGORY_LABEL)
          .map(
            ([key, label]) =>
              `<button class="gang-pick${guess.mine === key ? ' held' : ''}" data-act="guess" data-value="${key}">${label}</button>`,
          )
          .join('');

  const prompt =
    guess.kind === 'value'
      ? `猜 ${nameOf(guess.target)} 手里至少有一张什么点数`
      : `猜 ${nameOf(guess.target)} 最后是什么牌型`;

  if (isTarget) {
    return `
      <div class="gang-controls">
        <div class="gang-picks">
          <span class="gang-muted">${prompt}——你是被猜的人，不能参与</span>
          <span class="gang-muted">已投 ${voted}/${total}</span>
        </div>
      </div>`;
  }

  return `
    <div class="gang-controls">
      <div class="gang-picks">
        <span class="gang-muted">${prompt}（要全队一致）</span>
        ${choices}
        <span class="gang-muted">已投 ${voted}/${total}${guess.mine ? ' · 你选了 ' + (guess.kind === 'value' ? guess.mine : CATEGORY_LABEL[guess.mine]) : ''}</span>
      </div>
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
      <div class="gang-picks">
        <span class="gang-muted">${ROUND_NAME[data.round - 1]} · 你觉得自己排第几？</span>
        ${picks.join('')}
      </div>
      <div class="gang-actions">${confirm}</div>
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

  const title = last.ok
    ? '✓ 这次抢劫成了'
    : last.guess && !last.guess.ok
      ? '✗ 全队猜错了，警报响了'
      : '✗ 有人排错了，警报响了';
  const guessLine = last.guess
    ? `<div class="gang-muted">全队猜的是 <strong>${last.guess.kind === 'value' ? last.guess.value : CATEGORY_LABEL[last.guess.value] ?? last.guess.value}</strong> · ${last.guess.ok ? '猜对了' : '猜错了，这次抢劫直接失败'}</div>`
    : '';
  const footer =
    view.phase === 'heistResult'
      ? '<button class="gang-btn success" data-act="advance">继续下一次</button>'
      : '';

  return `
    <div class="gang-result ${last.ok ? 'ok' : 'fail'}">
      <h3>${title}</h3>
      ${guessLine}
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

let useStep: { kind: 'target' | 'card' | 'value'; target?: string } | null = null;

function renderSpecialist(data: GangData, view: PublicView): string {
  const info = data.specialistInfo;
  if (!info) return '';
  const mine = data.you;
  const amPlayer = view.players.includes(mine);

  const header = `<div class="gang-picks"><span class="gang-muted">专家卡</span><strong>${info.name}</strong><span class="gang-muted">${info.text}</span></div>`;

  if (data.specialistUsed) {
    const who = data.specialistOwner ? `（${nameOf(data.specialistOwner)}）` : '';
    return `<div class="gang-controls">${header}<div class="gang-actions"><span class="gang-muted">已经用过了${who}</span></div></div>`;
  }

  if (data.pending?.player === mine) {
    const cards = (data.hands[mine] ?? [])
      .map(
        (card, index) =>
          `<button class="gang-pick" data-act="spec-discard" data-index="${index}">${cardHtml(card)}</button>`,
      )
      .join('');
    return `<div class="gang-controls">${header}<div class="gang-actions"><span class="gang-muted">多了一张，选一张弃掉</span>${cards}</div></div>`;
  }

  if (!amPlayer) {
    return `<div class="gang-controls">${header}<div class="gang-actions"><span class="gang-muted">等他们决定要不要用</span></div></div>`;
  }

  if (info.id === 3 || info.id === 6 || info.id === 8 || info.id === 9) {
    return `<div class="gang-controls">${header}<div class="gang-actions"><span class="gang-muted">发牌时已经自动生效</span></div></div>`;
  }

  if (!useStep) {
    return `<div class="gang-controls">${header}<div class="gang-actions"><button class="gang-btn primary" data-act="spec-use">使用专家卡</button></div></div>`;
  }

  if (useStep.kind === 'target') {
    const targets = view.players
      .filter((player) => player !== mine)
      .map(
        (player) =>
          `<button class="gang-pick" data-act="spec-target" data-target="${player}">${nameOf(player)}</button>`,
      )
      .join('');
    return `<div class="gang-controls">${header}<div class="gang-actions"><span class="gang-muted">给谁看？</span>${targets}</div></div>`;
  }

  if (useStep.kind === 'card') {
    const cards = (data.hands[mine] ?? [])
      .map(
        (card, index) =>
          `<button class="gang-pick" data-act="spec-card" data-index="${index}">${cardHtml(card)}</button>`,
      )
      .join('');
    return `<div class="gang-controls">${header}<div class="gang-actions"><span class="gang-muted">给他看哪一张？</span>${cards}</div></div>`;
  }

  const values = VALUE_CHOICES.map(
    (value) =>
      `<button class="gang-pick" data-act="spec-value" data-value="${value}">${value}</button>`,
  ).join('');
  return `<div class="gang-controls">${header}<div class="gang-actions"><span class="gang-muted">问哪个点数？</span>${values}</div></div>`;
}

function render(): void {
  if (!root || !context || !snapshot) return;
  const view = snapshot.view;
  if (!view) {
    root.innerHTML = '<div class="gang-empty">等开局…</div>';
    return;
  }

  const data = view.data as unknown as GangData;
  const parts = [
    renderTop(data),
    renderCards(data),
    view.finished ? '' : renderSpecialist(data, view),
    renderTable(data, view),
    renderCenter(data),
    renderHand(data),
  ];

  if (view.finished) {
    parts.push(renderResult(data, view), renderFinish(data));
  } else {
    parts.push(renderControls(data, view), renderGuess(data, view), renderResult(data, view));
  }

  root.innerHTML = `<div class="gang"><div class="gang-main">${parts.join('')}</div>${renderRail(data)}</div>`;
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
  } else if (act === 'guess') {
    const value = target.dataset.value;
    if (value) context.send({ type: 'guess', payload: { value } });
  } else if (act === 'spec-use') {
    const id = (snapshot?.view?.data as unknown as GangData | undefined)?.specialistInfo?.id;
    if (id === 1) useStep = { kind: 'target' };
    else if (id === 4) useStep = { kind: 'value' };
    else context.send({ type: 'useSpecialist', payload: {} });
    render();
  } else if (act === 'spec-target') {
    useStep = { kind: 'card', target: target.dataset.target };
    render();
  } else if (act === 'spec-card') {
    const index = Number(target.dataset.index);
    if (useStep?.target != null) {
      context.send({ type: 'useSpecialist', payload: { target: useStep.target, card: index } });
    }
    useStep = null;
    render();
  } else if (act === 'spec-value') {
    const value = target.dataset.value;
    if (value) context.send({ type: 'useSpecialist', payload: { value } });
    useStep = null;
    render();
  } else if (act === 'spec-discard') {
    const index = Number(target.dataset.index);
    if (Number.isFinite(index)) context.send({ type: 'discard', payload: { index } });
  }
}

function mount(next: GameClientContext): void {
  ensureStyle();
  context = next;
  root = document.createElement('div');
  root.className = 'gang-root';
  next.root.append(root);
  next.root.addEventListener('pointerdown', onClick);
  render();
}

function update(next: ClientSnapshot): void {
  snapshot = next;
  render();
}

function unmount(): void {
  context?.root.removeEventListener('pointerdown', onClick);
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
