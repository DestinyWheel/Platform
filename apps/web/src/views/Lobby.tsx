import { useCallback, useEffect, useState } from 'react';
import type { GameManifest, TableSummary } from '@platform/sdk';
import { api, type Session } from '../api';

const STATUS_LABEL: Record<string, string> = {
  lobby: '等待中',
  playing: '进行中',
  finished: '已结束',
};

export function Lobby({
  session,
  onOpen,
  onLogout,
}: {
  session: Session;
  onOpen: (tableId: string) => void;
  onLogout: () => void;
}) {
  const [games, setGames] = useState<GameManifest[]>([]);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const createTable = async (game: GameManifest): Promise<void> => {
    setBusy(game.id);
    setError(null);
    try {
      const { id } = await api.createTable({ gameId: game.id, maxPlayers: game.players.max });
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
        <span className="muted">{session.user.name}</span>
        <button className="ghost" onClick={onLogout}>
          退出
        </button>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section>
        <h2>开始一局</h2>
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
    </div>
  );
}
