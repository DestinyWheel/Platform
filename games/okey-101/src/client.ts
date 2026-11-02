/**
 * 土耳其麻将 / 101 Okey —— 前端。原生 DOM + 内联 CSS，无图片。
 */
import type { ClientSnapshot, GameClient, GameClientContext, LogEntry } from '@platform/sdk';
import {
  COLOR_NAME,
  TILE_BY_ID,
  isWild,
  sortHand,
  tileName,
  type OkeyDef,
  type Tile,
} from './tiles';
import { checkMeld, validateOpening, validateTable } from './meld';

const STYLE_ID = 'okey-101-style';

const COLOR_HEX: Record<string, string> = {
  red: '#c94b4b',
  yellow: '#d9b23c',
  blue: '#3f6fb5',
  black: '#2a2f36',
};

const CSS = `
.ok-root { display: flex; flex-direction: column; gap: 12px; color: #e6edf3; }
.ok-topbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 14px; border: 1px solid #262d38; border-radius: 12px; background: rgba(22,27,34,.72); }
.ok-turn { font-weight: 700; }
.ok-muted { color: #8b98a7; font-size: 12px; }
.ok-badge { border: 1px solid #2c3745; border-radius: 999px; padding: 2px 8px; font-size: 11px; color: #c3ccd8; }
.ok-seats { display: flex; gap: 8px; flex-wrap: wrap; }
.ok-seat { border: 1px solid #262d38; border-radius: 10px; background: rgba(20,25,32,.8); padding: 7px 10px; min-width: 150px; display: flex; flex-direction: column; gap: 3px; }
.ok-seat.me { border-color: #4c8dff; }
.ok-seat-name { font-weight: 650; font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ok-center { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(260px, .7fr); gap: 12px; }
@media (max-width: 900px) { .ok-center { grid-template-columns: 1fr; } }
.ok-box { border: 1px solid #262d38; border-radius: 12px; background: rgba(20,25,32,.8); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.ok-box-title { font-size: 12px; color: #8b98a7; }
.ok-center-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.ok-tile { width: 34px; height: 46px; border-radius: 7px; border: 1px solid rgba(0,0,0,.4); display: inline-flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; line-height: 1.05; font-weight: 750; color: #11161d; box-shadow: inset 0 1px 2px rgba(255,255,255,.28); padding: 0; cursor: default; flex: none; }
button.ok-tile { cursor: pointer; }
.ok-tile.red { background: #c94b4b; color: #fff; } .ok-tile.yellow { background: #d9b23c; }
.ok-tile.blue { background: #3f6fb5; color: #fff; } .ok-tile.black { background: #2a2f36; color: #fff; }
.ok-tile.fake { background: linear-gradient(135deg, #4b5563, #2a2f36); color: #f0dfb0; border-color: #d9c9a3; }
.ok-tile.wild { border: 2px solid #f2c94c; box-shadow: 0 0 0 1px rgba(242,201,76,.35); }
.ok-tile.sel { outline: 2px solid #4c8dff; outline-offset: 2px; }
.ok-tile .num { font-size: 16px; }
.ok-tile .tag { font-size: 8px; opacity: .85; }
.ok-hand { display: flex; gap: 5px; flex-wrap: wrap; min-height: 50px; }
.ok-melds { display: flex; gap: 10px; flex-wrap: wrap; }
.ok-meld { border: 1px solid #2c3745; border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 4px; background: rgba(15,20,27,.7); }
.ok-meld-tiles { display: flex; gap: 3px; flex-wrap: wrap; }
.ok-meld-label { font-size: 10px; color: #8b98a7; }
.ok-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ok-btn { padding: 7px 12px; border-radius: 9px; border: 1px solid #2c3745; background: #1a212b; color: #e6edf3; cursor: pointer; font-size: 13px; }
.ok-btn:hover { border-color: #4c8dff; }
.ok-btn.primary { background: linear-gradient(180deg, #4c8dff, #3a72d8); border-color: transparent; font-weight: 650; }
.ok-btn:disabled { opacity: .4; cursor: default; }
.ok-hint { border: 1px dashed #2c3745; border-radius: 10px; padding: 7px 9px; color: #aab6c4; font-size: 12px; }
.ok-win { border: 1px solid #3f6f4a; background: rgba(30,60,38,.6); border-radius: 10px; padding: 8px 10px; color: #9fe0ac; font-size: 13px; }
.ok-lose { border: 1px solid #6f3f3f; background: rgba(60,30,30,.5); border-radius: 10px; padding: 8px 10px; color: #f0b0b0; font-size: 13px; }
.ok-modal { position: absolute; inset: 0; background: rgba(6,9,13,.78); display: flex; align-items: center; justify-content: center; z-index: 8; padding: 16px; }
.ok-modal-card { width: min(720px, 100%); max-height: 88vh; overflow-y: auto; border: 1px solid #3a4656; border-radius: 16px; background: #121821; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ok-modal h3 { margin: 0; font-size: 16px; }
.ok-groups { display: flex; flex-direction: column; gap: 8px; }
.ok-group { border: 1px solid #2c3745; border-radius: 10px; padding: 7px; display: flex; flex-direction: column; gap: 5px; }
.ok-group.sel { border-color: #4c8dff; box-shadow: 0 0 0 1px rgba(76,141,255,.3); }
.ok-group-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: #8b98a7; }
.ok-group-tiles { display: flex; gap: 3px; flex-wrap: wrap; }
.ok-pool { display: flex; gap: 4px; flex-wrap: wrap; min-height: 48px; border: 1px dashed #2c3745; border-radius: 10px; padding: 6px; }
.ok-goal { font-size: 12px; color: #aab6c4; }
`;

interface PlayerInfo {
  id: string;
  handCount: number;
  hand: string[] | null;
  opened: 'score' | 'pairs' | null;
  openingValue: number;
  score: number;
}
interface MeldInfo {
  id: string;
  kind: 'set' | 'run' | 'pair';
  tiles: string[];
  owner: string;
}
interface OkeyData {
  deckCount: number;
  indicator: string;
  okey: OkeyDef;
  discardTop: string | null;
  discardCount: number;
  melds: MeldInfo[];
  players: PlayerInfo[];
  scores: Record<string, number>;
  opened: Record<string, 'score' | 'pairs' | null>;
  openingValue: Record<string, number>;
  roundsTotal: number;
  dealer: number;
  tookDiscard: string | null;
  lastRound: {
    round: number;
    winner: string | null;
    reason: 'win' | 'wall';
    roundScores: Record<string, number>;
    totals: Record<string, number>;
  } | null;
  you: string | null;
}

let root: HTMLElement | null = null;
let context: GameClientContext | null = null;
let snapshot: ClientSnapshot | null = null;
let selectedHand: string | null = null;
let builderMode: 'open' | 'rearrange' | null = null;
let builderGroups: string[][] = [];
let builderPool: string[] = [];
let builderSelected = 0;
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

function dataOf(): OkeyData | null {
  return (snapshot?.view?.data as unknown as OkeyData | undefined) ?? null;
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

function playerOf(id: string): PlayerInfo | null {
  return dataOf()?.players.find((player) => player.id === id) ?? null;
}

function tilesOf(ids: string[]): Tile[] {
  return ids.map((id) => TILE_BY_ID[id]).filter((tile): tile is Tile => tile != null);
}

function tileFace(tile: Tile | null, okey: OkeyDef, options: { selected?: boolean; tag?: string } = {}): string {
  if (!tile) return '';
  const wild = !tile.fake && isWild(tile, okey);
  const classes = ['ok-tile', tile.fake ? 'fake' : tile.color, wild ? 'wild' : '', options.selected ? 'sel' : '']
    .filter(Boolean)
    .join(' ');
  const label = tile.fake ? '假' : String(tile.number);
  const tag = options.tag ?? (wild ? 'Okey' : tile.fake ? '假' : '');
  return `<span class="${classes}" title="${tileName(tile, okey)}"><span class="num">${label}</span>${
    tag ? `<span class="tag">${tag}</span>` : ''
  }</span>`;
}

function tileButton(tileId: string, okey: OkeyDef, attributes: string, options: { selected?: boolean } = {}): string {
  const tile = TILE_BY_ID[tileId];
  if (!tile) return '';
  return `<button class="ok-tile ${tile.fake ? 'fake' : tile.color} ${
    !tile.fake && isWild(tile, okey) ? 'wild' : ''
  } ${options.selected ? 'sel' : ''}" ${attributes} title="${tileName(tile, okey)}"><span class="num">${
    tile.fake ? '假' : tile.number
  }</span><span class="tag">${tile.fake ? '假' : !tile.fake && isWild(tile, okey) ? 'Okey' : ''}</span></button>`;
}

function renderSeat(player: PlayerInfo, isMe: boolean): string {
  return `<div class="ok-seat${isMe ? ' me' : ''}">
    <div class="ok-seat-name">${nameOf(player.id)}${isMe ? '（你）' : ''}
      <span class="ok-badge">${player.score} 分</span>
    </div>
    <div class="ok-muted">手牌 ${player.handCount} 张 · ${
      player.opened ? (player.opened === 'pairs' ? '对子开牌' : `开牌 ${player.openingValue} 分`) : '未开牌'
    }</div>
  </div>`;
}

function renderTable(data: OkeyData): string {
  const melds = data.melds
    .map(
      (meld) =>
        `<div class="ok-meld"><span class="ok-meld-label">${
          meld.kind === 'pair' ? '对子' : meld.kind === 'run' ? '顺子' : '组'
        } · ${nameOf(meld.owner)}</span><span class="ok-meld-tiles">${meld.tiles
          .map((id) => tileFace(TILE_BY_ID[id] ?? null, data.okey))
          .join('')}</span></div>`,
    )
    .join('');
  return `<div class="ok-box"><div class="ok-box-title">场上牌型</div><div class="ok-melds">${
    melds || '<span class="ok-muted">还没有人开牌</span>'
  }</div></div>`;
}

function renderCenter(data: OkeyData): string {
  const indicator = TILE_BY_ID[data.indicator] ?? null;
  const okeyTile: Tile = { id: 'okey-display', color: data.okey.color, number: data.okey.number };
  const discardTile = data.discardTop ? TILE_BY_ID[data.discardTop] ?? null : null;
  return `<div class="ok-box">
    <div class="ok-center-row">
      <div class="ok-box-title">指示牌</div>${tileFace(indicator, data.okey)}
      <div class="ok-box-title">Okey</div>${tileFace(okeyTile, data.okey, { tag: '万能' })}
      <div class="ok-box-title">牌堆</div><span class="ok-badge">${data.deckCount}</span>
      <div class="ok-box-title">弃牌</div>${tileFace(discardTile, data.okey)}<span class="ok-muted">共 ${data.discardCount}</span>
    </div>
  </div>`;
}

function hasMove(type: string, predicate?: (payload: Record<string, unknown>) => boolean): boolean {
  return (snapshot?.legalMoves ?? []).some((move) => {
    if (move.type !== type) return false;
    return predicate ? predicate((move.payload ?? {}) as Record<string, unknown>) : true;
  });
}

function renderActions(data: OkeyData): string {
  const view = snapshot?.view;
  if (!view) return '';
  if (view.finished) return '<div class="ok-win">对局结束</div>';
  if (!isMyTurn()) return '<div class="ok-hint">等对手行动…</div>';
  const me = playerOf(meId() ?? '');
  if (!me) return '<div class="ok-hint">你在观战</div>';

  if (view.phase === 'draw') {
    return `<div class="ok-box">
      <div class="ok-hint">摸一张，或吃上家弃牌（吃弃牌必须当回合用掉）。</div>
      <div class="ok-btns">
        <button class="ok-btn primary" data-act="draw" ${hasMove('draw') ? '' : 'disabled'}>摸牌</button>
        <button class="ok-btn" data-act="take-discard" ${hasMove('takeDiscard') ? '' : 'disabled'}>吃弃牌 ${
          data.discardTop ? tileFace(TILE_BY_ID[data.discardTop] ?? null, data.okey) : ''
        }</button>
      </div>
    </div>`;
  }

  const took = data.tookDiscard
    ? `<div class="ok-hint">你拿的弃牌：${tileFace(TILE_BY_ID[data.tookDiscard] ?? null, data.okey)}，必须先用于牌型，或放回弃牌堆改为摸牌。</div>`
    : '';
  const discardButton = selectedHand
    ? `<button class="ok-btn primary" data-act="discard" ${hasMove('discard') ? '' : 'disabled'}>弃掉选中的牌</button>`
    : '<span class="ok-muted">点手牌选中，再弃掉</span>';
  return `<div class="ok-box">
    ${took ||
      '<div class="ok-hint">摸牌/吃牌后：可以先开牌或整理牌型，然后必须弃一张。</div>'}
    <div class="ok-btns">
      ${discardButton}
      ${
        me.opened == null
          ? '<button class="ok-btn" data-act="open-builder">开牌</button>'
          : '<button class="ok-btn" data-act="rearrange-builder">整理牌型</button>'
      }
      ${data.tookDiscard ? '<button class="ok-btn" data-act="return-discard">放回弃牌堆并摸牌</button>' : ''}
    </div>
  </div>`;
}

function builderCheck(groups: string[][], data: OkeyData): string {
  if (groups.some((group) => group.length === 0)) return '有空的牌组';
  const tiles = groups.map((group) => tilesOf(group));
  if (tiles.some((group, index) => group.length !== groups[index]!.length)) return '有牌不存在';
  if (builderMode === 'open') {
    const result = validateOpening(tiles, data.okey);
    if (result?.route === 'pairs') return `对子开牌：${groups.length} 对`;
    if (result?.route === 'score') return `分数开牌：${result.value} 分`;
    const total = tiles.reduce((sum, group) => sum + (checkMeld(group, data.okey)?.value ?? 0), 0);
    return `还不满足：目前 ${total} 分（需要 ≥101 或 5 对）`;
  }
  const route = data.opened[meId() ?? ''] ?? 'score';
  return validateTable(tiles, data.okey, route) ? '整理合法' : '有牌组不合法（每组要 ≥3，对子路线每组 2）';
}

function renderBuilder(data: OkeyData): string {
  if (!builderMode) return '';
  const routeLabel = builderMode === 'open' ? '开牌（破冰）' : '整理场上牌型';
  const groups = builderGroups
    .map((group, index) => {
      const tiles = tilesOf(group);
      const check = checkMeld(tiles, data.okey);
      return `<div class="ok-group${index === builderSelected ? ' sel' : ''}">
        <div class="ok-group-head">
          <button class="ok-btn" data-act="select-group" data-group="${index}">第 ${index + 1} 组</button>
          <span>${check ? `${check.kind === 'pair' ? '对子' : check.kind === 'run' ? '顺子' : '组'} · ${check.value} 分` : group.length === 0 ? '空' : '不合法'}</span>
        </div>
        <div class="ok-group-tiles">${group
          .map((id) => tileButton(id, data.okey, `data-act="group-tile" data-group="${index}" data-tile="${id}"`))
          .join('')}</div>
      </div>`;
    })
    .join('');
  return `<div class="ok-modal"><div class="ok-modal-card">
    <h3>${routeLabel}</h3>
    <div class="ok-hint">点下面的手牌加入“当前组”；点组里的牌可以拆回手牌。真实校验以提交后的服务端为准。</div>
    <div class="ok-btns">
      <button class="ok-btn" data-act="new-group">新建一组</button>
      <button class="ok-btn" data-act="delete-group" ${builderGroups.length ? '' : 'disabled'}>删除当前组</button>
      <span class="ok-muted">${builderCheck(builderGroups, data)}</span>
    </div>
    <div class="ok-groups">${groups || '<span class="ok-muted">还没有牌组</span>'}</div>
    <div class="ok-box-title">手牌（未入组）</div>
    <div class="ok-pool">${builderPool
      .map((id) => tileButton(id, data.okey, `data-act="pool-tile" data-tile="${id}"`))
      .join('')}</div>
    <div class="ok-btns">
      <button class="ok-btn primary" data-act="submit-builder">提交${builderMode === 'open' ? '开牌' : '整理'}</button>
      <button class="ok-btn" data-act="cancel-builder">取消</button>
    </div>
  </div></div>`;
}

function renderSummary(data: OkeyData, view: NonNullable<ClientSnapshot['view']>): string {
  if (view.finished && view.ranking) {
    const winners = view.ranking[0] ?? [];
    return `<div class="ok-win">${winners.map((id) => nameOf(id)).join('、')} 获胜！${Object.entries(data.scores)
      .map(([id, score]) => `${nameOf(id)} ${score}`)
      .join(' · ')}</div>`;
  }
  if (data.lastRound) {
    const round = data.lastRound;
    return `<div class="ok-hint">第 ${round.round} 轮结束：${
      round.winner ? `${nameOf(round.winner)} 胡牌` : '牌堆摸完'
    } · ${Object.entries(round.roundScores)
      .map(([id, score]) => `${nameOf(id)} ${score > 0 ? '+' : ''}${score}`)
      .join(' / ')}</div>`;
  }
  return '';
}

function render(): void {
  if (!root || !context) return;
  const view = snapshot?.view;
  if (!view) {
    root.innerHTML = '<div class="ok-muted">等待对局开始…</div>';
    return;
  }
  const data = dataOf();
  if (!data) {
    root.innerHTML = '<div class="ok-muted">等待牌桌数据…</div>';
    return;
  }
  const me = meId();
  const mePlayer = me ? playerOf(me) : null;
  const hand = mePlayer?.hand ?? [];
  const sortedHand = mePlayer && mePlayer.hand ? sortHand(hand, data.okey) : [];
  const phaseName: Record<string, string> = { draw: '摸牌', play: '出牌', finished: '结束' };

  root.innerHTML = `<div class="ok-root">
    <div class="ok-topbar">
      <span class="ok-turn">${view.finished ? '对局结束' : `${nameOf(view.turn ?? '')} 的回合`}</span>
      <span class="ok-badge">第 ${view.round} / ${data.roundsTotal} 轮</span>
      <span class="ok-badge">${phaseName[view.phase] ?? view.phase}</span>
      <span class="ok-muted">庄家 ${nameOf(data.players[data.dealer]?.id ?? '')}</span>
      ${me ? '' : '<span class="ok-badge">观战 / 回放</span>'}
    </div>
    <div class="ok-seats">${data.players.map((player) => renderSeat(player, player.id === me)).join('')}</div>
    ${renderSummary(data, view)}
    <div class="ok-center">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${renderCenter(data)}
        ${renderTable(data)}
        ${renderActions(data)}
      </div>
      <div class="ok-box">
        <div class="ok-box-title">你的手牌${mePlayer ? `（${mePlayer.handCount} 张）` : ''}</div>
        <div class="ok-hand">${
          sortedHand
            .map((id) => tileButton(id, data.okey, `data-act="hand" data-tile="${id}"`, { selected: selectedHand === id }))
            .join('') || '<span class="ok-muted">对手手牌不可见</span>'
        }</div>
        <div class="ok-goal">Okey：${COLOR_NAME[data.okey.color]}${data.okey.number}。点手牌选中，再弃掉。</div>
      </div>
    </div>
    ${renderBuilder(data)}
  </div>`;
}

function startBuilder(data: OkeyData, mode: 'open' | 'rearrange'): void {
  builderMode = mode;
  builderSelected = 0;
  const me = meId() ?? '';
  const mePlayer = playerOf(me);
  const hand = mePlayer?.hand ?? [];
  if (mode === 'open') {
    builderGroups = [];
    builderPool = [...hand];
  } else {
    builderGroups = data.melds.map((meld) => [...meld.tiles]);
    builderPool = [...hand];
  }
  selectedHand = null;
}

function submitBuilder(data: OkeyData): void {
  if (!builderMode || !context) return;
  const groups = builderGroups.filter((group) => group.length > 0);
  context.send({
    type: builderMode === 'open' ? 'open' : 'rearrange',
    payload: { melds: groups },
  });
  builderMode = null;
  builderGroups = [];
  builderPool = [];
}

function onClick(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!target || !context) return;
  const act = target.dataset.act;
  const data = dataOf();
  if (!act || !data) return;

  if (act === 'hand') {
    const tile = target.dataset.tile;
    if (tile) selectedHand = selectedHand === tile ? null : tile;
  } else if (act === 'draw') {
    context.send({ type: 'draw', payload: {} });
  } else if (act === 'take-discard') {
    context.send({ type: 'takeDiscard', payload: {} });
  } else if (act === 'return-discard') {
    context.send({ type: 'returnDiscard', payload: {} });
  } else if (act === 'discard') {
    if (selectedHand) {
      context.send({ type: 'discard', payload: { tile: selectedHand } });
      selectedHand = null;
    }
  } else if (act === 'open-builder') {
    startBuilder(data, 'open');
  } else if (act === 'rearrange-builder') {
    startBuilder(data, 'rearrange');
  } else if (act === 'new-group') {
    builderGroups.push([]);
    builderSelected = builderGroups.length - 1;
  } else if (act === 'delete-group') {
    if (builderGroups.length > 0) {
      const [removed] = builderGroups.splice(builderSelected, 1);
      builderPool.push(...(removed ?? []));
      builderSelected = Math.max(0, Math.min(builderSelected, builderGroups.length - 1));
    }
  } else if (act === 'select-group') {
    builderSelected = Number(target.dataset.group ?? 0);
  } else if (act === 'pool-tile') {
    const tile = target.dataset.tile;
    if (!tile) return;
    if (builderGroups.length === 0) {
      builderGroups.push([]);
      builderSelected = 0;
    }
    builderPool = builderPool.filter((id) => id !== tile);
    builderGroups[builderSelected]!.push(tile);
  } else if (act === 'group-tile') {
    const tile = target.dataset.tile;
    const group = Number(target.dataset.group ?? 0);
    if (!tile || !builderGroups[group]) return;
    builderGroups[group] = builderGroups[group]!.filter((id) => id !== tile);
    builderPool.push(tile);
  } else if (act === 'submit-builder') {
    submitBuilder(data);
  } else if (act === 'cancel-builder') {
    builderMode = null;
    builderGroups = [];
    builderPool = [];
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
    selectedHand = null;
    builderMode = null;
    builderGroups = [];
    builderPool = [];
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
  selectedHand = null;
  builderMode = null;
  builderGroups = [];
  builderPool = [];
  lastPhase = '';
  lastTurn = '';
}

function formatLog(entry: LogEntry): string | null {
  const args = entry.args ?? {};
  const who = nameOf(String(args.player ?? args.winner ?? ''));
  switch (entry.key) {
    case 'okey.draw':
      return `${who} 摸了一张牌`;
    case 'okey.takeDiscard':
      return `${who} 吃了上家的弃牌`;
    case 'okey.returnDiscard':
      return `${who} 把弃牌放回，改为摸牌`;
    case 'okey.open':
      return `${who} 开牌${args.route === 'pairs' ? '（5 对）' : `（${args.value} 分）`}`;
    case 'okey.rearrange':
      return `${who} 整理了场上牌型`;
    case 'okey.discard':
      return `${who} 弃了一张牌`;
    case 'okey.win':
      return `${who} 胡牌！`;
    case 'okey.roundEnd': {
      const scores = (args.scores as Record<string, number> | undefined) ?? {};
      return `第 ${args.round} 轮结束（${args.winner ? nameOf(String(args.winner)) + ' 胡牌' : '牌堆摸完'}）：${Object.entries(
        scores,
      )
        .map(([id, score]) => `${nameOf(id)} ${score > 0 ? '+' : ''}${score}`)
        .join(' / ')}`;
    }
    case 'okey.gameEnd': {
      const winners = (args.winners as string[] | undefined) ?? [];
      return `${winners.map((id) => nameOf(id)).join('、')} 赢得整局`;
    }
    default:
      return null;
  }
}

const client: GameClient = { mount, update, unmount, formatLog };
export default client;
export { client };
