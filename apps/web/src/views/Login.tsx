import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, type Session } from '../api';

type Mode = 'login' | 'register' | 'claim';

const HINT: Record<Mode, string> = {
  login: '用昵称和密码登录。',
  register: '第一次来就注册一个。密码至少 8 位，平台不发邮件，忘了只能找管理员重置。',
  claim: '这个账号是旧版「输昵称就能进」时期创建的，还没有密码。现在设一个，原来的战绩和评分都还在。',
};

const TITLE: Record<Mode, string> = {
  login: '登录',
  register: '注册',
  claim: '设置密码',
};

export function Login({
  onLogin,
  notice,
}: {
  onLogin: (session: Session) => void;
  notice?: string | null;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<{ registration: 'open' | 'code'; allowClaim: boolean }>({
    registration: 'open',
    allowClaim: true,
  });

  useEffect(() => {
    api
      .authConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  const trimmed = name.trim();
  const needPassword = mode === 'login' ? 1 : 8;
  const ready =
    !busy &&
    trimmed.length >= 2 &&
    password.length >= needPassword &&
    (mode !== 'register' || password === confirm) &&
    (mode !== 'register' || config.registration === 'open' || code.trim().length > 0);

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setPassword('');
    setConfirm('');
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;

    setBusy(true);
    setError(null);
    try {
      const session =
        mode === 'register'
          ? await api.register({
              name: trimmed,
              password,
              confirm,
              ...(config.registration === 'code' ? { code: code.trim() } : {}),
              remember,
            })
          : mode === 'claim'
            ? await api.claim({ name: trimmed, password, remember })
            : await api.login({ name: trimmed, password, remember });

      onLogin({ token: session.token, user: session.user });
    } catch (err) {
      // 老账号第一次登录：直接切到"设置密码"，别让用户自己猜该点哪
      if (err instanceof ApiError && err.code === 'password_not_set') {
        setMode('claim');
        setError(null);
        return;
      }
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>桌游平台</h1>

        {mode === 'claim' ? null : (
          <div className="login-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'active' : ''}
              onClick={() => switchMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'active' : ''}
              onClick={() => switchMode('register')}
            >
              注册
            </button>
          </div>
        )}

        <p className="muted small">{HINT[mode]}</p>
        {notice ? <div className="notice">{notice}</div> : null}

        <label className="field">
          <span>昵称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="2–20 个字符"
            maxLength={20}
            autoComplete="username"
            autoFocus
            disabled={mode === 'claim'}
          />
        </label>

        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={mode === 'login' ? '' : '至少 8 位'}
            maxLength={128}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>

        {mode === 'register' ? (
          <label className="field">
            <span>确认密码</span>
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
        ) : null}

        {mode === 'register' && config.registration === 'code' ? (
          <label className="field">
            <span>邀请码</span>
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="向管理员要" />
          </label>
        ) : null}

        {mode === 'login' ? (
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>记住我（30 天）</span>
          </label>
        ) : null}

        {mode === 'register' && confirm.length > 0 && confirm !== password ? (
          <div className="error">两次输入的密码不一样</div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}

        <button type="submit" className="primary" disabled={!ready}>
          {busy ? '处理中…' : TITLE[mode]}
        </button>

        {mode === 'claim' ? (
          <button type="button" className="ghost" onClick={() => switchMode('login')}>
            换个账号
          </button>
        ) : null}
      </form>
    </div>
  );
}
