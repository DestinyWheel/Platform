import { useCallback, useEffect, useState } from 'react';
import type {
  GameManifest,
  LeaderboardEntry,
  PlayerStatsRow,
  RecentMatchRow,
  TableSummary,
} from '@platform/sdk';
import { api, type Session } from '../api';
import { ChangePassword } from './ChangePassword';

const STATUS_LABEL: Record<string, string> = {
  lobby: '等待中',
  playing: '进行中',
  finished: '已结束',
};

export function Lobby({
  session,
  onOpen,
  onReplay,
  onLogout,
  onSession,
}: {
  session: Session;
  onOpen: (tableId: string) => void;
  onReplay: (tableId: string) => void;
  onLogout: () => void;
  onSession: (session: Session) => void;
}) {
  const [games, setGames] = useState<GameManifest[]>([]);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  const [perGame, setPerGame] = useState<PlayerStatsRow[]>([]);
  const [recent, setRecent] = useState<RecentMatchRow[]>([]);
  const [boardGame, setBoardGame] = useState('');
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [withBot, setWithBot] = useState(false);
  const [untimed, setUntimed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [gameList, tableList] = await Promise.all([api.games(), api.tables()]);
      setGames(gameList.games);
      setTables(tableList.tables);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    api
      .stats()
      .then((data) => {
        setPerGame(data.perGame);
        setRecent(data.recent);
      })
      .catch(() => undefined);
  }, []);

  const effectiveGame = boardGame || games[0]?.id || '';
  useEffect(() => {
    if (!effectiveGame) return;
    api
      .leaderboard(effectiveGame)
      .then((data) => setBoard(data.entries))
      .catch(() => setBoard([]));
  }, [effectiveGame]);

  const winRate = (row: PlayerStatsRow): string =>
    row.games === 0 ? '—' : `${Math.round((row.wins / row.games) * 100)}%`;

  const createTable = async (game: GameManifest): Promise<void> => {
    setBusy(game.id);
    setError(null);
    try {
      const { id } = await api.createTable({
        gameId: game.id,
        maxPlayers: game.players.max,
        ...(withBot || untimed
          ? {
              options: {
                ...(withBot ? { bots: 1 } : {}),
                ...(untimed ? { untimed: true, turnMs: 0 } : {}),
              },
            }
          : {}),
      });
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const joinTable = async (id: string): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await api.joinTable(id);
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lobby">
      <header className="topbar">
        <div className="title">桌游平台</div>
        <div className="spacer" />
        <span className="muted">{session.user.name}{session.user.isAdmin ? ' · 管理员' : ''}</span>
        <button className="ghost" onClick={() => setChangingPassword(true)}>
          改密码
        </button>
        <button className="ghost" onClick={onLogout}>
          退出
        </button>
      </header>

      {changingPassword ? (
        <ChangePassword
          onClose={() => setChangingPassword(false)}
          onChanged={(next) => {
            onSession(next);
            setChangingPassword(false);
          }}
        />
      ) : null}

      {error ? <div className="error">{error}</div> : null}

      <section>
        <h2>开始一局</h2>
        <label className="bot-toggle">
          <input
            type="checkbox"
            checked={withBot}
            onChange={(event) => setWithBot(event.target.checked)}
          />
          开局缺人时补一个机器人（单人也能玩）
        </label>
        <label className="bot-toggle">
          <input
            type="checkbox"
            checked={untimed}
            onChange={(event) => setUntimed(event.target.checked)}
          />
          不限时（不自动换手，只有主动「结束回合」才换人）
        </label>
        <div className="game-grid">
          {games.map((game) => (
            <article key={game.id} className="game-card">
              <div className="game-name">{game.name}</div>
              <div className="muted">
                {game.players.min}–{game.players.max} 人 · 约 {game.estimatedMinutes} 分钟
              </div>
              <div className="tags">
                {game.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
              <button
                className="primary"
                disabled={busy === game.id}
                onClick={() => void createTable(game)}
              >
                开桌
              </button>
            </article>
          ))}
          {games.length === 0 ? <div className="muted">还没有注册任何游戏</div> : null}
        </div>
      </section>

      <section>
        <h2>进行中的牌桌</h2>
        {tables.length === 0 ? (
          <div className="muted">暂无牌桌，开一张吧。</div>
        ) : (
          <ul className="table-list">
            {tables.map((table) => (
              <li key={table.id} className="table-row">
                <div>
                  <div className="game-name">{table.gameName}</div>
                  <div className="muted">
                    房主 {table.hostName} · {table.players}/{table.maxPlayers} 人
                  </div>
                </div>
                <div className={`badge ${table.status}`}>{STATUS_LABEL[table.status]}</div>
                <button
                  className={table.status === 'lobby' ? 'primary' : 'ghost'}
                  disabled={busy === table.id}
                  onClick={() => void joinTable(table.id)}
                >
                  {table.status === 'lobby' ? '加入' : '观战'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="lobby-columns">
        <section>
          <h2>我的战绩</h2>
          {perGame.length === 0 ? (
            <div className="muted">还没打完一局。</div>
          ) : (
            <table className="stats-table">
              <thead>
                <tr>
                  <th>游戏</th>
                  <th>场次</th>
                  <th>胜</th>
                  <th>胜率</th>
                </tr>
              </thead>
              <tbody>
                {perGame.map((row) => (
                  <tr key={row.gameId}>
                    <td>{row.gameName}</td>
                    <td>{row.games}</td>
                    <td>{row.wins}</td>
                    <td>{winRate(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {recent.length > 0 ? (
            <ul className="recent-list">
              {recent.slice(0, 8).map((match) => (
                <li key={match.tableId}>
                  <span className={match.isWin ? 'win' : 'lose'}>
                    {match.isWin ? '胜' : `第 ${match.rank} 名`}
                  </span>
                  <span className="muted small">
                    {match.gameName} · {match.players} 人
                  </span>
                  <button className="ghost small" onClick={() => onReplay(match.tableId)}>
                    回放
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section>
          <h2>排行榜（Elo）</h2>
          {games.length > 1 ? (
            <select
              className="ghost"
              value={effectiveGame}
              onChange={(event) => setBoardGame(event.target.value)}
            >
              {games.map((game) => (
                <option key={game.id} value={game.id}>
                  {game.name}
                </option>
              ))}
            </select>
          ) : null}
          {board.length === 0 ? (
            <div className="muted">这个游戏还没有排名。</div>
          ) : (
            <table className="stats-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>玩家</th>
                  <th>分数</th>
                  <th>场次</th>
                </tr>
              </thead>
              <tbody>
                {board.map((entry, index) => (
                  <tr
                    key={entry.userId}
                    className={entry.userId === session.user.id ? 'me' : ''}
                  >
                    <td>{index + 1}</td>
                    <td>{entry.name}</td>
                    <td>{entry.rating}</td>
                    <td>{entry.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
