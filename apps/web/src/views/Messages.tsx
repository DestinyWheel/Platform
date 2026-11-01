import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectMessage, DirectThread, UserCard } from '@platform/sdk';
import { api, type Session } from '../api';
import { formatTime } from '../format';

/**
 * 私聊页。
 *
 * 左边是会话列表，右边是对话。没有实时推送时用轮询（8 秒一次会话、5 秒一次对话），
 * 一个人数不多的私有平台这样就够；以后要上 WS 只换这两个定时器即可。
 */
export function Messages({
  session,
  initialPeer,
  onBack,
  onOpenProfile,
}: {
  session: Session;
  initialPeer?: string | null;
  onBack: () => void;
  onOpenProfile: (userId: string) => void;
}) {
  const [threads, setThreads] = useState<DirectThread[]>([]);
  const [peer, setPeer] = useState<UserCard | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadThreads = useCallback(async (): Promise<{ threads: DirectThread[] } | undefined> => {
    try {
      const data = await api.dmThreads();
      setThreads(data.threads);
      return data;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    }
  }, []);

  const openThread = useCallback(async (userId: string): Promise<void> => {
    try {
      const data = await api.dmMessages(userId);
      setPeer(data.user);
      setMessages(data.messages);
      setError(null);
      setThreads((current) =>
        current.map((thread) =>
          thread.user.id === userId ? { ...thread, unread: 0 } : thread,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // 打开页面就算「看过消息」：铃铛归零
  useEffect(() => {
    void api.markSeen().catch(() => undefined);
    void (async () => {
      const data = await loadThreads();
      // 没指定跟谁聊时，直接打开最近的那个会话，省一次点击
      if (!initialPeer && data && data.threads.length > 0) {
        await openThread(data.threads[0]!.user.id);
      }
    })();
    const timer = window.setInterval(() => void loadThreads(), 8000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadThreads]);

  useEffect(() => {
    if (!initialPeer) return;
    void openThread(initialPeer);
    // 只在进来时按参数开一次；之后点列表自己切换
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeer]);

  // 对话里定时拉新消息
  useEffect(() => {
    if (!peer) return;
    const timer = window.setInterval(() => void openThread(peer.id), 5000);
    return () => window.clearInterval(timer);
  }, [peer?.id, openThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, peer?.id]);

  // 找人开新会话
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .searchUsers(trimmed)
        .then((data) => setResults(data.users))
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const send = async (): Promise<void> => {
    if (!peer) return;
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      const { message } = await api.sendDm(peer.id, body);
      setMessages((current) => [...current, message]);
      setText('');
      await loadThreads();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startWith = (user: UserCard): void => {
    setQuery('');
    setResults([]);
    setPeer(user);
    setMessages([]);
    void openThread(user.id);
  };

  return (
    <div className="lobby dm-page">
      <header className="topbar">
        <button className="ghost" onClick={onBack}>
          ← 大厅
        </button>
        <div className="title">消息</div>
        <div className="spacer" />
        <span className="muted small">{session.user.name}</span>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <div className="dm-layout">
        <aside className="dm-list">
          <div className="dm-search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按昵称或 #编号 找人"
              aria-label="找人聊天"
            />
          </div>
          {results.length > 0 ? (
            <ul className="dm-results">
              {results.map((user) => (
                <li key={user.id}>
                  <button className="link" onClick={() => startWith(user)}>
                    {user.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <ul className="dm-threads">
            {threads.map((thread) => (
              <li key={thread.user.id}>
                <button
                  className={peer?.id === thread.user.id ? 'dm-thread active' : 'dm-thread'}
                  onClick={() => startWith(thread.user)}
                >
                  <div className="dm-thread-head">
                    <span className="dm-name">{thread.user.name}</span>
                    {thread.unread > 0 ? <span className="dm-unread">{thread.unread}</span> : null}
                  </div>
                  <div className="dm-preview">
                    {thread.last
                      ? `${thread.last.from === session.user.id ? '我：' : ''}${thread.last.body}`
                      : ''}
                  </div>
                </button>
              </li>
            ))}
            {threads.length === 0 ? (
              <li className="muted small dm-empty">还没有私聊。上面搜个人开始聊。</li>
            ) : null}
          </ul>
        </aside>

        <section className="dm-thread-panel">
          {peer ? (
            <>
              <div className="dm-thread-title">
                <button className="link" onClick={() => onOpenProfile(peer.id)}>
                  {peer.name}
                </button>
                <span className="muted small">点名字看主页</span>
              </div>

              <div className="dm-messages">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={message.from === session.user.id ? 'dm-bubble mine' : 'dm-bubble'}
                  >
                    <div className="dm-body">{message.body}</div>
                    <div className="dm-time">{formatTime(message.at)}</div>
                  </div>
                ))}
                {messages.length === 0 ? (
                  <p className="muted small">还没有消息，打个招呼吧。</p>
                ) : null}
                <div ref={bottomRef} />
              </div>

              <div className="dm-composer">
                <input
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="说点什么（Enter 发送）"
                  maxLength={500}
                  aria-label="消息内容"
                />
                <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
                  发送
                </button>
              </div>
            </>
          ) : (
            <p className="muted dm-placeholder">左边选一个人，或者搜一个新朋友。</p>
          )}
        </section>
      </div>
    </div>
  );
}
