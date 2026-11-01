import { useState, type FormEvent } from 'react';
import { ApiError, api, type Session } from '../api';
import { PasswordField } from '../PasswordField';

type Mode = 'login' | 'register' | 'claim';

const HINT: Record<Mode, string> = {
  login: '用账户名和密码登录。账户名是注册时定的，改不了；界面上显示的是昵称。',
  register:
    '第一次来就注册一个。账户名用来登录，全局唯一；昵称是别人看到的名字，可以随便改、可以重名。密码至少 8 位，平台不发邮件，忘了只能找管理员重置。',
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
  const [account, setAccount] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = account.trim();
  const needPassword = mode === 'login' ? 1 : 8;
  const ready =
    !busy &&
    trimmed.length >= 2 &&
    password.length >= needPassword &&
    (mode !== 'register' || password === confirm);

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
              account: trimmed,
              ...(nickname.trim() ? { name: nickname.trim() } : {}),
              password,
              confirm,
              ...(code.trim() ? { code: code.trim().toUpperCase() } : {}),
              remember,
            })
          : mode === 'claim'
            ? await api.claim({ account: trimmed, password, remember })
            : await api.login({ account: trimmed, password, remember });

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
          <span>账户名</span>
          <input
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            placeholder={mode === 'register' ? '2–20 个字符，不能有空格' : '注册时定的账户名'}
            maxLength={20}
            autoComplete="username"
            autoFocus
          />
        </label>

        {mode === 'register' ? (
          <label className="field">
            <span>昵称（选填）</span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="别人看到的名字，不填就用账户名"
              maxLength={20}
            />
          </label>
        ) : null}

        <PasswordField
          label="密码"
          value={password}
          onChange={setPassword}
          placeholder={mode === 'login' ? '' : '至少 8 位'}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />

        {mode === 'register' ? (
          <PasswordField
            label="确认密码"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
        ) : null}

        {mode === 'register' ? (
          <label className="field">
            <span>邀请码（选填）</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="朋友给你的 8 位码，没有就留空"
              maxLength={8}
            />
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
