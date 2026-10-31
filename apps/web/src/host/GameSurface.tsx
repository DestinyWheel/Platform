import { useEffect, useRef } from 'react';
import type { ClientPlayer, ClientSnapshot, GameClient, GameClientContext } from '@platform/sdk';

export interface GameSurfaceProps {
  client: GameClient | null;
  snapshot: ClientSnapshot;
  me: string;
  players: ClientPlayer[];
  onAction: (type: string, payload?: unknown) => void;
}

/**
 * 插件 UI 的宿主容器：只负责 mount / update / unmount 三个生命周期，
 * 不关心插件内部怎么渲染。
 */
export function GameSurface({ client, snapshot, me, players, onAction }: GameSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<GameClient | null>(null);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const meRef = useRef(me);
  meRef.current = me;
  const playersRef = useRef(players);
  playersRef.current = players;

  useEffect(() => {
    const container = containerRef.current;
    if (!client || !container) return;

    client.mount({
      root: container,
      me: meRef.current,
      players: playersRef.current,
      send: (action) => onActionRef.current(action.type, action.payload),
    });
    mountedRef.current = client;
    client.update(snapshotRef.current);

    return () => {
      client.unmount?.();
      mountedRef.current = null;
      container.replaceChildren();
    };
  }, [client]);

  useEffect(() => {
    mountedRef.current?.update(snapshot);
  }, [snapshot]);

  return <div className="game-surface" ref={containerRef} />;
}

/**
 * 插件的右侧栏：挂在聊天上方。插件不声明 sidePanel 就什么都不渲染。
 */
export function GameSidePanel({
  client,
  snapshot,
  me,
  players,
  onAction,
}: GameSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<GameClient['sidePanel'] | null>(null);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const meRef = useRef(me);
  meRef.current = me;
  const playersRef = useRef(players);
  playersRef.current = players;

  useEffect(() => {
    const container = containerRef.current;
    const panel = client?.sidePanel;
    if (!panel || !container) return;

    const context: GameClientContext = {
      root: container,
      me: meRef.current,
      players: playersRef.current,
      send: (action) => onActionRef.current(action.type, action.payload),
    };
    panel.mount(context);
    mountedRef.current = panel;
    panel.update(snapshotRef.current);

    return () => {
      panel.unmount?.();
      mountedRef.current = null;
      container.replaceChildren();
    };
  }, [client]);

  useEffect(() => {
    mountedRef.current?.update(snapshot);
  }, [snapshot]);

  if (!client?.sidePanel) return null;
  return <div className="game-side" ref={containerRef} />;
}
