import { useEffect, useRef, useState } from 'react';
import { api, type Session } from '../api';
import { GameSurface } from '../host/GameSurface';
import { useGameClient } from '../host/useGameClient';
import { renderLog } from '../log';
import { useTableSocket } from '../useTableSocket';

const STATUS_LABEL = {
  lobby: '等待中',
  playing: '进行中',
  finished: '已结束',
} as const;

export function TableView({
  tableId,
  session,
  onExit,
}: {
  tableId: string;
  session: Session;
  onExit: () => void;
}) {
  const { snapshot, error, sendAction } = useTableSocket(tableId, session.token);
  const { client, error: clientError } = useGameClient(
    snapshot?.gameId ?? '',
    snapshot?.gameVersion ?? '',
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const logLength = snapshot?.log.length ?? 0;
  useEffect(() => {
    const list = logRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [logLength]);

  const join = async (): Promise<void> => {
    setActionError(null);
    try {
      await api.joinTable(tableId);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const start = async (): Promise<void> => {
    setActionError(null);
    try {
      await api.startTable(tableId);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const copyInvite = async (): Promise<void> => {
    const link = `${location.origin}${location.pathname}#/table/${tableId}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setActionError(link);
    }
  };

  if (!snapshot) {
    return <div className="center">{error ?? '连接中…'}</div>;
  }

  const remainingMs = snapshot.deadlineAt === null ? null : Math.max(0, snapshot.deadlineAt - now);
  const canStart = snapshot.you.isHost && snapshot.players.length >= snapshot.minPlayers;
  const canJoin = !snapshot.you.isPlayer && snapshot.status === 'lobby';
  const message = actionError ?? error ?? clientError;

  return (
    <div className="table-page">
      <header className="topbar">
        <button className="ghost" onClick={onExit}>
          ← 大厅
        </button>
        <div className="title">
          {snapshot.gameName}
          <span className="muted version">v{snapshot.gameVersion}</span>
        </div>
        <div className={`badge ${snapshot.status}`}>{STATUS_LABEL[snapshot.status]}</div>
        {remainingMs !== null ? (
          <div className={`timer ${remainingMs < 5000 ? 'urgent' : ''}`}>
            ⏱ {Math.ceil(remainingMs / 1000)}s
          </div>
        ) : null}
      </header>

      {message ? <div className="error">{message}</div> : null}

      <div className="table-body">
        <section className="board">
          <div className="seats">
            {snapshot.players.map((player) => {
              const classes = ['seat'];
              if (snapshot.activePlayer === player.id) classes.push('active');
              if (player.id === session.user.id) classes.push('me');
              return (
                <div key={player.id} className={classes.join(' ')}>
                  <span className="seat-name">{player.name}</span>
                  {player.id === snapshot.hostId ? <span className="tag">房主</span> : null}
                  {snapshot.activePlayer === player.id ? <span className="dot" /> : null}
                </div>
              );
            })}
            {Array.from({ length: Math.max(0, snapshot.maxPlayers - snapshot.players.length) }).map(
              (_, index) => (
                <div key={`empty-${index}`} className="seat empty">
                  空位
                </div>
              ),
            )}
          </div>

          {snapshot.status === 'lobby' ? (
            <div className="lobby-panel">
              <div className="muted">
                已就位 {snapshot.players.length} / {snapshot.maxPlayers} 人，至少{' '}
                {snapshot.minPlayers} 人开局
              </div>
              <div className="row">
                {canJoin ? (
                  <button className="primary" onClick={() => void join()}>
                    坐下
                  </button>
                ) : null}
                {snapshot.you.isHost ? (
                  <button className="primary" disabled={!canStart} onClick={() => void start()}>
                    开始游戏
                  </button>
                ) : null}
                <button className="ghost" onClick={() => void copyInvite()}>
                  {copied ? '已复制' : '复制邀请链接'}
                </button>
              </div>
              <div className="muted small">链接发给朋友，他们在同一个地址打开就能加入。</div>
            </div>
          ) : (
            <GameSurface
              client={client}
              snapshot={{
                status: snapshot.status,
                view: snapshot.view,
                legal: snapshot.legal,
                deadlineAt: snapshot.deadlineAt,
              }}
              me={session.user.id}
              players={snapshot.players}
              onAction={sendAction}
            />
          )}
        </section>

        <aside className="sidebar">
          <h3>对局日志</h3>
          <ul className="log-list" ref={logRef}>
            {snapshot.log.map((entry) => (
              <li key={entry.seq}>
                <span className="log-seq">{entry.seq}</span>
                {renderLog(entry, client)}
              </li>
            ))}
            {snapshot.log.length === 0 ? <li className="muted">还没有记录</li> : null}
          </ul>
        </aside>
      </div>
    </div>
  );
}
