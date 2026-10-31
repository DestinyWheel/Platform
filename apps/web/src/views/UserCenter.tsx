import { useEffect, useState } from 'react';
import { api, type Session } from '../api';
import { formatTime } from '../format';
import { ChangePassword } from './ChangePassword';

interface InviteInfo {
  code: string | null;
  createdAt: number | null;
  invited: { id: string; name: string; createdAt: number }[];
}

/**
 * 个人中心：账号信息、我的邀请码、我拉进来的人。
 *
 * 邀请码是"只能生成一次"的：注册时系统已经发了一个，所以新用户打开就是只读；
 * 只有这个功能上线之前注册的老账号是 null，才会看到「生成」按钮。
 */
export function UserCenter({
  session,
  onSession,
  onExit,
}: {
  session: Session;
  onSession: (next: Session) => void;
  onExit: () => void;
}) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .myInvite()
      .then((data) => {
        if (!cancelled) setInvite(data);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { code } = await api.generateInvite();
      setInvite((current) => ({
        code,
        createdAt: Date.now(),
        invited: current?.invited ?? [],
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!invite?.code) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('复制失败，手动选中那串字符吧');
    }
  };

  return (
    <div className="lobby user-center">
      <header className="topbar">
        <div className="title">个人中心</div>
        <div className="spacer" />
        <span className="muted">{session.user.name}</span>
        <button className="ghost" onClick={onExit}>
          回大厅
        </button>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section>
        <h2>账号</h2>
        <dl className="facts">
          <dt>昵称</dt>
          <dd>{session.user.name}</dd>
          <dt>身份</dt>
          <dd>{session.user.isAdmin ? '管理员' : '成员'}</dd>
        </dl>
        <button className="ghost" onClick={() => setChangingPassword(true)}>
          改密码
        </button>
      </section>

      <section>
        <h2>我的邀请码</h2>
        {invite?.code ? (
          <>
            <div className="invite-card">
              <code className="invite-code">{invite.code}</code>
              <button className="ghost" onClick={() => void copy()}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <p className="muted small">
              朋友注册时把这一串填进「邀请码」。这个码生成一次就固定了，不会变
              {invite.createdAt ? `（生成于 ${formatTime(invite.createdAt)}）` : ''}。
            </p>
          </>
        ) : invite ? (
          <>
            <p className="muted small">
              你还没有邀请码。生成之后它就固定下来，<strong>只能生成一次</strong>。
            </p>
            <button className="primary" disabled={busy} onClick={() => void generate()}>
              {busy ? '生成中…' : '生成我的邀请码'}
            </button>
          </>
        ) : (
          <p className="muted small">加载中…</p>
        )}
      </section>

      <section>
        <h2>我邀请的成员{invite ? `（${invite.invited.length}）` : ''}</h2>
        {invite && invite.invited.length > 0 ? (
          <ul className="table-list">
            {invite.invited.map((person) => (
              <li key={person.id} className="table-row">
                <div>
                  <div className="game-name">{person.name}</div>
                  <div className="muted small">加入于 {formatTime(person.createdAt)}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">还没有人用你的邀请码注册。</p>
        )}
      </section>

      {changingPassword ? (
        <ChangePassword
          onClose={() => setChangingPassword(false)}
          onChanged={(next) => {
            onSession(next);
            setChangingPassword(false);
          }}
        />
      ) : null}
    </div>
  );
}
