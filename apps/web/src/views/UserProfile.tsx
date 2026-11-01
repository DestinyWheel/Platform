import { useEffect, useState } from 'react';
import type { UserProfile as Profile } from '@platform/sdk';
import { api, type Session } from '../api';
import { Avatar } from '../Avatar';
import { formatTime } from '../format';

/**
 * 用户主页：战绩 + 关注 + 私聊 + 拉黑都在这一页。
 *
 * 昵称可以重复，所以标题永远显示 `名字#编号` —— 只看见名字的话容易认错人。
 */
export function UserProfile({
  userId,
  session,
  onBack,
  onMessage,
}: {
  userId: string;
  session: Session;
  onBack: () => void;
  onMessage: (userId: string) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const [{ profile: data }, social] = await Promise.all([
        api.userProfile(userId),
        api.socialOverview(),
      ]);
      setProfile(data);
      setGroups(social.groups);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const follow = async (): Promise<void> => {
    setBusy('follow');
    try {
      await api.followUser(userId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const unfollow = async (): Promise<void> => {
    setBusy('follow');
    try {
      await api.unfollowUser(userId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const patchFollow = async (patch: { groupId?: string | null; special?: boolean }): Promise<void> => {
    setBusy('follow');
    try {
      await api.updateFollow(userId, patch);
      await load();
      setNotice(patch.special === true ? '已设为特别关注' : patch.special === false ? '已取消特别关注' : '已换分组');
      window.setTimeout(() => setNotice(null), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleBlock = async (): Promise<void> => {
    if (!profile) return;
    setBusy('block');
    try {
      if (profile.blocked) await api.unblockUser(userId);
      else await api.blockUser(userId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lobby profile-page">
      <header className="topbar">
        <button className="ghost" onClick={onBack}>
          ← 返回
        </button>
        <div className="title">{profile?.name ?? '用户主页'}</div>
        <div className="spacer" />
        <span className="muted small">{session.user.name}</span>
      </header>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {!profile ? (
        <p className="muted">{error ? '' : '加载中…'}</p>
      ) : (
        <>
          <section className="profile-head">
            <div className="profile-id">
              <Avatar user={profile} size={64} />
              <div>
                <div className="profile-name">{profile.name}</div>
                <div className="muted small">
                  @{profile.account} · 加入于 {formatTime(profile.createdAt)}
                </div>
                {profile.signature ? (
                  <div className="profile-signature">{profile.signature}</div>
                ) : null}
                <div className="muted small">
                  关注 {profile.followingCount} · 粉丝 {profile.followerCount}
                </div>
              </div>
            </div>
            <div className="profile-actions">
              {profile.id === session.user.id ? (
                <span className="muted small">这是你自己</span>
              ) : (
                <>
                  <button
                    className={profile.following ? 'ghost' : 'primary'}
                    disabled={busy === 'follow'}
                    onClick={() => void (profile.following ? unfollow() : follow())}
                  >
                    {profile.following ? '取消关注' : '关注'}
                  </button>
                  <button
                    className={profile.followedBy ? 'ghost' : 'primary'}
                    disabled={busy === 'follow'}
                    onClick={() => void onMessage(profile.id)}
                  >
                    私聊
                  </button>
                </>
              )}
            </div>
          </section>

          {profile.id !== session.user.id && profile.following ? (
            <section>
              <h2>关注设置</h2>
              <div className="toolbar">
                <label className="follow-group">
                  <span className="muted small">分组</span>
                  <select
                    value={groups.find((group) => group.id === profile.groupId)?.id ?? ''}
                    onChange={(event) => void patchFollow({ groupId: event.target.value })}
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className={profile.special ? 'chip active' : 'chip'}
                  disabled={busy === 'follow'}
                  onClick={() => void patchFollow({ special: !profile.special })}
                >
                  {profile.special ? '★ 特别关注' : '☆ 设为特别关注'}
                </button>
              </div>
              <p className="muted small">
                特别关注的人排在你的关注列表最前面，消息提醒也不会被折叠。
              </p>
            </section>
          ) : null}

          <section>
            <h2>战绩</h2>
            {profile.stats.length === 0 ? (
              <p className="muted small">还没有打完的记录。</p>
            ) : (
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>游戏</th>
                    <th>场次</th>
                    <th>胜</th>
                    <th>胜率</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.stats.map((row) => (
                    <tr key={row.gameId}>
                      <td>{row.gameName}</td>
                      <td>{row.games}</td>
                      <td>{row.wins}</td>
                      <td>{row.games === 0 ? '—' : `${Math.round((row.wins / row.games) * 100)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2>成就{profile.achievements.length > 0 ? `（${profile.achievements.length}）` : ''}</h2>
            {profile.achievements.length === 0 ? (
              <p className="muted small">还没解锁任何成就。</p>
            ) : (
              <ul className="badge-list">
                {profile.achievements.map((item) => (
                  <li
                    key={`${item.gameId}:${item.def.id}`}
                    className="badge-card"
                    title={`${item.def.description}　（${item.gameName} · ${formatTime(item.at)}）`}
                  >
                    <span
                      className="badge-icon"
                      style={{ background: item.def.color ?? '#2b3441' }}
                    >
                      {item.def.icon}
                    </span>
                    <span>
                      <span className="badge-name">{item.def.name}</span>
                      <span className="muted small">　{item.gameName}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {profile.id !== session.user.id ? (
            <section>
              <h2>其他</h2>
              <div className="toolbar">
                <button className="ghost" disabled={busy === 'block'} onClick={() => void toggleBlock()}>
                  {profile.blocked ? '取消拉黑' : '拉黑'}
                </button>
              </div>
              <p className="muted small">
                拉黑之后双方都发不了私聊（对方也收不到你的消息）。
                {profile.blocksMe ? ' 对方已经把你拉黑了。' : ''}
              </p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
