-- 房间码 / 认负结算 / 回放快照 / 版本公告已读

-- 房间码：6 位、去掉 0/O/1/I，能念能抄。
-- 老数据没有码（NULL），不影响使用，只是不能按码加入。
ALTER TABLE tables ADD COLUMN IF NOT EXISTS code text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_code ON tables (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tables_status ON tables (status, created_at DESC);

-- 平台产生的结算结果（认负这类插件没算过 ranking 的情形）。
-- recordResult 优先读它，读不到才回落到插件状态里的 ranking。
ALTER TABLE tables ADD COLUMN IF NOT EXISTS result jsonb;

-- 回放快照：每 50 步存一份，回放从最近的一份重新开始，而不是从第 0 步。
-- state 是服务端状态（含隐藏信息），只存库、绝不下发。
CREATE TABLE IF NOT EXISTS match_snapshots (
  table_id   text NOT NULL,
  seq        integer NOT NULL,
  state      jsonb NOT NULL,
  state_hash text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (table_id, seq)
);

-- 版本公告已读：一个人对（游戏, 版本）只读一次
CREATE TABLE IF NOT EXISTS version_acks (
  user_id  text NOT NULL,
  game_id  text NOT NULL,
  version  text NOT NULL,
  acked_at bigint NOT NULL,
  PRIMARY KEY (user_id, game_id, version)
);
