-- 桌级提示已读：例如「本局使用的扩展」。
-- 一个人对（桌, 提示 key）只读一次；再来一局是新桌，会重新提示。
CREATE TABLE IF NOT EXISTS table_notice_acks (
  user_id    text NOT NULL,
  table_id   text NOT NULL,
  notice_key text NOT NULL,
  acked_at   bigint NOT NULL,
  PRIMARY KEY (user_id, table_id, notice_key)
);
