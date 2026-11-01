import { useEffect, useState } from 'react';
import type { SocialOverview } from '@platform/sdk';
import { api } from '../api';

/**
 * 个人中心里的社交面板：分组、关注、粉丝、黑名单。
 *
 * 关注是单向的，所以「关注」和「粉丝」两张表分开显示；
 * 特别关注只是给列表排序 + 提醒加权，不改变关系本身。
 */
export function SocialPanel({
  onOpenProfile,
  onMessage,
}: {
  onOpenProfile: (userId: string) => void;
  onMessage: (userId: string) => void;
}) {
  const [data, setData] = useState<SocialOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const [tab, setTab] = useState<'following' | 'followers' | 'blocked'>('following');

  const reload = async (): Promise<void> => {
    try {
      setData(await api.socialOverview());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    try {
      await action();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const createGroup = async (): Promise<void> => {
    const name = newGroup.trim();
    if (!name) return;
    await run('group:new', async () => {
      await api.createGroup(name);
      setNewGroup('');
    });
  };

  const renameGroup = async (id: string, current: string): Promise<void> => {
    const name = window.prompt('分组改名', current)?.trim();
    if (!name || name === current) return;
    await run(`group:${id}`, () => api.renameGroup(id, name));
  };

  const removeGroup = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`删掉分组「${name}」？组里的人会回到默认分组，关注关系不会丢。`)) return;
    await run(`group:${id}`, () => api.deleteGroup(id));
  };

  const groupName = (id: string | null): string =>
    data?.groups.find((group) => group.id === id)?.name ?? '默认分组';

  const counts = (groupId: string): number =>
    data?.following.filter((person) => person.groupId === groupId).length ?? 0;

  return (
    <>
      <section>
        <h2>关注分组</h2>
        <div className="group-bar">
          {data?.groups.map((group) => (
            <span key={group.id} className="group-chip">
              {group.name}
              <span className="muted small">{counts(group.id)}</span>
              <button
                className="link small"
                disabled={busy === `group:${group.id}`}
                onClick={() => void renameGroup(group.id, group.name)}
              >
                改名
              </button>
              <button
                className="link small"
                disabled={busy === `group:${group.id}`}
                onClick={() => void removeGroup(group.id, group.name)}
              >
                删
              </button>
            </span>
          ))}
        </div>
        <div className="group-new">
          <input
            value={newGroup}
            onChange={(event) => setNewGroup(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createGroup();
            }}
            placeholder="新分组名，比如「牌搭子」"
            maxLength={12}
            aria-label="新分组名"
          />
          <button className="ghost" disabled={!newGroup.trim() || busy === 'group:new'} onClick={() => void createGroup()}>
            新建分组
          </button>
        </div>
      </section>

      <section>
        <div className="admin-tabs">
          <button className={tab === 'following' ? 'active' : ''} onClick={() => setTab('following')}>
            我的关注{data ? `（${data.following.length}）` : ''}
          </button>
          <button className={tab === 'followers' ? 'active' : ''} onClick={() => setTab('followers')}>
            粉丝{data ? `（${data.followers.length}）` : ''}
          </button>
          <button className={tab === 'blocked' ? 'active' : ''} onClick={() => setTab('blocked')}>
            黑名单{data ? `（${data.blocked.length}）` : ''}
          </button>
        </div>

        {error ? <div className="error">{error}</div> : null}

        {tab === 'following' ? (
          data && data.following.length > 0 ? (
            <ul className="people-list">
              {data.following.map((person) => (
                <li key={person.id} className="person-row">
                  <button className="link person-name" onClick={() => onOpenProfile(person.id)}>
                    {person.name}
                  </button>
                  <span className={person.special ? 'badge active' : 'badge'}>
                    {person.special ? '★ 特别关注' : groupName(person.groupId)}
                  </span>
                  <select
                    value={person.groupId ?? ''}
                    onChange={(event) =>
                      void run(`follow:${person.id}`, () =>
                        api.updateFollow(person.id, { groupId: event.target.value }),
                      )
                    }
                  >
                    {data.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="ghost small"
                    disabled={busy === `follow:${person.id}`}
                    onClick={() =>
                      void run(`follow:${person.id}`, () =>
                        api.updateFollow(person.id, { special: !person.special }),
                      )
                    }
                  >
                    {person.special ? '取消特别关注' : '设为特别关注'}
                  </button>
                  <button className="ghost small" onClick={() => onMessage(person.id)}>
                    私聊
                  </button>
                  <button
                    className="ghost small"
                    disabled={busy === `follow:${person.id}`}
                    onClick={() => void run(`follow:${person.id}`, () => api.unfollowUser(person.id))}
                  >
                    取消关注
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">还没有关注任何人。去牌桌上点名字，或者搜一下。</p>
          )
        ) : null}

        {tab === 'followers' ? (
          data && data.followers.length > 0 ? (
            <ul className="people-list">
              {data.followers.map((person) => (
                <li key={person.id} className="person-row">
                  <button className="link person-name" onClick={() => onOpenProfile(person.id)}>
                    {person.name}
                  </button>
                  <span className="spacer" />
                  <button className="ghost small" onClick={() => onMessage(person.id)}>
                    私聊
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">还没有粉丝。</p>
          )
        ) : null}

        {tab === 'blocked' ? (
          data && data.blocked.length > 0 ? (
            <ul className="people-list">
              {data.blocked.map((person) => (
                <li key={person.id} className="person-row">
                  <button className="link person-name" onClick={() => onOpenProfile(person.id)}>
                    {person.name}
                  </button>
                  <span className="spacer" />
                  <button
                    className="ghost small"
                    disabled={busy === `block:${person.id}`}
                    onClick={() => void run(`block:${person.id}`, () => api.unblockUser(person.id))}
                  >
                    取消拉黑
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">黑名单是空的。</p>
          )
        ) : null}
      </section>
    </>
  );
}
