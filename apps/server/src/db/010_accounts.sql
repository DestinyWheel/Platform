-- 账户 + 昵称：账户全局唯一、用来登录；昵称只是展示，可以重复、可以改
ALTER TABLE users ADD COLUMN IF NOT EXISTS account text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;

-- 老数据：昵称去掉 #编号 就是账户
UPDATE users
   SET account = btrim(regexp_replace(name, '#[0-9]{4,6}$', ''))
 WHERE account IS NULL;

-- 重名兜底：正常情况下没有，真有也不能让迁移卡死。
-- 同一个账户名里，最早注册的保留原名，后来者加数字后缀（跑三遍防后缀再撞车）
WITH ranked AS (
  SELECT id, account, row_number() OVER (PARTITION BY account ORDER BY created_at, id) AS rn
    FROM users
)
UPDATE users u
   SET account = r.account || r.rn::text
  FROM ranked r
 WHERE u.id = r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id, account, row_number() OVER (PARTITION BY account ORDER BY created_at, id) AS rn
    FROM users
)
UPDATE users u
   SET account = r.account || r.rn::text
  FROM ranked r
 WHERE u.id = r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id, account, row_number() OVER (PARTITION BY account ORDER BY created_at, id) AS rn
    FROM users
)
UPDATE users u
   SET account = r.account || r.rn::text
  FROM ranked r
 WHERE u.id = r.id AND r.rn > 1;

ALTER TABLE users ALTER COLUMN account SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_account ON users (account);

-- 昵称不再需要 #编号：删掉这一列，界面上也不再拼
DROP INDEX IF EXISTS ux_users_tag;
ALTER TABLE users DROP COLUMN IF EXISTS tag;

-- 提醒中心：@提及、新粉丝、订阅、成就解锁都落这儿，铃铛和「消息 → 提醒」共用
CREATE TABLE IF NOT EXISTS notifications (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  created_at bigint NOT NULL,
  read_at    bigint
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);

-- 订阅：某个游戏开桌、或者某个人开桌时提醒我
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  target     text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (user_id, kind, target)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_target ON subscriptions (kind, target);

-- 成就：由游戏插件声明，平台只负责记「谁在什么时候解锁了哪一个」
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id        text NOT NULL,
  achievement_id text NOT NULL,
  table_id       text,
  unlocked_at    bigint NOT NULL,
  PRIMARY KEY (user_id, game_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements (user_id, unlocked_at DESC);
