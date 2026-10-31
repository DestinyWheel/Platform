import { useEffect, useState, type ReactElement } from 'react';
import type { GameManifest } from '@platform/sdk';
import { api } from '../api';

const MODE_LABEL: Record<string, string> = {
  turnbased: '回合制',
  realtime: '实时',
};

/**
 * 介绍文本的极简排版：空行分段，`## ` 开头是小标题，`- ` 开头的连续行是条目。
 *
 * 只做这三种，因为插件作者要的是"把话说清楚"，不是一个 markdown 解析器。
 */
function renderIntro(text: string): ReactElement[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const lines = block.split('\n').map((line) => line.trim());

      if (block.startsWith('## ')) {
        return (
          <h3 key={index} className="intro-title">
            {block.slice(3)}
          </h3>
        );
      }
      if (lines.every((line) => line.startsWith('- '))) {
        return (
          <ul key={index} className="intro-list">
            {lines.map((line, itemIndex) => (
              <li key={itemIndex}>{line.slice(2)}</li>
            ))}
          </ul>
        );
      }
      return (
        <p key={index}>
          {lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {line}
            </span>
          ))}
        </p>
      );
    });
}

/** 游戏详情：介绍 + 开房设置。开桌和开桌用的选项都放在这一页 */
export function GameDetail({
  gameId,
  onBack,
  onOpen,
}: {
  gameId: string;
  onBack: () => void;
  onOpen: (tableId: string) => void;
}) {
  const [games, setGames] = useState<GameManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'quick' | null>(null);
  const [seats, setSeats] = useState<number | null>(null);
  const [withBot, setWithBot] = useState(false);
  const [untimed, setUntimed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .games()
      .then((data) => {
        if (!cancelled) setGames(data.games);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const game = games?.find((item) => item.id === gameId) ?? null;
  const seatCount = seats ?? game?.players.max ?? 2;

  const createTable = async (): Promise<void> => {
    if (!game) return;
    setBusy('create');
    setError(null);
    try {
      const { id } = await api.createTable({
        gameId: game.id,
        maxPlayers: seatCount,
        ...(withBot || untimed
          ? {
              options: {
                ...(withBot ? { bots: 1 } : {}),
                ...(untimed ? { untimed: true, turnMs: 0 } : {}),
              },
            }
          : {}),
      });
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const quickMatch = async (): Promise<void> => {
    if (!game) return;
    setBusy('quick');
    setError(null);
    try {
      const { id } = await api.quickMatch(game.id);
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lobby game-detail">
      <header className="topbar">
        <button className="ghost" onClick={onBack}>
          ← 大厅
        </button>
        <div className="title">{game?.name ?? '游戏详情'}</div>
        <div className="spacer" />
        {game ? <span className="muted small">v{game.version}</span> : null}
      </header>

      {error ? <div className="error">{error}</div> : null}

      {!game ? (
        <p className="muted">{games ? '这个游戏不存在，或者已被管理员禁用。' : '加载中…'}</p>
      ) : (
        <div className="detail-columns">
          <section className="detail-main">
            {game.description ? <p className="detail-lead">{game.description}</p> : null}

            <div className="detail-meta">
              <span>
                {game.players.min}–{game.players.max} 人
              </span>
              <span>约 {game.estimatedMinutes} 分钟</span>
              <span>{game.modes.map((mode) => MODE_LABEL[mode] ?? mode).join(' / ')}</span>
              <div className="tags">
                {game.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>

            {game.intro ? (
              <div className="intro">{renderIntro(game.intro)}</div>
            ) : (
              <p className="muted">这个游戏还没写介绍。</p>
            )}
          </section>

          <aside className="detail-side">
            <h2>开一局</h2>

            {game.players.max > game.players.min ? (
              <label className="field">
                <span>座位</span>
                <select
                  value={seatCount}
                  onChange={(event) => setSeats(Number(event.target.value))}
                >
                  {Array.from({ length: game.players.max - game.players.min + 1 }, (_, index) => {
                    const count = game.players.min + index;
                    return (
                      <option key={count} value={count}>
                        {count} 人
                      </option>
                    );
                  })}
                </select>
              </label>
            ) : (
              <p className="muted small">固定 {game.players.min} 人</p>
            )}

            <label className="bot-toggle">
              <input
                type="checkbox"
                checked={withBot}
                onChange={(event) => setWithBot(event.target.checked)}
              />
              缺人时补一个机器人（单人也能开）
            </label>
            <label className="bot-toggle">
              <input
                type="checkbox"
                checked={untimed}
                onChange={(event) => setUntimed(event.target.checked)}
              />
              不限时（不自动换手，手动结束回合）
            </label>

            <button className="primary block" disabled={busy !== null} onClick={() => void createTable()}>
              {busy === 'create' ? '开桌中…' : '开桌'}
            </button>
            <button className="ghost block" disabled={busy !== null} onClick={() => void quickMatch()}>
              {busy === 'quick' ? '匹配中…' : '随便进一桌'}
            </button>
            <p className="muted small">
              开桌后会拿到一个 6 位房间号，把它发给朋友，他们在大厅输入就能进来。
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
