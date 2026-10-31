import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminOverview, AdminPluginVersion, AdminUserRow } from '@platform/sdk';
import { ApiError, api, type Session } from '../api';
import { copyText } from '../clipboard';

type Tab = 'overview' | 'plugins' | 'users';

const TAB_LABEL: Record<Tab, string> = {
  overview: '概览',
  plugins: '插件',
  users: '用户',
};

const STATUS_LABEL: Record<AdminPluginVersion['status'], string> = {
  active: '生效中',
  retired: '已退役',
  pending: '待激活',
  failed: '失败',
  disabled: '已禁用',
};

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return (error as Error).message;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(at: number | null): string {
  if (!at) return '—';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Admin({ session, onExit }: { session: Session; onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [versions, setVersions] = useState<AdminPluginVersion[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [backups, setBackups] = useState<{
    keep: number;
    bytes: number;
    files: { name: string; bytes: number; createdAt: number }[];
  }>({ keep: 14, bytes: 0, files: [] });
  /** 重置出来的临时口令只显示这一次，关掉就再也看不到 */
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadOverview = useCallback(async (): Promise<void> => {
    try {
      const [data, backupList] = await Promise.all([api.adminOverview(), api.adminBackups()]);
      setOverview(data);
      setBackups(backupList);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const loadPlugins = useCallback(async (): Promise<void> => {
    try {
      const data = await api.adminPlugins();
      setVersions(data.versions);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const loadUsers = useCallback(async (): Promise<void> => {
    try {
      const data = await api.adminUsers();
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    if (tab === 'overview') void loadOverview();
    if (tab === 'plugins') void loadPlugins();
    if (tab === 'users') void loadUsers();
  }, [tab, loadOverview, loadPlugins, loadUsers]);

  // 概览页自己转，运维时不时瞟一眼就够了
  useEffect(() => {
    if (tab !== 'overview') return;
    const timer = window.setInterval(() => void loadOverview(), 5000);
    return () => window.clearInterval(timer);
  }, [tab, loadOverview]);

  const run = async (key: string, action: () => Promise<string>): Promise<void> => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const upload = (file: File): void => {
    void run('upload', async () => {
      const buffer = await file.arrayBuffer();
      const record = await api.adminUpload(buffer);
      await Promise.all([loadPlugins(), loadOverview()]);
      return `已发布 ${record.gameId}@${record.version}（${record.status}），服务没有重启`;
    });
  };

  const activate = (version: AdminPluginVersion): void => {
    void run(`activate:${version.gameId}@${version.version}`, async () => {
      await api.adminActivate(version.gameId, version.version);
      await Promise.all([loadPlugins(), loadOverview()]);
      return `已切到 ${version.gameId}@${version.version}；进行中的牌桌仍跑它们开局时锁定的版本`;
    });
  };

  const disable = (version: AdminPluginVersion): void => {
    void run(`disable:${version.gameId}@${version.version}`, async () => {
      await api.adminDisable(version.gameId, version.version);
      await Promise.all([loadPlugins(), loadOverview()]);
      return `已禁用 ${version.gameId}：大厅不再显示，也开不了新房；进行中的牌桌不受影响`;
    });
  };

  const gc = (): void => {
    void run('gc', async () => {
      const result = await api.adminGc();
      await Promise.all([loadPlugins(), loadOverview()]);
      return result.released.length === 0
        ? '没有可回收的 worker'
        : `已卸载 ${result.released.join('、')}`;
    });
  };

  const republish = (): void => {
    void run('republish', async () => {
      const result = await api.adminRepublish();
      await Promise.all([loadPlugins(), loadOverview()]);
      return `已重新扫描 games/：${result.games.join('、')}`;
    });
  };

  const backup = (): void => {
    void run('backup', async () => {
      const result = await api.adminBackup();
      await loadOverview();
      const pruned = result.pruned.length > 0 ? `，清理了 ${result.pruned.length} 份旧备份` : '';
      return `备份已写入 ${result.file}（${formatBytes(result.bytes)}）${pruned}`;
    });
  };

  const toggleAdmin = (user: AdminUserRow): void => {
    const next = !user.isAdmin;
    if (!next && !window.confirm(`取消 ${user.name} 的管理员权限？`)) return;
    void run(`admin:${user.id}`, async () => {
      await api.adminSetAdmin(user.id, next);
      await Promise.all([loadUsers(), loadOverview()]);
      return next ? `${user.name} 现在是管理员` : `${user.name} 已降为普通用户`;
    });
  };

  const resetPassword = (user: AdminUserRow): void => {
    if (!window.confirm(`重置 ${user.name} 的密码？他当前的登录会立刻失效。`)) return;
    void run(`reset:${user.id}`, async () => {
      const result = await api.adminResetPassword(user.id);
      setSecret({ name: user.name, password: result.password });
      await loadUsers();
      return '';
    });
  };

  const copySecret = (): void => {
    if (!secret) return;
    void copyText(secret.password);
  };

  const tableCount = (status: string): number => overview?.tables[status] ?? 0;

  return (
    <div className="lobby">
      <header className="topbar">
        <button className="ghost" onClick={onExit}>
          ← 大厅
        </button>
        <div className="title">管理后台</div>
        <div className="spacer" />
        <span className="muted">{session.user.name}</span>
      </header>

      <div className="admin-tabs">
        {(Object.keys(TAB_LABEL) as Tab[]).map((name) => (
          <button
            key={name}
            className={tab === name ? 'active' : ''}
            onClick={() => {
              setTab(name);
              setNotice(null);
            }}
          >
            {TAB_LABEL[name]}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {secret ? (
        <div className="secret">
          <div>
            <strong>{secret.name}</strong> 的新口令（只显示这一次）：
            <code>{secret.password}</code>
          </div>
          <div className="secret-actions">
            <button className="ghost small" onClick={copySecret}>
              复制
            </button>
            <button className="ghost small" onClick={() => setSecret(null)}>
              关闭
            </button>
          </div>
        </div>
      ) : null}

      {tab === 'overview' ? (
        <section>
          {overview ? (
            <>
              <div className="stat-grid">
                <div className="stat">
                  <div className="stat-label">运行时长</div>
                  <div className="stat-value">{formatDuration(overview.uptime)}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">数据库</div>
                  <div className="stat-value">{overview.db === 'pglite' ? 'PGlite' : 'Postgres'}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">内存 RSS</div>
                  <div className="stat-value">{formatBytes(overview.memory.rss)}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">插件 worker</div>
                  <div className="stat-value">{overview.workers.length}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">牌桌（等待/进行/结束）</div>
                  <div className="stat-value">
                    {tableCount('lobby')} / {tableCount('playing')} / {tableCount('finished')}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">用户 / 管理员</div>
                  <div className="stat-value">
                    {overview.users.total} / {overview.users.admins}
                  </div>
                </div>
              </div>

              <h2>在线插件</h2>
              <div className="muted small">
                {overview.workers.length === 0
                  ? '内存里没有活着的插件 worker'
                  : overview.workers.join('、')}
                {overview.inUse.length > 0 ? `　·　有牌桌在用：${overview.inUse.join('、')}` : ''}
              </div>

              <h2>备份</h2>
              <div className="actions">
                <button className="ghost" disabled={busy === 'backup'} onClick={backup}>
                  立即备份整个库
                </button>
                <span className="muted small">
                  逻辑备份（整库导出 gzip JSON，落在 storage/backups/），恢复用 scripts/restore.mjs
                </span>
              </div>
              <div className="muted small">
                已保留 {backups.files.length} / {backups.keep} 份，共 {formatBytes(backups.bytes)}
                ；超出份数会自动删最旧的。
              </div>
              {backups.files.length > 0 ? (
                <ul className="backup-list">
                  {backups.files.slice(0, 5).map((file) => (
                    <li key={file.name}>
                      <span className="mono small">{file.name}</span>
                      <span className="muted small">
                        {formatBytes(file.bytes)} · {formatTime(file.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <div className="muted">加载中…</div>
          )}
        </section>
      ) : null}

      {tab === 'plugins' ? (
        <section>
          <div className="actions">
            <input
              ref={fileInput}
              type="file"
              accept=".zip"
              className="hidden-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) upload(file);
              }}
            />
            <button
              className="primary"
              disabled={busy === 'upload'}
              onClick={() => fileInput.current?.click()}
            >
              {busy === 'upload' ? '上传中…' : '上传插件包（.zip）'}
            </button>
            <button className="ghost" disabled={busy === 'republish'} onClick={republish}>
              重新扫描 games/
            </button>
            <button className="ghost" disabled={busy === 'gc'} onClick={gc}>
              回收闲置 worker
            </button>
          </div>

          <table className="stats-table admin-table">
            <thead>
              <tr>
                <th>游戏</th>
                <th>版本</th>
                <th>状态</th>
                <th>内存</th>
                <th>构建时间</th>
                <th>hash</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={`${version.gameId}@${version.version}`}>
                  <td>
                    {version.name}
                    <div className="muted small">{version.gameId}</div>
                  </td>
                  <td>{version.version}</td>
                  <td>
                    <span className={`badge ${version.status}`}>{STATUS_LABEL[version.status]}</span>
                    {version.error ? <div className="muted small">{version.error}</div> : null}
                  </td>
                  <td className="muted small">{version.loaded ? '已加载' : '—'}</td>
                  <td className="muted small">{formatTime(version.createdAt)}</td>
                  <td className="muted small mono">{version.hash.slice(0, 8)}</td>
                  <td>
                    {version.status === 'active' ? (
                      <button
                        className="ghost small"
                        disabled={busy === `disable:${version.gameId}@${version.version}`}
                        onClick={() => disable(version)}
                      >
                        禁用
                      </button>
                    ) : (
                      <button
                        className="ghost small"
                        disabled={busy === `activate:${version.gameId}@${version.version}`}
                        onClick={() => activate(version)}
                      >
                        {version.status === 'disabled' ? '启用' : '激活'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {versions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    还没有任何插件版本
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <p className="muted small">
            上传 → 校验 manifest → 构建 → 用同一个种子跑两遍比对哈希 → 原子改名进 storage/plugins → 激活。
            任何一步失败都不会动线上正在跑的版本。
          </p>
        </section>
      ) : null}

      {tab === 'users' ? (
        <section>
          <table className="stats-table admin-table">
            <thead>
              <tr>
                <th>昵称</th>
                <th>权限</th>
                <th>注册时间</th>
                <th>最后登录</th>
                <th>局数</th>
                <th>密码</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.id === session.user.id ? 'me' : ''}>
                  <td>
                    {user.name}
                    {user.id === session.user.id ? <span className="muted small">（我）</span> : null}
                  </td>
                  <td>{user.isAdmin ? <span className="badge active">管理员</span> : '玩家'}</td>
                  <td className="muted small">{formatTime(user.createdAt)}</td>
                  <td className="muted small">{formatTime(user.lastLoginAt)}</td>
                  <td>{user.games}</td>
                  <td className="muted small">{user.hasPassword ? '已设置' : '未设置'}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="ghost small"
                        disabled={busy === `admin:${user.id}`}
                        onClick={() => toggleAdmin(user)}
                      >
                        {user.isAdmin ? '取消管理员' : '设为管理员'}
                      </button>
                      <button
                        className="ghost small"
                        disabled={busy === `reset:${user.id}`}
                        onClick={() => resetPassword(user)}
                      >
                        重置密码
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    还没有用户
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="muted small">
            重置密码会让对方所有设备立刻掉线；生成的口令只在这里显示一次，之后无法再查看。
          </p>
        </section>
      ) : null}
    </div>
  );
}
