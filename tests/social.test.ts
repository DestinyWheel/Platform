/**
 * 社交 / 身份层：昵称可重复 + #编号、关注分组、私聊、排行榜隐藏。
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
import { splitLoginName } from '../apps/server/src/app.ts';
import { PgStore, displayName, randomTag } from '../apps/server/src/store.ts';

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

test('#编号 是 4–6 位数字，不重复', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const tag = randomTag(4);
    assert.match(tag, /^[1-9]\d{3}$/, '4 位、不带前导零');
    seen.add(tag);
  }
  // 200 次里撞几个很正常，但整体应该接近 9000 的容量，不会挤在一起
  assert.ok(seen.size > 190, `200 次只生成了 ${seen.size} 个不同编号`);

  assert.equal(randomTag(6).length, 6);
});

test('昵称可以重复，靠 #编号 区分，登录名两种写法都认', async () => {
  const a = await store.createUser('张三', 'hash-a');
  const b = await store.createUser('张三', 'hash-b');
  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.tag, b.tag, '同名的人编号必须不同');

  assert.equal(displayName(a), `张三#${a.tag}`);

  const same = await store.findUsersByName('张三');
  assert.equal(same.length, 2, '同名两个人都在');

  const byTag = await store.findUserWithSecret('张三', a.tag);
  assert.equal(byTag?.id, a.id, '带编号就能精确找到人');
  assert.equal(byTag?.passwordHash, 'hash-a');

  assert.deepEqual(splitLoginName('张三'), { name: '张三' });
  assert.deepEqual(splitLoginName('张三#4821'), { name: '张三', tag: '4821' });
  // 昵称里本来就可能带 #，没有 4–6 位数字就不切
  assert.deepEqual(splitLoginName('#1 粉丝'), { name: '#1 粉丝' });
  assert.deepEqual(splitLoginName(' 李四#123456 '), { name: '李四', tag: '123456' });
});

test('检索人：昵称片段和编号都能查', async () => {
  const user = await store.createUser('王小明', 'hash');
  assert.ok(user);

  const hits = await store.searchUsers('小明', 10);
  assert.ok(hits.some((row) => row.id === user.id), '按昵称片段能查到');

  const byFull = await store.searchUsers(`王小明#${user.tag}`, 10);
  assert.ok(byFull.some((row) => row.id === user.id), '整串 名字#编号 也能查');

  // 只写 #编号 时不能退化成"匹配所有人"（空串在 SQL 里 position = 1）
  const byTagOnly = await store.searchUsers(`#${user.tag}`, 10);
  assert.deepEqual(
    byTagOnly.map((row) => row.id),
    [user.id],
    '只写 #编号 只能查到这一个人',
  );
});

/* ------------------------------ 关注 ------------------------------ */

test('关注有分组、能标特别关注，粉丝数跟着动', async () => {
  const me = await store.createUser('我', 'h');
  const other = await store.createUser('他', 'h');
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
  const me = await store.createUser('我2', 'h');
  const other = await store.createUser('他2', 'h');
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
  const a = await store.createUser('黑A', 'h');
  const b = await store.createUser('黑B', 'h');
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
  const alice = await store.createUser('爱丽丝', 'h');
  const bob = await store.createUser('鲍勃', 'h');
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
  const star = await store.createUser('小星', 'h');
  const fan = await store.createUser('粉丝', 'h');
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
  const p1 = await store.createUser('榜一', 'h');
  const p2 = await store.createUser('榜二', 'h');
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
  assert.equal(board[0]!.name, displayName(p1), '榜上显示带编号的名字');

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
