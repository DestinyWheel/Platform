-- 昵称可以重复了，用 #编号 区分人
ALTER TABLE users ADD COLUMN IF NOT EXISTS tag text;

-- 老账号补一个：按注册顺序发 1000、1001……确定性、不重复，之后新用户才是随机数
UPDATE users u
   SET tag = t.tag
  FROM (
    SELECT id, lpad((1000 + row_number() OVER (ORDER BY created_at, id))::text, 4, '0') AS tag
      FROM users
     WHERE tag IS NULL
  ) t
 WHERE u.id = t.id;

ALTER TABLE users ALTER COLUMN tag SET NOT NULL;

-- 编号全局唯一：这样「#4821」单独念出来也能定位到人
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tag ON users (tag);

-- 昵称不再唯一，但检索要快
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_name_key;
CREATE INDEX IF NOT EXISTS idx_users_name ON users (name);

-- 上次看「消息」的时间：新关注、新私聊都按它算未读
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_seen_at bigint NOT NULL DEFAULT 0;

-- 关注分组（每个人一份，可以改名、可以删；删了组里的人回到默认组）
CREATE TABLE IF NOT EXISTS follow_groups (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       text NOT NULL,
  sort       integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_follow_groups_user ON follow_groups (user_id, sort);

-- 关注：单向，可以放进某个分组，也可以标成「特别关注」
CREATE TABLE IF NOT EXISTS follows (
  follower_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id    text REFERENCES follow_groups (id) ON DELETE SET NULL,
  special     boolean NOT NULL DEFAULT false,
  created_at  bigint NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id, created_at DESC);

-- 拉黑：我拉黑的人不能私聊我；我也不会收到他的消息
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id);

-- 私聊：一条消息就是收发双方 + 正文，会话由前端按对方聚合
CREATE TABLE IF NOT EXISTS direct_messages (
  id           text PRIMARY KEY,
  sender_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body         text NOT NULL,
  created_at   bigint NOT NULL,
  read_at      bigint
);

CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages (sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_inbox ON direct_messages (recipient_id, read_at);

-- 排行榜：管理员可以把某个人从某个游戏的榜上藏掉（整行不显示，名次顺延）
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS hidden_by text;
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS hidden_at bigint;
