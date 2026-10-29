import { useEffect, useState } from 'react';
import type { ReplayPayload } from '@platform/sdk';
import { api } from '../api';
import { GameSurface } from '../host/GameSurface';
import { useGameClient } from '../host/useGameClient';
import { renderLog } from '../log';

/**
 * 回放页：服务端把动作日志重放成"每一步的观战者视角快照"，
 * 这里只负责在时间轴上切换。
 */
export function ReplayView({ tableId, onExit }: { tableId: string; onExit: () => void }) {
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let disposed = false;
    api
      .replay(tableId)
      .then(({ replay: payload }) => {
        if (disposed) return;
        setReplay(payload);
        setIndex(0);
      })
      .catch((err: Error) => {
        if (!disposed) setError(err.message);
      });
    return () => {
      disposed = true;
    };
  }, [tableId]);

  const { client, error: clientError } = useGameClient(
    replay?.gameId ?? '',
    replay?.gameVersion ?? '',
  );

  const steps = replay?.steps ?? [];
  const step = steps[Math.min(index, Math.max(0, steps.length - 1))];

  useEffect(() => {
    if (!playing || steps.length === 0) return;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= steps.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [playing, steps.length]);

  if (error) return <div className="center">{error}</div>;
  if (!replay) return <div className="center">加载回放…</div>;
  if (!step) return <div className="center">这局还没有可回放的记录</div>;

  const stop = (next: number): void => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(steps.length - 1, next)));
  };

  return (
    <div className="table-page">
      <header className="topbar">
        <button className="ghost" onClick={onExit}>
          ← 返回
        </button>
        <div className="title">
          {replay.gameName}
          <span className="muted version">v{replay.gameVersion}</span>
        </div>
        <div className="badge">回放</div>
        <div className="spacer" />
        <span className="muted small">
          第 {index + 1} / {steps.length} 步
        </span>
      </header>

      {clientError ? <div className="error">{clientError}</div> : null}

      <div className="replay-controls">
        <button className="ghost" onClick={() => stop(0)}>
          ⏮
        </button>
        <button className="ghost" onClick={() => stop(index - 1)}>
          ◀
        </button>
        <button className="primary" onClick={() => setPlaying((value) => !value)}>
          {playing ? '暂停' : '播放'}
        </button>
        <button className="ghost" onClick={() => stop(index + 1)}>
          ▶
        </button>
        <button className="ghost" onClick={() => stop(steps.length - 1)}>
          ⏭
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, steps.length - 1)}
          value={index}
          onChange={(event) => stop(Number(event.target.value))}
        />
      </div>

      {replay.truncated ? (
        <div className="muted small">回放过长，只保留前 {steps.length} 步。</div>
      ) : null}

      <div className="table-body">
        <section className="board">
          <div className="seats">
            {replay.players.map((player) => {
              const classes = ['seat'];
              if (step.view.turn === player.id) classes.push('active');
              return (
                <div key={player.id} className={classes.join(' ')}>
                  <span className="seat-name">{player.name}</span>
                </div>
              );
            })}
          </div>

          <GameSurface
            client={client}
            snapshot={{
              status: step.view.finished ? 'finished' : 'playing',
              view: step.view,
              legal: [],
              deadlineAt: null,
            }}
            me="spectator"
            players={replay.players}
            onAction={() => undefined}
          />
        </section>

        <aside className="sidebar">
          <h3>日志</h3>
          <ul className="log-list">
            {step.log.map((entry) => (
              <li key={entry.seq}>
                <span className="log-seq">{entry.seq}</span>
                {renderLog(entry, client)}
              </li>
            ))}
            {step.log.length === 0 ? <li className="muted">开局</li> : null}
          </ul>
        </aside>
      </div>
    </div>
  );
}
