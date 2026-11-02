import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage, TableSnapshot } from '@platform/sdk';

export interface TableSocket {
  snapshot: TableSnapshot | null;
  error: string | null;
  sendAction: (type: string, payload?: unknown) => void;
  sendChat: (text: string) => void;
}

/**
 * 一条 WS 连接订阅一张桌。
 * 断线自动重连（指数退避到 5s），seq 只增不减，旧快照直接丢弃。
 */
export function useTableSocket(tableId: string, token: string): TableSocket {
  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let attempts = 0;
    // 换桌（再来一局 / 从别处跳进来）时旧快照必须清掉，
    // 否则它带着更高的 seq，会把新桌的快照挡在门外。
    setSnapshot(null);
    setError(null);

    const connect = (): void => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${protocol}://${location.host}/ws?token=${encodeURIComponent(token)}`,
      );
      socketRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
        ws.send(JSON.stringify({ t: 'subscribe', tableId }));
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        // 换桌后旧 socket 可能还有排队中的消息，不能让它们覆盖新桌
        if (disposed) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }

        if (msg.t === 'snapshot' && msg.snapshot.tableId === tableId) {
          setSnapshot((prev) =>
            prev && prev.tableId === msg.snapshot.tableId && prev.seq > msg.snapshot.seq
              ? prev
              : msg.snapshot,
          );
          setError(null);
        } else if (msg.t === 'error') {
          setError(msg.message);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        attempts += 1;
        retryTimer = window.setTimeout(connect, Math.min(500 * attempts, 5000));
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [tableId, token]);

  const sendAction = useCallback(
    (type: string, payload?: unknown) => {
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'action', tableId, type, payload }));
      }
    },
    [tableId],
  );

  const sendChat = useCallback(
    (text: string) => {
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'chat', tableId, text }));
      }
    },
    [tableId],
  );

  return { snapshot, error, sendAction, sendChat };
}
