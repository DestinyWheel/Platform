/**
 * 示例插件：骰子对决（前端）
 *
 * 刻意用原生 DOM 写，证明宿主契约是框架无关的：
 * 只实现 mount / update / unmount，不依赖 React，也不需要任何 import map。
 */
import type {
  ClientSnapshot,
  GameClient,
  GameClientContext,
  LogEntry,
  PlayerId,
  PublicView,
} from '@platform/sdk';

const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const STYLE_ID = 'dice-client-style';

interface DiceData {
  scores: Record<PlayerId, number>;
  roundRolls: Record<PlayerId, number | null>;
  rounds: number;
}

const CSS = `
.dz { display:flex; flex-direction:column; align-items:center; gap:22px; padding:20px 0; }
.dz-round { color:#8b98a7; font-size:13px; letter-spacing:.08em; text-transform:uppercase; }
.dz-players { display:flex; gap:16px; flex-wrap:wrap; justify-content:center; }
.dz-player { min-width:110px; padding:16px; border-radius:12px; background:#1c232c; border:1px solid #262d38; display:flex; flex-direction:column; align-items:center; gap:6px; }
.dz-player.active { border-color:#4c8dff; box-shadow:0 0 22px rgba(76,141,255,.18); }
.dz-player.me .dz-name { color:#4c8dff; }
.dz-name { font-weight:600; font-size:14px; color:#e6edf3; }
.dz-face { font-size:44px; line-height:1; color:#8b98a7; }
.dz-face.rolled { color:#e6edf3; animation:dz-tumble .35s ease-out; }
@keyframes dz-tumble { from { transform:rotate(-90deg) scale(.6); opacity:0 } to { transform:none; opacity:1 } }
.dz-score { font-variant-numeric:tabular-nums; font-size:20px; font-weight:700; color:#e6edf3; }
.dz-result { font-size:20px; font-weight:700; color:#e3b341; }
.dz button { font:inherit; border-radius:9px; border:0; padding:12px 32px; font-size:16px; cursor:pointer; background:linear-gradient(180deg,#4c8dff,#3a72d8); color:#fff; font-weight:600; }
.dz button:disabled { opacity:.45; cursor:not-allowed; }
`;

interface Parts {
  root: HTMLElement;
  round: HTMLElement;
  players: HTMLElement;
  footer: HTMLElement;
}

let context: GameClientContext | null = null;
let parts: Parts | null = null;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function playerName(id: PlayerId): string {
  return context?.players.find((player) => player.id === id)?.name ?? id.slice(0, 6);
}

function buildPlayerCard(view: PublicView, data: DiceData, player: PlayerId): HTMLElement {
  const card = document.createElement('div');
  card.className = 'dz-player';
  if (view.turn === player) card.classList.add('active');
  if (player === context?.me) card.classList.add('me');

  const name = document.createElement('div');
  name.className = 'dz-name';
  name.textContent = playerName(player);

  const roll = data.roundRolls[player] ?? null;
  const face = document.createElement('div');
  face.className = roll ? 'dz-face rolled' : 'dz-face';
  face.textContent = roll ? (FACES[roll - 1] ?? '·') : '·';

  const score = document.createElement('div');
  score.className = 'dz-score';
  score.textContent = String(data.scores[player] ?? 0);

  card.append(name, face, score);
  return card;
}

function buildFooter(snapshot: ClientSnapshot, view: PublicView): HTMLElement {
  if (view.finished) {
    const result = document.createElement('div');
    result.className = 'dz-result';
    const champions = (view.ranking?.[0] ?? []).map(playerName).join('、');
    result.textContent = `🏆 ${champions}`;
    return result;
  }

  const button = document.createElement('button');
  const canRoll = snapshot.legal.includes('roll');
  button.disabled = !canRoll;
  button.textContent = canRoll ? '掷骰子' : '等待对手…';
  button.addEventListener('click', () => context?.send({ type: 'roll', payload: {} }));
  return button;
}

function render(snapshot: ClientSnapshot): void {
  if (!parts || !context) return;

  const view = snapshot.view;
  if (!view) {
    parts.round.textContent = '';
    parts.players.replaceChildren();
    parts.footer.replaceChildren();
    return;
  }

  const data = view.data as unknown as DiceData;
  parts.round.textContent = `第 ${view.round} / ${data.rounds} 轮`;
  parts.players.replaceChildren(
    ...view.players.map((player) => buildPlayerCard(view, data, player)),
  );
  parts.footer.replaceChildren(buildFooter(snapshot, view));
}

function mount(ctx: GameClientContext): void {
  ensureStyle();
  context = ctx;

  const root = document.createElement('div');
  root.className = 'dz';

  const round = document.createElement('div');
  round.className = 'dz-round';

  const players = document.createElement('div');
  players.className = 'dz-players';

  const footer = document.createElement('div');

  root.append(round, players, footer);
  ctx.root.replaceChildren(root);

  parts = { root, round, players, footer };
}

function update(snapshot: ClientSnapshot): void {
  render(snapshot);
}

function unmount(): void {
  parts?.root.remove();
  parts = null;
  context = null;
}

/** 日志文案由插件自己负责，宿主不需要认识 dice.* 这些 key */
function formatLog(entry: LogEntry): string | null {
  const args = entry.args ?? {};

  switch (entry.key) {
    case 'dice.roll':
      return `${playerName(String(args.player))} 掷出了 ${String(args.value)} 点`;

    case 'dice.roundEnd': {
      const rolls = (args.rolls ?? {}) as Record<string, number | null>;
      const parts2 = Object.entries(rolls)
        .map(([player, value]) => `${playerName(player)}:${value ?? '-'}`)
        .join('  ');
      return `第 ${String(args.round)} 轮结束 — ${parts2}`;
    }

    case 'dice.gameEnd': {
      const ranking = (args.ranking ?? []) as string[][];
      return `对局结束，冠军：${(ranking[0] ?? []).map(playerName).join('、')}`;
    }

    default:
      return null;
  }
}

const client: GameClient = { mount, update, unmount, formatLog };

export default client;
export { client };
