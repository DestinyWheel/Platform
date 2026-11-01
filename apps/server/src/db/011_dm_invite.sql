-- 私聊里的「邀请」不该只是一段带房间号的文字：对方得自己复制、自己找入口。
--
--   kind  'text'（默认）| 'invite'
--   link  页面内跳转地址，形如 #/join/ABC234；点一下就能进桌（开打了就是观战）
--   meta  邀请的那张桌：{tableId, code, gameId, gameName}，前端据此画卡片
--
-- 老数据不用回填：kind 默认 text，前端对 text 消息会把正文里的链接也变成可点的。
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS link text;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS meta jsonb;
