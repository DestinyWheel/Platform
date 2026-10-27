import { useState, type FormEvent } from 'react';
import { api, type Session } from '../api';

export function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(name.trim());
      onLogin({ token: result.token, user: result.user });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>桌游平台</h1>
        <p className="muted">输入昵称进入。同一昵称再次登录会回到原来的身份。</p>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="昵称"
          maxLength={20}
          autoFocus
        />
        {error ? <div className="error">{error}</div> : null}
        <button type="submit" className="primary" disabled={busy || name.trim().length < 2}>
          {busy ? '进入中…' : '进入'}
        </button>
      </form>
    </div>
  );
}
