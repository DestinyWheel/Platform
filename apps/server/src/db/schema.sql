CREATE TABLE IF NOT EXISTS users (
  id         text PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS tables (
  id           text PRIMARY KEY,
  game_id      text NOT NULL,
  game_version text NOT NULL,
  host_id      text NOT NULL,
  status       text NOT NULL,
  players      jsonb NOT NULL,
  max_players  integer NOT NULL,
  options      jsonb NOT NULL,
  state        jsonb,
  seq          integer NOT NULL DEFAULT 0,
  log          jsonb NOT NULL DEFAULT '[]'::jsonb,
  deadline_at  bigint,
  created_at   bigint NOT NULL,
  started_at   bigint,
  finished_at  bigint
);

CREATE INDEX IF NOT EXISTS idx_tables_created ON tables (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tables_deadline ON tables (status, deadline_at);

-- 只追加的动作日志：回放、审计、以及"服务重启后仍能证明这局怎么走到这里"的唯一真相。
CREATE TABLE IF NOT EXISTS match_actions (
  table_id   text NOT NULL,
  seq        integer NOT NULL,
  actor      text,
  kind       text NOT NULL,
  action     jsonb,
  effects    jsonb NOT NULL DEFAULT '[]'::jsonb,
  state_hash text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (table_id, seq)
);
