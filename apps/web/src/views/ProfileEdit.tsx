import { useState } from 'react';
import { AVATAR_PRESETS } from '@platform/sdk';
import { api, type Session } from '../api';
import { Avatar } from '../Avatar';

/**
 * 资料编辑：头像、昵称、签名。
 *
 * 账户名是登录凭据，不在这里——注册后就不能改了。
 */
export function ProfileEdit({
  session,
  onSession,
}: {
  session: Session;
  onSession: (next: Session) => void;
}) {
  const [name, setName] = useState(session.user.name);
  const [signature, setSignature] = useState('');
  const [avatar, setAvatar] = useState<string | null>(session.user.avatar);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { user } = await api.updateProfile({
        name: name.trim(),
        signature: signature.trim() ? signature.trim() : null,
        avatar,
      });
      onSession({ ...session, user });
      setNotice('保存好了');
      window.setTimeout(() => setNotice(null), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>我的资料</h2>

      <div className="profile-edit">
        <Avatar user={{ id: session.user.id, avatar }} size={64} />

        <div className="avatar-picker">
          {AVATAR_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`avatar-option ${avatar === `preset:${preset.id}` ? 'active' : ''}`}
              title={preset.id}
              style={{ background: preset.bg }}
              onClick={() => setAvatar(`preset:${preset.id}`)}
            >
              {preset.glyph}
            </button>
          ))}
        </div>
      </div>

      <div className="form-stack">
        <label className="field">
          <span>昵称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={20}
            placeholder="别人看到的名字，可以重名"
          />
        </label>

        <label className="field">
          <span>一句话签名（选填）</span>
          <input
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
            maxLength={60}
            placeholder="比如：只玩合作游戏"
          />
        </label>

        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="notice">{notice}</div> : null}

        <button className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? '保存中…' : '保存资料'}
        </button>
      </div>
    </section>
  );
}
