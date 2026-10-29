-- 账号体系：从"输入昵称即登录"升级成真正的注册/登录
--
-- password_hash 为空 = 老版本昵称登录创建的账号，还没设过密码。
-- 这类账号可以走一次「认领」把密码补上（陌生人也能认领，但那和旧版本的安全性等价，不是退步）。
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at bigint;

-- 令牌版本：改密码 / 退出登录时 +1，让已签发的 JWT 立刻作废
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
