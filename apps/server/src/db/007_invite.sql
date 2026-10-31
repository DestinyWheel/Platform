-- 邀请码：每个用户一个，注册时自动生成
--
-- 老用户（这次迁移之前注册的）这里是 NULL，可以在用户中心自己生成一次；
-- 生成之后就不再变，"只能生成一次"由 WHERE invite_code IS NULL 保证。
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code_at bigint;

-- 谁邀请来的：注册时填了谁的码就记谁，方便用户中心显示"我邀请了谁"
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by text;

-- 码必须唯一；NULL 不参与唯一性，所以老用户可以暂时没有
CREATE UNIQUE INDEX IF NOT EXISTS users_invite_code_key ON users (invite_code)
  WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_invited_by_idx ON users (invited_by);
