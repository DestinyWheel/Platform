-- 两种对局模式：即时制 / 回合制
--
-- mode     realtime | turnbased
-- pace     即时：fast|normal|slow|none    回合：24|12|8|4|2|1|2d|none
-- turn_ms  按 pace 换算出来的"每步给多少毫秒"（回合制里就是给这一动多少时间）
-- window_* 每日可行动时段，单位是「UTC 当天的第几分钟」（0–1439）；null = 全天
-- friendly 友谊赛：无限时长档不计分
ALTER TABLE tables ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'realtime';
ALTER TABLE tables ADD COLUMN IF NOT EXISTS pace text NOT NULL DEFAULT 'normal';
ALTER TABLE tables ADD COLUMN IF NOT EXISTS turn_ms integer;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS window_start integer;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS window_end integer;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS timeout_streak integer NOT NULL DEFAULT 0;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS friendly boolean NOT NULL DEFAULT false;

-- 「我的对局」要按模式过滤，顺手加个索引
CREATE INDEX IF NOT EXISTS idx_tables_mode_status ON tables (mode, status);
