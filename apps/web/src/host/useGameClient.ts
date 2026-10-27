import { useEffect, useState } from 'react';
import type { GameClient } from '@platform/sdk';
import { loadGameClient } from './loadClient';

export interface GameClientState {
  client: GameClient | null;
  error: string | null;
}

/** 加载某个游戏某个版本的前端插件实例 */
export function useGameClient(gameId: string, version: string): GameClientState {
  const [client, setClient] = useState<GameClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId || !version) return;
    let disposed = false;
    setClient(null);
    setError(null);

    loadGameClient(gameId, version)
      .then((loaded) => {
        if (!disposed) setClient(loaded);
      })
      .catch((err: Error) => {
        if (!disposed) setError(err.message);
      });

    return () => {
      disposed = true;
    };
  }, [gameId, version]);

  return { client, error };
}
