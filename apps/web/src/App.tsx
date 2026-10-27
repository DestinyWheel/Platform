import { useEffect, useState } from 'react';
import { loadSession, saveSession, setAuthToken, type Session } from './api';
import { Lobby } from './views/Lobby';
import { Login } from './views/Login';
import { TableView } from './views/TableView';

type View = { name: 'lobby' } | { name: 'table'; id: string };

function readHash(): View {
  const matched = /^#\/table\/([\w-]+)$/.exec(location.hash);
  return matched?.[1] ? { name: 'table', id: matched[1] } : { name: 'lobby' };
}

function writeHash(view: View): void {
  const next = view.name === 'table' ? `#/table/${view.id}` : '#/';
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
    return <TableView tableId={view.id} session={session} onExit={() => navigate({ name: 'lobby' })} />;
  }

  return (
    <Lobby
      session={session}
      onOpen={(id) => navigate({ name: 'table', id })}
      onLogout={() => {
        saveSession(null);
        setSession(null);
        navigate({ name: 'lobby' });
      }}
    />
  );
}
