-- 牌桌聊天
CREATE TABLE IF NOT EXISTS table_chat (
  id         bigserial PRIMARY KEY,
  table_id   text NOT NULL,
  user_id    text NOT NULL,
  name       text NOT NULL,
  body       text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_table_chat_table ON table_chat (table_id, id DESC);

-- 战绩：一局结束写一次，幂等（同一桌同一人只会有一条）
CREATE TABLE IF NOT EXISTS match_results (
  table_id    text NOT NULL,
  user_id     text NOT NULL,
  game_id     text NOT NULL,
  rank        integer NOT NULL,
  players     integer NOT NULL,
  is_win      boolean NOT NULL,
  finished_at bigint NOT NULL,
  PRIMARY KEY (table_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_match_results_user ON match_results (user_id, finished_at DESC);
