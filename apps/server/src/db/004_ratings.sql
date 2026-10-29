-- Elo 评分：每人每个游戏一条
CREATE TABLE IF NOT EXISTS ratings (
  game_id    text NOT NULL,
  user_id    text NOT NULL,
  rating     integer NOT NULL,
  games      integer NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL,
  PRIMARY KEY (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_game ON ratings (game_id, rating DESC);
