import { useEffect, useRef, useState } from 'react';
import { api, loadSession, saveSession, setAuthToken, setUnauthorizedHandler, type Session } from './api';
import { Lobby } from './views/Lobby';
import { Admin } from './views/Admin';
import { GameDetail } from './views/GameDetail';
import { Login } from './views/Login';
import { PluginDocs } from './views/PluginDocs';
import { ReplayView } from './views/ReplayView';
import { TableView } from './views/TableView';
import { UserCenter } from './views/UserCenter';

type View =
  | { name: 'lobby' }
  | { name: 'table'; id: string }
  | { name: 'replay'; id: string }
  | { name: 'game'; id: string }
  | { name: 'user' }
  | { name: 'docs' }
  | { name: 'admin' };

function readHash(): View {
  const table = /^#\/table\/([\w-]+)$/.exec(location.hash);
  if (table?.[1]) return { name: 'table', id: table[1] };

  const replay = /^#\/replay\/([\w-]+)$/.exec(location.hash);
  if (replay?.[1]) return { name: 'replay', id: replay[1] };

  const game = /^#\/game\/([\w-]+)$/.exec(location.hash);
  if (game?.[1]) return { name: 'game', id: game[1] };

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

  // 邀请链接 #/join/ABC234：拿到码就直接进桌（开打了就是观战）
  const joinOnce = useRef(false);
  useEffect(() => {
    const match = /^#\/join\/([A-Za-z0-9]{4,8})$/.exec(location.hash);
    if (!match?.[1] || !session || joinOnce.current) return;

    joinOnce.current = true;
    const code = match[1];
    api
      .joinByCode(code)
      .then(({ id }) => navigate({ name: 'table', id }))
      .catch(() => navigate({ name: 'lobby' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const navigate = (next: View): void => {
    writeHash(next);
    setView(next);
  };

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
      onOpen={(id) => navigate({ name: 'table', id })}
      onReplay={(id) => navigate({ name: 'replay', id })}
      onAdmin={() => navigate({ name: 'admin' })}
      onUser={() => navigate({ name: 'user' })}
      onGame={(id) => navigate({ name: 'game', id })}
      onDocs={() => navigate({ name: 'docs' })}
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
