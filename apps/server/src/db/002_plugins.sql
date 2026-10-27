ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- 插件版本表：一个游戏可以有多个版本同时存在（按桌锁定），但只有一个 active
CREATE TABLE IF NOT EXISTS game_versions (
  game_id      text NOT NULL,
  version      text NOT NULL,
  api_version  text NOT NULL,
  manifest     jsonb NOT NULL,
  dir          text NOT NULL,
  hash         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  error        text,
  created_at   bigint NOT NULL,
  activated_at bigint,
  PRIMARY KEY (game_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_game_versions_active
  ON game_versions (game_id)
  WHERE status = 'active';
