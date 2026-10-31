import { useEffect, useRef, useState } from 'react';
import { api, type Session } from '../api';
import { copyText } from '../clipboard';
import { GameSurface } from '../host/GameSurface';
import { useGameClient } from '../host/useGameClient';
import { renderLog } from '../log';
import { useTableSocket } from '../useTableSocket';

const STATUS_LABEL = {
  lobby: '等待中',
  playing: '进行中',
  finished: '已结束',
} as const;

/** 一个最小的确认弹窗：只在"会造成不可逆后果"的操作前出现 */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        <p className="muted small">{body}</p>
        <div className="dialog-actions">
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TableView({
  tableId,
  session,
  onExit,
  onOpen,
  onReplay,
}: {
  tableId: string;
  session: Session;
  onExit: () => void;
  onOpen: (tableId: string) => void;
  onReplay: (tableId: string) => void;
}) {
  const { snapshot, error, sendAction, sendChat } = useTableSocket(tableId, session.token);
  const { client, error: clientError } = useGameClient(
    snapshot?.gameId ?? '',
    snapshot?.gameVersion ?? '',
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState<'leave' | 'forfeit' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 已经点过"我知道了"的版本；服务端也会记，这里只是让弹窗立刻消失 */
  const [ackedVersion, setAckedVersion] = useState<string | null>(null);

  const logRef = useRef<HTMLUListElement | null>(null);
  const chatRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const logLength = snapshot?.log.length ?? 0;
  useEffect(() => {
    const list = logRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [logLength]);

  const chatLength = snapshot?.chat.length ?? 0;
  useEffect(() => {
    const list = chatRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chatLength]);

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

  const leave = async (): Promise<void> => {
    setBusy('leave');
    setActionError(null);
    try {
      await api.leaveTable(tableId);
      setConfirming(null);
      onExit();
    } catch (err) {
      setActionError((err as Error).message);
      setConfirming(null);
    } finally {
      setBusy(null);
    }
  };

  const forfeit = async (): Promise<void> => {
    setBusy('forfeit');
    setActionError(null);
    try {
      await api.forfeitTable(tableId);
      setConfirming(null);
    } catch (err) {
      setActionError((err as Error).message);
      setConfirming(null);
    } finally {
      setBusy(null);
    }
  };

  const rematch = async (): Promise<void> => {
    setBusy('rematch');
    setActionError(null);
    try {
      const { id } = await api.rematch(tableId);
      onOpen(id);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyInvite = async (): Promise<void> => {
    const target = snapshot?.code
      ? `${location.origin}${location.pathname}#/join/${snapshot.code}`
      : `${location.origin}${location.pathname}#/table/${tableId}`;
    if (await copyText(target)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      setActionError(`复制失败，手动复制这个地址：${target}`);
    }
  };

  const acknowledge = async (): Promise<void> => {
    if (!snapshot?.notice) return;
    setAckedVersion(snapshot.notice.version);
    await api.ackNotice(snapshot.notice.gameId, snapshot.notice.version).catch(() => undefined);
  };

  if (!snapshot) {
    return <div className="center">{error ?? '连接中…'}</div>;
  }

  const remainingMs = snapshot.deadlineAt === null ? null : Math.max(0, snapshot.deadlineAt - now);
  const canStart = snapshot.you.isHost && snapshot.players.length >= snapshot.minPlayers;
  const canJoin = !snapshot.you.isPlayer && snapshot.status === 'lobby';
  const message = actionError ?? error ?? clientError;
  const notice = snapshot.notice && snapshot.notice.version !== ackedVersion ? snapshot.notice : null;

  return (
    <div className="table-page">
      <header className="topbar">
        {/* 即时制没有"回大厅"：人走了这局就没人替他打了，退出等于认负 */}
        {snapshot.mode === 'realtime' ? null : (
          <button className="ghost" onClick={onExit}>
            ← 大厅
          </button>
        )}
        <div className="title">
          {snapshot.gameName}
          <span className="muted version">v{snapshot.gameVersion}</span>
          {snapshot.code ? <span className="room-code">{snapshot.code}</span> : null}
          <span className="badge">{snapshot.mode === 'realtime' ? '即时' : '回合制'}</span>
          {snapshot.friendly ? <span className="badge">友谊赛 · 不计分</span> : null}
        </div>
        <div className={`badge ${snapshot.status}`}>{STATUS_LABEL[snapshot.status]}</div>
        {remainingMs !== null ? (
          <div className={`timer ${remainingMs < 5000 ? 'urgent' : ''}`}>
            ⏱ {Math.ceil(remainingMs / 1000)}s
          </div>
        ) : null}
        <div className="spacer" />
        <span className="muted small">👁 {snapshot.viewers}</span>
        {snapshot.status === 'finished' && snapshot.you.isPlayer ? (
          <button className="primary" disabled={busy === 'rematch'} onClick={() => void rematch()}>
            {busy === 'rematch' ? '开桌中…' : '再来一局'}
          </button>
        ) : null}
        {snapshot.status === 'finished' ? (
          <button className="ghost" onClick={() => onReplay(tableId)}>
            看回放
          </button>
        ) : null}
        {snapshot.you.isPlayer && snapshot.status === 'lobby' ? (
          <button className="ghost" onClick={() => setConfirming('leave')}>
            离开
          </button>
        ) : null}
        {snapshot.you.isPlayer && snapshot.status === 'playing' ? (
          <button className="ghost danger-text" onClick={() => setConfirming('forfeit')}>
            退出
          </button>
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
                  {player.bot ? <span className="tag">🤖</span> : null}
                  {player.id === snapshot.hostId ? <span className="tag">房主</span> : null}
                  {player.forfeited ? <span className="tag">认负</span> : null}
                  {snapshot.activePlayer === player.id ? <span className="active-dot" /> : null}
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
              <div className="muted small">
                {snapshot.code
                  ? `房间号 ${snapshot.code}：念给朋友，或者把链接发过去。`
                  : '链接发给朋友，他们在同一个地址打开就能加入。'}
              </div>
            </div>
          ) : (
            <GameSurface
              client={client}
              snapshot={{
                status: snapshot.status,
                view: snapshot.view,
                legal: snapshot.legal,
                legalMoves: snapshot.legalMoves,
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

          <div className="chat">
            <h3>聊天</h3>
            <ul className="chat-list" ref={chatRef}>
              {snapshot.chat.map((message) => (
                <li key={message.id} className={message.userId === session.user.id ? 'mine' : ''}>
                  <span className="chat-name">{message.name}</span>
                  <span className="chat-body">{message.body}</span>
                </li>
              ))}
              {snapshot.chat.length === 0 ? <li className="muted">还没有人说话</li> : null}
            </ul>
            <form
              className="chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (!text) return;
                sendChat(text);
                setDraft('');
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="说点什么…"
                maxLength={200}
              />
              <button className="primary" type="submit" disabled={!draft.trim()}>
                发送
              </button>
            </form>
          </div>
        </aside>
      </div>

      {confirming === 'leave' ? (
        <ConfirmDialog
          title="离开这张桌？"
          body="还没开局，离开不会影响任何人。房主离开时，房主会顺位交给下一个人；如果只剩你一个，这张桌会关掉。"
          confirmLabel="离开"
          busy={busy === 'leave'}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void leave()}
        />
      ) : null}

      {confirming === 'forfeit' ? (
        <ConfirmDialog
          title="退出并认负？"
          body="这一局会立刻结束，你判负，对手获胜。退出算正常结束，战绩和 Elo 都会记录——中途离开不会被当成没事发生。"
          confirmLabel="退出并认负"
          danger
          busy={busy === 'forfeit'}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void forfeit()}
        />
      ) : null}

      {notice ? (
        <div className="backdrop">
          <div className="dialog">
            <h2>
              {notice.gameName} 更新到 v{notice.version}
            </h2>
            <ul className="notice-list">
              {notice.notes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="muted small">这条公告每个版本只弹一次。</p>
            <div className="dialog-actions">
              <button className="primary" onClick={() => void acknowledge()}>
                我知道了
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
