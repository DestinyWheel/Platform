import { useCallback, useEffect, useRef, useState } from 'react';
import { api, loadSession, saveSession, setAuthToken, setUnauthorizedHandler, type Session } from './api';
import { Lobby } from './views/Lobby';
import { Admin } from './views/Admin';
import { GameDetail } from './views/GameDetail';
import { Login } from './views/Login';
import { Messages } from './views/Messages';
import { PluginDocs } from './views/PluginDocs';
import { ReplayView } from './views/ReplayView';
import { TableView } from './views/TableView';
import { UserCenter } from './views/UserCenter';
import { UserProfile } from './views/UserProfile';

type View =
  | { name: 'lobby' }
  | { name: 'table'; id: string }
  | { name: 'replay'; id: string }
  | { name: 'game'; id: string }
  | { name: 'user' }
  | { name: 'docs' }
  | { name: 'admin' }
  /** 私聊：可选带上"直接跟谁聊" */
  | { name: 'messages'; peer?: string }
  | { name: 'profile'; id: string };

function readHash(): View {
  const table = /^#\/table\/([\w-]+)$/.exec(location.hash);
  if (table?.[1]) return { name: 'table', id: table[1] };

  const replay = /^#\/replay\/([\w-]+)$/.exec(location.hash);
  if (replay?.[1]) return { name: 'replay', id: replay[1] };

  const game = /^#\/game\/([\w-]+)$/.exec(location.hash);
  if (game?.[1]) return { name: 'game', id: game[1] };

  const profile = /^#\/u\/([\w-]+)$/.exec(location.hash);
  if (profile?.[1]) return { name: 'profile', id: profile[1] };

  const messages = /^#\/messages(?:\/([\w-]+))?$/.exec(location.hash);
  if (messages) return { name: 'messages', peer: messages[1] };

  if (location.hash === '#/admin') return { name: 'admin' };
  if (location.hash === '#/me') return { name: 'user' };
  if (location.hash === '#/docs') return { name: 'docs' };

  return { name: 'lobby' };
}

function writeHash(view: View): void {
  const next =
    view.name === 'table'
      ? `#/table/${view.id}`
      : view.name === 'replay'
        ? `#/replay/${view.id}`
        : view.name === 'game'
          ? `#/game/${view.id}`
          : view.name === 'profile'
            ? `#/u/${view.id}`
            : view.name === 'messages'
              ? view.peer
                ? `#/messages/${view.peer}`
                : '#/messages'
              : view.name === 'admin'
                ? '#/admin'
                : view.name === 'user'
                  ? '#/me'
                  : view.name === 'docs'
                    ? '#/docs'
                    : '#/';
  if (location.hash !== next) history.replaceState(null, '', next);
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState<View>(() => readHash());
  const [notice, setNotice] = useState<string | null>(null);
  /** 401 处理要知道"当前是不是已登录"：未登录时密码输错也是 401，不该弹"登录已过期" */
  const authedRef = useRef(false);

  useEffect(() => {
    authedRef.current = session !== null;
    setAuthToken(session?.token ?? null);
  }, [session]);

  // 任何接口回了 401（令牌过期、改过密码、在别处退出）都回到登录页，而不是卡在报错的页面上
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!authedRef.current) return;
      authedRef.current = false;
      saveSession(null);
      setNotice('登录状态已过期，请重新登录');
      setSession(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // 打开页面时用库里的事实刷新一次当前用户：管理员可能已经被改过权限，
  // 本地 localStorage 里的 isAdmin 只是上次登录时的快照
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api
      .me()
      .then((data) => {
        if (cancelled) return;
        const next = { ...session, user: data.user };
        saveSession(next);
        setSession(next);
      })
      .catch(() => undefined); // 401 会由上面的统一处理回登录页
    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次；之后 session 变了也没必要再问
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onHashChange = () => setView(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (next: View): void => {
    writeHash(next);
    setView(next);
  };

  /*
   * 邀请链接 #/join/ABC234：拿到码就直接进桌（开打了就是观战）。
   *
   * 原来的写法只跑在 [session] 上，有两个洞：
   *   ① 没登录时点链接——登录成功后 hash 已被改回大厅，码就丢了；
   *   ② 在页面内点链接（私聊卡片、聊天里的 #/join/xxx）——session 没变，
   *      同一个 effect 根本不会重跑。
   * 所以码先记在 pendingJoin 里，登录后再补一次，另外挂 hashchange 监听。
   */
  const joinOnce = useRef<string | null>(null);
  const pendingJoin = useRef<string | null>(null);

  const readJoinCode = (): string | null => {
    const match = /^#\/join\/([A-Za-z0-9]{4,8})$/.exec(location.hash);
    return match?.[1] ? match[1].toUpperCase() : null;
  };

  const joinByCode = useCallback(async (code: string): Promise<void> => {
    const target = code.toUpperCase();
    if (joinOnce.current === target) return;
    joinOnce.current = target;
    try {
      const { id } = await api.joinByCode(target);
      navigate({ name: 'table', id });
    } catch (error) {
      // 房间没了 / 你已经在别的即时房里……说清楚，别默默回大厅
      joinOnce.current = null;
      setNotice((error as Error).message);
      navigate({ name: 'lobby' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 登录前点进来的邀请先记着，登录后接着进
  useEffect(() => {
    const code = readJoinCode();
    if (code) pendingJoin.current = code;
    if (!session) return;
    const pending = pendingJoin.current;
    if (!pending) return;
    pendingJoin.current = null;
    void joinByCode(pending);
  }, [session, joinByCode]);

  // 页面里点邀请链接（私聊卡片、聊天里的 #/join/xxx）
  useEffect(() => {
    const onHashChange = (): void => {
      if (!session) return;
      const code = readJoinCode();
      if (code) void joinByCode(code);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [session, joinByCode]);

  // 手敲 #/admin 也进不去：后端本来就拦，前端也别把页面画出来
  useEffect(() => {
    if (view.name === 'admin' && session && !session.user.isAdmin) {
      navigate({ name: 'lobby' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, session]);

  if (!session) {
    return (
      <Login
        notice={notice}
        onLogin={(next) => {
          saveSession(next);
          setNotice(null);
          setSession(next);
          navigate({ name: 'lobby' });
        }}
      />
    );
  }

  if (view.name === 'table') {
    return (
      <TableView
        tableId={view.id}
        session={session}
        onExit={() => navigate({ name: 'lobby' })}
        onOpen={(id) => navigate({ name: 'table', id })}
        onReplay={(id) => navigate({ name: 'replay', id })}
        onProfile={(id) => navigate({ name: 'profile', id })}
      />
    );
  }

  if (view.name === 'game') {
    return (
      <GameDetail
        gameId={view.id}
        onBack={() => navigate({ name: 'lobby' })}
        onOpen={(id) => navigate({ name: 'table', id })}
      />
    );
  }

  if (view.name === 'docs') {
    return <PluginDocs onBack={() => navigate({ name: 'lobby' })} />;
  }

  if (view.name === 'user') {
    return (
      <UserCenter
        session={session}
        onSession={(next) => {
          saveSession(next);
          setSession(next);
        }}
        onExit={() => navigate({ name: 'lobby' })}
        onOpenProfile={(id) => navigate({ name: 'profile', id })}
        onMessage={(id) => navigate({ name: 'messages', peer: id })}
      />
    );
  }

  if (view.name === 'profile') {
    return (
      <UserProfile
        userId={view.id}
        session={session}
        onBack={() => navigate({ name: 'lobby' })}
        onMessage={(id) => navigate({ name: 'messages', peer: id })}
      />
    );
  }

  if (view.name === 'messages') {
    return (
      <Messages
        session={session}
        initialPeer={view.peer}
        onBack={() => navigate({ name: 'lobby' })}
        onOpenProfile={(id) => navigate({ name: 'profile', id })}
      />
    );
  }

  if (view.name === 'admin') {
    if (!session.user.isAdmin) return null;
    return <Admin session={session} onExit={() => navigate({ name: 'lobby' })} />;
  }

  if (view.name === 'replay') {
    return <ReplayView tableId={view.id} onExit={() => navigate({ name: 'lobby' })} />;
  }

  return (
    <Lobby
      session={session}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      onOpen={(id) => navigate({ name: 'table', id })}
      onReplay={(id) => navigate({ name: 'replay', id })}
      onAdmin={() => navigate({ name: 'admin' })}
      onUser={() => navigate({ name: 'user' })}
      onGame={(id) => navigate({ name: 'game', id })}
      onDocs={() => navigate({ name: 'docs' })}
      onMessages={() => navigate({ name: 'messages' })}
      onProfile={(id) => navigate({ name: 'profile', id })}
      onMessage={(id) => navigate({ name: 'messages', peer: id })}
      onLogout={() => {
        // 先让服务端把令牌作废（token_version +1），再清本地；
        // 失败也没关系——本地已经清掉了，服务端那份留到过期也进不来这个设备
        void api.logout().catch(() => undefined);
        saveSession(null);
        setSession(null);
        navigate({ name: 'lobby' });
      }}
    />
  );
}
