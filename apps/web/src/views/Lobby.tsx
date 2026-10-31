import { useCallback, useEffect, useState } from 'react';
import type {
  GameManifest,
  LeaderboardEntry,
  PlayerStatsRow,
  RecentMatchRow,
  TableSummary,
} from '@platform/sdk';
import { api, type Session } from '../api';

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
  onAdmin,
  onUser,
  onGame,
  onDocs,
}: {
  session: Session;
  onOpen: (tableId: string) => void;
  onReplay: (tableId: string) => void;
  onLogout: () => void;
  onAdmin: () => void;
  onUser: () => void;
  onGame: (gameId: string) => void;
  onDocs: () => void;
}) {
  const [games, setGames] = useState<GameManifest[]>([]);
  const [mine, setMine] = useState<TableSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [perGame, setPerGame] = useState<PlayerStatsRow[]>([]);
  const [recent, setRecent] = useState<RecentMatchRow[]>([]);
  const [boardGame, setBoardGame] = useState('');
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [roomCode, setRoomCode] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [gameList, mineList] = await Promise.all([api.games(), api.myTables()]);
      setGames(gameList.games);
      setMine(mineList.tables);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
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

  const quickMatch = async (): Promise<void> => {
    setBusy('quick');
    setError(null);
    try {
      const result = await api.quickMatch();
      onOpen(result.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const joinByCode = async (): Promise<void> => {
    const trimmed = roomCode.trim();
    if (!trimmed) return;
    setBusy('code');
    setError(null);
    try {
      const { id } = await api.joinByCode(trimmed);
      setRoomCode('');
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
        <span className="muted">
          {session.user.name}
          {session.user.isAdmin ? ' · 管理员' : ''}
        </span>
        <button className="ghost" onClick={onUser}>
          个人中心
        </button>
        {session.user.isAdmin ? (
          <button className="ghost" onClick={onAdmin}>
            管理
          </button>
        ) : null}
        <button className="ghost" onClick={onLogout}>
          退出
        </button>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="quick-start">
        <button
          className="primary big"
          disabled={busy === 'quick' || games.length === 0}
          onClick={() => void quickMatch()}
        >
          {busy === 'quick' ? '匹配中…' : '随便来一局'}
        </button>
        <div className="code-join">
          <input
            value={roomCode}
            onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void joinByCode();
            }}
            placeholder="房间号"
            maxLength={6}
            className="code-input"
            aria-label="房间号"
          />
          <button
            className="ghost"
            disabled={busy === 'code' || roomCode.trim().length < 4}
            onClick={() => void joinByCode()}
          >
            加入
          </button>
        </div>
      </section>
      <p className="muted small quick-hint">
        「随便来一局」会把你塞进一张正在等人的桌；没有这样的桌，就直接给你开一张。
      </p>

      {mine.length > 0 ? (
        <section>
          <h2>我的对局</h2>
          <ul className="table-list">
            {mine.map((table) => (
              <li key={table.id} className="table-row">
                <div>
                  <div className="game-name">
                    {table.gameName}
                    {table.code ? <span className="room-code">{table.code}</span> : null}
                  </div>
                  <div className="muted small">
                    {table.mode === 'realtime' ? '即时' : '回合制'}
                    {table.friendly ? ' · 友谊赛' : ''} · {table.mine === 'host' ? '我是房主' : '我是玩家'} ·{' '}
                    {table.players}/{table.maxPlayers} 人 · 房主 {table.hostName}
                  </div>
                </div>
                {table.myTurn ? <div className="badge playing">轮到你</div> : null}
                <div className={`badge ${table.status}`}>{STATUS_LABEL[table.status]}</div>
                <button className="primary" onClick={() => onOpen(table.id)}>
                  {table.myTurn ? '该你走了' : '回到牌桌'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>游戏</h2>
        <div className="game-grid">
          {games.map((game) => {
            const { min, max } = game.players;
            return (
              <button
                key={game.id}
                type="button"
                className="game-card"
                onClick={() => onGame(game.id)}
              >
                <div className="game-name">{game.name}</div>
                <div className="muted">
                  {min}–{max} 人 · 约 {game.estimatedMinutes} 分钟
                </div>
                {game.description ? (
                  <p className="game-blurb">{game.description}</p>
                ) : null}
                <div className="tags">
                  {game.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
                <span className="game-more">查看详情 →</span>
              </button>
            );
          })}
          {games.length === 0 ? <div className="muted">还没有注册任何游戏</div> : null}
        </div>
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

      <footer className="footer">
        <span>桌游平台 · 游戏以插件形式加载，加游戏不用重启</span>
        <button className="link" onClick={onDocs}>
          插件开发文档
        </button>
      </footer>
    </div>
  );
}
