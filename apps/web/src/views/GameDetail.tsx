import { useEffect, useState, type ReactElement } from 'react';
import type { GameManifest, LeaderboardEntry } from '@platform/sdk';
import { api } from '../api';

const MODE_LABEL: Record<string, string> = {
  turnbased: '回合制',
  realtime: '即时制',
};

const TURN_PACE_LABEL: Record<string, string> = {
  '24': '每天 24 回合（每小时一动）',
  '12': '每天 12 回合',
  '8': '每天 8 回合',
  '4': '每天 4 回合',
  '2': '每天 2 回合',
  '1': '每天 1 回合',
  '2d': '2 天一动',
  none: '无限（友谊赛，不计分）',
};

/** 本地小时 → UTC 当天第几分钟（存库用 0 时区，显示再转回本地） */
function localHourToUtcMinutes(hour: number): number {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** 把插件自报的即时制秒数变成「快 / 中 / 慢」的说明 */
function realtimeLabel(manifest: GameManifest, pace: string): string {
  const speeds = manifest.realtime ?? { fast: 20, normal: 45, slow: 90 };
  const seconds = pace === 'fast' ? speeds.fast : pace === 'slow' ? speeds.slow : speeds.normal;
  return seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
}

/** 行内只认 `**粗体**`，够用了 */
function inline(text: string): React.ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    index % 2 === 1 ? <strong key={index}>{part}</strong> : <span key={index}>{part}</span>,
  );
}

/** 介绍文本的极简排版：空行分段，`## ` 是小标题，`- ` 是条目 */
function renderIntro(text: string): ReactElement[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const lines = block.split('\n').map((line) => line.trim());
      if (block.startsWith('## ')) {
        return (
          <h3 key={index} className="intro-title">
            {block.slice(3)}
          </h3>
        );
      }
      if (lines.every((line) => line.startsWith('- '))) {
        return (
          <ul key={index} className="intro-list">
            {lines.map((line, itemIndex) => (
              <li key={itemIndex}>{inline(line.slice(2))}</li>
            ))}
          </ul>
        );
      }
      return <p key={index}>{inline(lines.join('\n'))}</p>;
    });
}

/** 开一局的弹层：先选即时/回合，再出各自的设置 */
function StartPanel({
  game,
  onClose,
  onOpen,
}: {
  game: GameManifest;
  onClose: () => void;
  onOpen: (tableId: string) => void;
}) {
  const [mode, setMode] = useState<'realtime' | 'turnbased'>(
    game.modes.includes('realtime') ? 'realtime' : 'turnbased',
  );
  const [realtimePace, setRealtimePace] = useState('normal');
  const [turnPace, setTurnPace] = useState('24');
  const [withWindow, setWithWindow] = useState(false);
  const [startHour, setStartHour] = useState(19);
  const [endHour, setEndHour] = useState(23);
  const [seats, setSeats] = useState(game.players.max);
  const [busy, setBusy] = useState<'create' | 'quick' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pace = mode === 'realtime' ? realtimePace : turnPace;
  const windowStart = mode === 'turnbased' && withWindow ? localHourToUtcMinutes(startHour) : null;
  const windowEnd = mode === 'turnbased' && withWindow ? localHourToUtcMinutes(endHour) : null;

  const settings = { mode, pace, windowStart, windowEnd };

  const create = async (): Promise<void> => {
    setBusy('create');
    setError(null);
    try {
      const { id } = await api.createTable({ gameId: game.id, maxPlayers: seats, ...settings });
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const quick = async (): Promise<void> => {
    setBusy('quick');
    setError(null);
    try {
      const { id } = await api.quickMatch(game.id, settings);
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog start-dialog" onClick={(event) => event.stopPropagation()}>
        <h2>开一局 {game.name}</h2>

        {error ? <div className="error">{error}</div> : null}

        <div className="mode-tabs">
          {game.modes.includes('realtime') ? (
            <button
              className={mode === 'realtime' ? 'active' : ''}
              onClick={() => setMode('realtime')}
            >
              即时制
              <span className="muted small">现在就开始，人得一直在</span>
            </button>
          ) : null}
          {game.modes.includes('turnbased') ? (
            <button
              className={mode === 'turnbased' ? 'active' : ''}
              onClick={() => setMode('turnbased')}
            >
              回合制
              <span className="muted small">每天来回几下，可以同时开很多桌</span>
            </button>
          ) : null}
        </div>

        {mode === 'realtime' ? (
          <>
            <h3>每步限时</h3>
            <div className="chip-row">
              {(['fast', 'normal', 'slow', 'none'] as const).map((option) => (
                <button
                  key={option}
                  className={`chip ${realtimePace === option ? 'active' : ''}`}
                  onClick={() => setRealtimePace(option)}
                >
                  {option === 'none'
                    ? '无限（友谊赛）'
                    : { fast: '快', normal: '中', slow: '慢' }[option] + ' · ' + realtimeLabel(game, option)}
                </button>
              ))}
            </div>
            <p className="muted small">
              超时会自动替你走一手，连续 3 次超时判负。即时房间里不能回大厅，退出就是认负。
            </p>
          </>
        ) : (
          <>
            <h3>节奏</h3>
            <div className="chip-row">
              {Object.keys(TURN_PACE_LABEL).map((option) => (
                <button
                  key={option}
                  className={`chip ${turnPace === option ? 'active' : ''}`}
                  onClick={() => setTurnPace(option)}
                >
                  {TURN_PACE_LABEL[option]}
                </button>
              ))}
            </div>

            <label className="bot-toggle">
              <input
                type="checkbox"
                checked={withWindow}
                onChange={(event) => setWithWindow(event.target.checked)}
              />
              只在固定时段行动（其它时间不计时）
            </label>
            {withWindow ? (
              <div className="window-row">
                <select value={startHour} onChange={(event) => setStartHour(Number(event.target.value))}>
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
                <span className="muted">到</span>
                <select value={endHour} onChange={(event) => setEndHour(Number(event.target.value))}>
                  {Array.from({ length: 24 }, (_, hour) => hour + 1).map((hour) => (
                    <option key={hour} value={hour}>
                      {String(hour % 24).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
                <span className="muted small">按你本地时间</span>
              </div>
            ) : null}
            <p className="muted small">回合制可以随时回大厅，桌会等你；超时同样自动走一手，3 次判负。</p>
          </>
        )}

        {game.players.max > game.players.min ? (
          <label className="field">
            <span>座位</span>
            <select value={seats} onChange={(event) => setSeats(Number(event.target.value))}>
              {Array.from({ length: game.players.max - game.players.min + 1 }, (_, index) => {
                const count = game.players.min + index;
                return (
                  <option key={count} value={count}>
                    {count} 人
                  </option>
                );
              })}
            </select>
          </label>
        ) : (
          <p className="muted small">固定 {game.players.min} 人</p>
        )}

        <div className="dialog-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="ghost" disabled={busy !== null} onClick={() => void quick()}>
            {busy === 'quick' ? '匹配中…' : '随便进一桌'}
          </button>
          <button className="primary" disabled={busy !== null} onClick={() => void create()}>
            {busy === 'create' ? '开桌中…' : '开桌'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GameDetail({
  gameId,
  onBack,
  onOpen,
}: {
  gameId: string;
  onBack: () => void;
  onOpen: (tableId: string) => void;
}) {
  const [games, setGames] = useState<GameManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'intro' | 'board'>('intro');
  const [starting, setStarting] = useState(false);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .games()
      .then((data) => {
        if (!cancelled) setGames(data.games);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const game = games?.find((item) => item.id === gameId) ?? null;

  useEffect(() => {
    if (!game) return;
    let cancelled = false;
    api
      .leaderboard(game.id)
      .then((data) => {
        if (!cancelled) setBoard(data.entries);
      })
      .catch(() => {
        if (!cancelled) setBoard([]);
      });
    return () => {
      cancelled = true;
    };
  }, [game]);

  return (
    <div className="lobby game-detail">
      <header className="topbar">
        <button className="ghost" onClick={onBack}>
          ← 大厅
        </button>
        <div className="title">{game?.name ?? '游戏详情'}</div>
        <div className="spacer" />
        {game ? <span className="muted small">v{game.version}</span> : null}
        {game ? (
          <button className="primary" onClick={() => setStarting(true)}>
            开始
          </button>
        ) : null}
      </header>

      {error ? <div className="error">{error}</div> : null}

      {!game ? (
        <p className="muted">{games ? '这个游戏不存在，或者已被管理员禁用。' : '加载中…'}</p>
      ) : (
        <>
          <div className="detail-meta">
            {game.description ? <p className="detail-lead">{game.description}</p> : null}
            <div className="meta-row">
              <span>
                {game.players.min}–{game.players.max} 人
              </span>
              <span>约 {game.estimatedMinutes} 分钟</span>
              <span>{game.modes.map((mode) => MODE_LABEL[mode] ?? mode).join(' / ')}</span>
              <div className="tags">
                {game.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="admin-tabs detail-tabs">
            <button className={tab === 'intro' ? 'active' : ''} onClick={() => setTab('intro')}>
              介绍
            </button>
            <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>
              排行榜
            </button>
          </div>

          {tab === 'intro' ? (
            <section>
              {game.intro ? (
                <div className="intro">{renderIntro(game.intro)}</div>
              ) : (
                <p className="muted">这个游戏还没写介绍。</p>
              )}
            </section>
          ) : (
            <section>
              {board.length === 0 ? (
                <p className="muted">这个游戏还没有排名。</p>
              ) : (
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>玩家</th>
                      <th>Elo</th>
                      <th>局数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.map((entry, index) => (
                      <tr key={entry.userId}>
                        <td>{index + 1}</td>
                        <td>{entry.name}</td>
                        <td>{Math.round(entry.rating)}</td>
                        <td>{entry.games}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}

      {starting && game ? (
        <StartPanel game={game} onClose={() => setStarting(false)} onOpen={onOpen} />
      ) : null}
    </div>
  );
}
