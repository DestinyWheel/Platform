import { useEffect, useState } from 'react';
import { loadSession, saveSession, setAuthToken, type Session } from './api';
import { Lobby } from './views/Lobby';
import { Login } from './views/Login';
import { ReplayView } from './views/ReplayView';
import { TableView } from './views/TableView';

type View = { name: 'lobby' } | { name: 'table'; id: string } | { name: 'replay'; id: string };

function readHash(): View {
  const table = /^#\/table\/([\w-]+)$/.exec(location.hash);
  if (table?.[1]) return { name: 'table', id: table[1] };

  const replay = /^#\/replay\/([\w-]+)$/.exec(location.hash);
  if (replay?.[1]) return { name: 'replay', id: replay[1] };

  return { name: 'lobby' };
}

function writeHash(view: View): void {
  const next =
    view.name === 'table'
      ? `#/table/${view.id}`
      : view.name === 'replay'
        ? `#/replay/${view.id}`
        : '#/';
  if (location.hash !== next) history.replaceState(null, '', next);
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState<View>(() => readHash());

  useEffect(() => {
    setAuthToken(session?.token ?? null);
  }, [session]);

  useEffect(() => {
    const onHashChange = () => setView(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (next: View): void => {
    writeHash(next);
    setView(next);
  };

  if (!session) {
    return (
      <Login
        onLogin={(next) => {
          saveSession(next);
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
        onReplay={(id) => navigate({ name: 'replay', id })}
      />
    );
  }

  if (view.name === 'replay') {
    return <ReplayView tableId={view.id} onExit={() => navigate({ name: 'lobby' })} />;
  }

  return (
    <Lobby
      session={session}
      onOpen={(id) => navigate({ name: 'table', id })}
      onReplay={(id) => navigate({ name: 'replay', id })}
      onLogout={() => {
        saveSession(null);
        setSession(null);
        navigate({ name: 'lobby' });
      }}
    />
  );
}
