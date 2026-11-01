/**
 * 用户维护：列出账号、删掉测试账号。
 *
 * 用法（在仓库根目录跑）：
 *   node --import tsx scripts/users.mjs list [--data-dir <目录>]
 *   node --import tsx scripts/users.mjs rm <账户|用户ID>... [--yes] [--purge-tables] [--data-dir <目录>]
 *
 * rm 默认只做预演（打印将要删除什么），加 --yes 才真的写库。
 * 删的是"人"和"跟这个人绑定的东西"：评分、战绩、关注/私聊/提醒/成就（后面这些靠外键级联）。
 * 默认保留牌桌和对局记录 —— 别人在那局里的战绩、聊天都还在，只是桌上那个位置显示的是当时的昵称。
 * 加 --purge-tables 才会连他开的桌、桌上的聊天和动作日志一起删干净。
 */
import { createDb, migrate } from '../apps/server/src/db/index.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'list';
const dataDirIndex = argv.indexOf('--data-dir');
const dataDir = dataDirIndex >= 0 ? argv[dataDirIndex + 1] : undefined;
const yes = argv.includes('--yes');
const purgeTables = argv.includes('--purge-tables');

const flagArgs = new Set(['--yes', '--purge-tables']);
const targets = argv
  .slice(1)
  .filter((arg, index, all) => {
    if (arg === '--data-dir') return false;
    if (index > 0 && all[index - 1] === '--data-dir') return false;
    return !flagArgs.has(arg) && !arg.startsWith('--');
  });

const when = (ms) => {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const db = await createDb({ dataDir });
await migrate(db);

if (command === 'list') {
  const rows = await db.query(
    `SELECT u.id, u.account, u.name, u.is_admin, u.created_at, u.last_login_at,
            u.password_set_at, u.invite_code, u.invited_by,
            (SELECT count(*)::int FROM ratings r WHERE r.user_id = u.id) AS ratings,
            (SELECT count(*)::int FROM match_results m WHERE m.user_id = u.id) AS matches,
            (SELECT count(*)::int FROM tables t WHERE t.host_id = u.id) AS tables,
            (SELECT count(*)::int FROM follows f WHERE f.followee_id = u.id) AS followers
       FROM users u
      ORDER BY u.created_at, u.id`,
  );
  console.log(`共 ${rows.length} 个用户：`);
  console.log(
    ['#', '账户', '昵称', '权限', '注册', '最后登录', '密码', '局数', '桌', '粉丝', 'ID'].join('\t'),
  );
  rows.forEach((row, i) => {
    console.log(
      [
        i + 1,
        row.account,
        row.name,
        row.is_admin ? '管理员' : '普通',
        when(row.created_at),
        when(row.last_login_at),
        row.password_set_at ? '有' : '无',
        row.matches,
        row.tables,
        row.followers,
        row.id,
      ].join('\t'),
    );
  });
  await db.close();
  process.exit(0);
}

if (command !== 'rm') {
  console.error(`不认识的命令：${command}（只有 list / rm）`);
  await db.close();
  process.exit(1);
}

if (targets.length === 0) {
  console.error('要删谁？把账户名或用户 ID 写在 rm 后面。');
  await db.close();
  process.exit(1);
}

/** 账户名、昵称、ID 都能认，但必须唯一命中 */
const resolve = async (needle) => {
  const rows = await db.query(
    `SELECT id, account, name, is_admin FROM users
      WHERE id = $1 OR lower(account) = lower($1) OR name = $1`,
    [needle],
  );
  if (rows.length === 0) {
    console.error(`找不到用户：${needle}`);
    process.exitCode = 2;
    return null;
  }
  if (rows.length > 1) {
    console.error(`「${needle}」对上了多个用户，请改用 ID：${rows.map((r) => r.id).join(', ')}`);
    process.exitCode = 2;
    return null;
  }
  return rows[0];
};

const users = [];
for (const needle of targets) {
  const found = await resolve(needle);
  if (!found) continue;
  users.push(found);
}

if (users.length === 0) {
  await db.close();
  process.exit(2);
}

const admins = await db.query('SELECT count(*)::int AS n FROM users WHERE is_admin');
let remainingAdmins = Number(admins[0].n);

const plan = [];
for (const user of users) {
  if (users.filter((u) => u.is_admin).length && user.is_admin && remainingAdmins - 1 < 1) {
    console.error(`拒绝删除「${user.account}」：这是最后一个管理员。`);
    continue;
  }
  if (user.is_admin) {
    remainingAdmins -= 1;
    console.error(`注意：「${user.account}」是管理员，删掉后他就不再能进后台。`);
  }

  const counts = await db.query(
    `SELECT
       (SELECT count(*)::int FROM ratings WHERE user_id = $1)          AS ratings,
       (SELECT count(*)::int FROM match_results WHERE user_id = $1)    AS matches,
       (SELECT count(*)::int FROM table_chat WHERE user_id = $1)       AS chats,
       (SELECT count(*)::int FROM tables WHERE host_id = $1)           AS tables,
       (SELECT count(*)::int FROM follows WHERE follower_id = $1 OR followee_id = $1) AS follows,
       (SELECT count(*)::int FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1) AS dms,
       (SELECT count(*)::int FROM notifications WHERE user_id = $1)    AS notices,
       (SELECT count(*)::int FROM user_achievements WHERE user_id = $1) AS achievements,
       (SELECT count(*)::int FROM users WHERE invited_by = $1)         AS invited`,
    [user.id],
  );
  plan.push({ user, counts: counts[0] });
}

if (plan.length === 0) {
  await db.close();
  process.exit(1);
}

console.log(yes ? '开始删除：' : '预演（加 --yes 才真删）：');
for (const { user, counts } of plan) {
  console.log(
    `  ${user.account}（${user.name}，${user.id}）：评分 ${counts.ratings}，战绩 ${counts.matches}，` +
      `聊天 ${counts.chats}，开桌 ${counts.tables}，关注 ${counts.follows}，私聊 ${counts.dms}，` +
      `提醒 ${counts.notices}，成就 ${counts.achievements}，他邀请来的人 ${counts.invited}`,
  );
}

if (!yes) {
  console.log('什么都没动。确认无误后加 --yes 重跑。');
  await db.close();
  process.exit(0);
}

const deleted = await db.transaction(async (tx) => {
  for (const { user } of plan) {
    if (purgeTables) {
      await tx.execute(
        'DELETE FROM table_chat WHERE table_id IN (SELECT id FROM tables WHERE host_id = $1)',
        [user.id],
      );
      await tx.execute(
        'DELETE FROM match_actions WHERE table_id IN (SELECT id FROM tables WHERE host_id = $1)',
        [user.id],
      );
      await tx.execute(
        'DELETE FROM match_results WHERE table_id IN (SELECT id FROM tables WHERE host_id = $1)',
        [user.id],
      );
      await tx.execute('DELETE FROM tables WHERE host_id = $1', [user.id]);
    }
    await tx.execute('DELETE FROM ratings WHERE user_id = $1', [user.id]);
    await tx.execute('DELETE FROM match_results WHERE user_id = $1', [user.id]);
    // 别人账上的悬空引用：他邀请来的人、他藏过的榜
    await tx.execute('UPDATE users SET invited_by = NULL WHERE invited_by = $1', [user.id]);
    await tx.execute('UPDATE ratings SET hidden_by = NULL, hidden = false WHERE hidden_by = $1', [
      user.id,
    ]);
    // 人本身：关注/分组/拉黑/私聊/提醒/订阅/成就都靠 ON DELETE CASCADE 带走
    await tx.execute('DELETE FROM users WHERE id = $1', [user.id]);
  }
  return plan.length;
});

console.log(`已删除 ${deleted} 个用户。`);
await db.close();
