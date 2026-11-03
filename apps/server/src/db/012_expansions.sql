-- 扩展与 Elo 分榜
--
-- rating_scope 为空串 = 本体；非空 = 按 manifest 顺序拼接的扩展 id（用 + 连接）。
-- 老数据默认 ''，因此升级后历史对局仍归入本体榜。

ALTER TABLE tables ADD COLUMN IF NOT EXISTS expansions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS rating_scope text NOT NULL DEFAULT '';

ALTER TABLE ratings ADD COLUMN IF NOT EXISTS rating_scope text NOT NULL DEFAULT '';
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_pkey;
ALTER TABLE ratings ADD PRIMARY KEY (game_id, rating_scope, user_id);

ALTER TABLE match_results ADD COLUMN IF NOT EXISTS rating_scope text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_ratings_game_scope
  ON ratings (game_id, rating_scope, rating DESC);

CREATE INDEX IF NOT EXISTS idx_match_results_user_scope
  ON match_results (user_id, rating_scope, finished_at DESC);
