/**
 * 社交 / 身份层：账户 + 昵称、关注分组、私聊、提醒、订阅、成就、排行榜隐藏。
 *
 * 这几块都落在 SQL 上（唯一索引、LATERAL 聚合、级联），单测纯函数没意义，
 * 所以这里起一个真的 PGlite 跑迁移，再拿 PgStore 走一遍。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createDb, migrate } from '../apps/server/src/db/index.ts';
import { PgStore, displayName } from '../apps/server/src/store.ts';

/* ------------------------------ 准备 ------------------------------ */

const dir = await mkdtemp(path.join(tmpdir(), 'social-db-'));
const db = await createDb({ dataDir: dir });
await migrate(db);
const store = new PgStore(db);

after(async () => {
  await (db as { close?: () => Promise<void> }).close?.();
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------ 身份 ------------------------------ */

test('账户全局唯一，昵称可以重复', async () => {
  const a = await store.createUser('zhangsan', '张三', 'hash-a');
  const dup = await store.createUser('zhangsan', '另一个张三', 'hash-b');
  const b = await store.createUser('lisi', '张三', 'hash-c');

  assert.ok(a && b);
  assert.equal(dup, null, '同一个账户名不能再注册');

  assert.equal(a.account, 'zhangsan');
  assert.equal(a.name, '张三');
  assert.equal(displayName(a), '张三', '展示的就是昵称，不带编号');

  // 两个人昵称一样，账户不同
  const same = await store.searchUsers('张三', 10);
  assert.equal(same.filter((row) => row.name === '张三').length, 2, '同名两个人都在');

  const byAccount = await store.findUserWithSecretByAccount('zhangsan');
  assert.equal(byAccount?.id, a.id);
  assert.equal(byAccount?.passwordHash, 'hash-a');
  assert.equal(await store.findUserWithSecretByAccount('nobody'), undefined);
});

test('改昵称 / 头像 / 签名，账户不动', async () => {
  const user = await store.createUser('profile_owner', '旧昵称', 'hash');
  assert.ok(user);

  const updated = await store.updateProfile(user.id, {
    name: '新昵称',
    signature: '只玩合作游戏',
    avatar: 'preset:fox',
  });
  assert.equal(updated?.name, '新昵称');
  assert.equal(updated?.signature, '只玩合作游戏');
  assert.equal(updated?.avatar, 'preset:fox');
  assert.equal(updated?.account, 'profile_owner', '账户不跟着改');

  // 昵称重复也没关系
  const other = await store.createUser('dup_name_owner', '新昵称', 'hash');
  assert.ok(other);
});

test('检索人：账户精确/前缀、昵称片段都能查', async () => {
  const user = await store.createUser('wangxiaoming', '王小明', 'hash');
  assert.ok(user);

  const byName = await store.searchUsers('小明', 10);
  assert.ok(byName.some((row) => row.id === user.id), '按昵称片段能查到');

  const byAccount = await store.searchUsers('wangxiao', 10);
  assert.ok(byAccount.some((row) => row.id === user.id), '按账户前缀能查到');

  const exact = await store.searchUsers('wangxiaoming', 10);
  assert.equal(exact[0]?.id, user.id, '账户精确匹配排第一');
});

/* ------------------------------ 关注 ------------------------------ */

test('关注有分组、能标特别关注，粉丝数跟着动', async () => {
  const me = await store.createUser('acct1', '我', 'h');
  const other = await store.createUser('acct2', '他', 'h');
  assert.ok(me && other);

  const groups = await store.listFollowGroups(me.id);
  assert.equal(groups.length, 1, '第一次用自动建一个默认分组');
  assert.equal(groups[0]!.name, '默认分组');

  const row = await store.follow(me.id, other.id, null, false);
  assert.equal(row.groupId, groups[0]!.id, '没指定分组就进默认组');

  const special = await store.updateFollow(me.id, other.id, { special: true });
  assert.equal(special?.special, true);

  const hobby = await store.createFollowGroup(me.id, '牌搭子');
  await store.updateFollow(me.id, other.id, { groupId: hobby.id });

  const following = await store.listFollowing(me.id);
  assert.equal(following.length, 1);
  assert.equal(following[0]!.groupId, hobby.id);

  const counts = await store.countFollows(other.id);
  assert.equal(counts.followers, 1, '对方多了一个粉丝');
  assert.equal((await store.countFollows(me.id)).following, 1);
});

test('删分组不会删关注：人回到默认分组', async () => {
  const me = await store.createUser('acct3', '我2', 'h');
  const other = await store.createUser('acct4', '他2', 'h');
  assert.ok(me && other);

  const [defaults] = [await store.listFollowGroups(me.id)];
  const custom = await store.createFollowGroup(me.id, '临时的');
  await store.follow(me.id, other.id, custom.id, false);

  assert.equal(await store.deleteFollowGroup(me.id, custom.id), true);

  const row = await store.getFollow(me.id, other.id);
  assert.equal(row?.groupId, defaults[0]!.id, '关注还在，只是回默认组');
  assert.equal(await store.isFollowing(me.id, other.id), true);

  assert.equal(
    await store.deleteFollowGroup(me.id, defaults[0]!.id),
    false,
    '默认分组不能删',
  );
});

/* ------------------------------ 拉黑 ------------------------------ */

test('拉黑是双向可查的', async () => {
  const a = await store.createUser('acct5', '黑A', 'h');
  const b = await store.createUser('acct6', '黑B', 'h');
  assert.ok(a && b);

  assert.equal(await store.hasBlockBetween(a.id, b.id), false);
  await store.block(a.id, b.id);

  assert.equal(await store.hasBlockBetween(a.id, b.id), true);
  assert.deepEqual(await store.blockInfo(a.id, b.id), { iBlocked: true, blockedMe: false });
  assert.deepEqual(await store.blockInfo(b.id, a.id), { iBlocked: false, blockedMe: true });

  await store.unblock(a.id, b.id);
  assert.equal(await store.hasBlockBetween(a.id, b.id), false);
});

/* ------------------------------ 私聊 ------------------------------ */

test('私聊：未读、已读、会话列表都对得上', async () => {
  const alice = await store.createUser('acct7', '爱丽丝', 'h');
  const bob = await store.createUser('acct8', '鲍勃', 'h');
  assert.ok(alice && bob);

  await store.saveDirectMessage(alice.id, bob.id, '在吗', 1000);
  await store.saveDirectMessage(alice.id, bob.id, '开一桌？', 2000);

  assert.equal(await store.countUnreadMessages(bob.id), 2, '收件人两条未读');
  assert.equal(await store.countUnreadMessages(alice.id), 0, '自己发的不算未读');

  const threads = await store.listDirectThreads(bob.id);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.user.id, alice.id);
  assert.equal(threads[0]!.unread, 2);
  assert.equal(threads[0]!.last?.body, '开一桌？', '最后一条是最新的');

  await store.markThreadRead(bob.id, alice.id);
  assert.equal(await store.countUnreadMessages(bob.id), 0);
  assert.equal(await store.unreadFrom(bob.id, alice.id), 0);

  const conversation = await store.listDirectMessages(alice.id, bob.id, 50);
  assert.deepEqual(
    conversation.map((message) => message.body),
    ['在吗', '开一桌？'],
    '按时间正序',
  );
});

test('新粉丝计数只看「上次看过消息」之后', async () => {
  const star = await store.createUser('acct9', '小星', 'h');
  const fan = await store.createUser('acct10', '粉丝', 'h');
  assert.ok(star && fan);

  const before = star.socialSeenAt;
  await store.follow(fan.id, star.id, null, true);
  assert.equal(await store.countNewFollowers(star.id, before), 1);

  await store.markSocialSeen(star.id);
  const updated = await store.getUser(star.id);
  assert.ok(updated);
  assert.ok(updated.socialSeenAt > before);
  assert.equal(await store.countNewFollowers(star.id, updated.socialSeenAt), 0, '看过就清零');
});

/* ------------------------------ 排行榜隐藏 ------------------------------ */

test('隐藏某人：榜上不再出现，放回来就回来', async () => {
  const p1 = await store.createUser('acct11', '榜一', 'h');
  const p2 = await store.createUser('acct12', '榜二', 'h');
  assert.ok(p1 && p2);

  const gameId = 'demo-game';
  await store.applyRatingDeltas(
    gameId,
    [
      { userId: p1.id, rating: 1600, games: 3 },
      { userId: p2.id, rating: 1500, games: 3 },
    ],
    Date.now(),
  );

  let board = await store.listRatings(gameId, 10);
  assert.equal(board.length, 2);
  assert.equal(board[0]!.name, p1.name, '榜上显示昵称');

  assert.equal(await store.setRatingHidden(gameId, p1.id, true, p2.id), true);

  board = await store.listRatings(gameId, 10);
  assert.deepEqual(
    board.map((row) => row.userId),
    [p2.id],
    '被隐藏的人整行不出现，名次自然顺延',
  );

  const adminRows = await store.listAdminRatings(gameId, 10);
  assert.equal(adminRows.length, 2, '管理端还看得到被隐藏的那行');
  assert.equal(adminRows.find((row) => row.userId === p1.id)?.hidden, true);

  await store.setRatingHidden(gameId, p1.id, false, p2.id);
  board = await store.listRatings(gameId, 10);
  assert.equal(board.length, 2, '放回来就重新出现');
});

/* ------------------------------ 提醒 ------------------------------ */

test('提醒：未读计数、倒序列表、一次清空', async () => {
  const me = await store.createUser('acct13', '提醒测试', 'h');
  assert.ok(me);

  await store.addNotification(me.id, { kind: 'mention', title: 'A @ 了你', link: '#/table/x' });
  await store.addNotification(me.id, { kind: 'achievement', title: '解锁成就', body: '首胜' });

  assert.equal(await store.countUnreadNotifications(me.id), 2);

  const list = await store.listNotifications(me.id, 10);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.title, '解锁成就', '新的在前');
  assert.equal(list[0]!.readAt, null);

  assert.equal(await store.markNotificationsRead(me.id), 2);
  assert.equal(await store.countUnreadNotifications(me.id), 0);
  assert.equal(await store.markNotificationsRead(me.id), 0, '重复调用不会重复标记');
});

/* ------------------------------ 订阅 ------------------------------ */

test('订阅：同一个目标只会有一条，取消就没了', async () => {
  const me = await store.createUser('acct14', '订阅测试', 'h');
  const other = await store.createUser('acct15', '被订阅的人', 'h');
  assert.ok(me && other);

  await store.addSubscription(me.id, 'game', 'dice');
  await store.addSubscription(me.id, 'game', 'dice');
  await store.addSubscription(me.id, 'user', other.id);

  const list = await store.listSubscriptions(me.id);
  assert.equal(list.length, 2, '重复订阅不会多出一条');

  assert.deepEqual(await store.subscribersOf('game', 'dice'), [me.id]);
  assert.deepEqual(await store.subscribersOf('user', other.id), [me.id]);

  await store.removeSubscription(me.id, 'game', 'dice');
  assert.equal((await store.listSubscriptions(me.id)).length, 1);
  assert.deepEqual(await store.subscribersOf('game', 'dice'), []);
});

/* ------------------------------ 成就 ------------------------------ */

test('成就：同一人同一成就只记一次，列表按时间倒序', async () => {
  const me = await store.createUser('acct16', '成就测试', 'h');
  assert.ok(me);

  assert.equal(await store.unlockAchievement(me.id, 'dice', 'first-win', 't1', 1000), true);
  assert.equal(
    await store.unlockAchievement(me.id, 'dice', 'first-win', 't2', 2000),
    false,
    '第二次解锁不重复记',
  );
  assert.equal(await store.unlockAchievement(me.id, 'mandala', 'big-harvest', null, 1500), true);

  const list = await store.listAchievements(me.id);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.gameId, 'mandala', '按解锁时间倒序：1500 比 1000 晚');
  assert.equal(list[1]!.gameId, 'dice');
  assert.equal(list[1]!.at, 1000, '重复解锁时保留第一次的时间');
});

/* ------------------------------ 最近一起玩过 ------------------------------ */

test('最近一起玩过：按同桌时间倒序，机器人不算人', async () => {
  const me = await store.createUser('acct17', '我', 'h');
  const friend = await store.createUser('acct18', '牌友', 'h');
  assert.ok(me && friend);

  const base = {
    gameId: 'dice',
    gameVersion: '0.1.0',
    hostId: me.id,
    status: 'finished' as const,
    maxPlayers: 4,
    options: {},
    state: null,
    seq: 1,
    log: [],
    deadlineAt: null,
    mode: 'realtime' as const,
    pace: 'normal',
    turnMs: 20000,
    windowStart: null,
    windowEnd: null,
    timeoutStreak: 0,
    friendly: false,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 1,
    result: null,
  };

  await store.createTable({
    ...base,
    id: 'table-recent-1',
    code: 'AAAAAA',
    players: [
      { id: me.id, name: me.name, seat: 0, bot: false },
      { id: friend.id, name: friend.name, seat: 1, bot: false },
      { id: 'bot-1', name: '机器人 2', seat: 2, bot: true },
    ],
    finishedAt: 1000,
  });
  await store.createTable({
    ...base,
    id: 'table-recent-2',
    code: 'BBBBBB',
    players: [
      { id: me.id, name: me.name, seat: 0, bot: false },
      { id: friend.id, name: friend.name, seat: 1, bot: false },
    ],
    finishedAt: 2000,
  });

  const recent = await store.recentPlayers(me.id, 10);
  assert.equal(recent.length, 1, '只有真人牌友，机器人不算');
  assert.equal(recent[0]!.id, friend.id);
  assert.equal(recent[0]!.games, 2, '两局都算上');
  assert.equal(recent[0]!.at, 2000, '时间是最近那一局');
});
