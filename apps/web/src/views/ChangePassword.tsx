import { useState, type FormEvent } from 'react';
import { api, type Session } from '../api';
import { PasswordField } from '../PasswordField';

/** 改密码：会作废其它设备上的登录，并把新令牌交给调用方替换本地会话 */
export function ChangePassword({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: (session: Session) => void;
}) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    !busy &&
    oldPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirm &&
    newPassword !== oldPassword;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.changePassword({ oldPassword, newPassword });
      onChanged({ token: result.token, user: result.user });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <form className="dialog" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>修改密码</h2>
        <p className="muted small">改完其它设备会立刻退出登录。</p>

        <PasswordField
          label="原密码"
          value={oldPassword}
          onChange={setOldPassword}
          autoComplete="current-password"
          autoFocus
        />
        <PasswordField
          label="新密码"
          value={newPassword}
          onChange={setNewPassword}
          placeholder="至少 8 位"
          autoComplete="new-password"
        />
        <PasswordField
          label="再输一次"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />

        {error ? <div className="error">{error}</div> : null}

        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            {busy ? '提交中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
