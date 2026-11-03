# 游戏扩展

平台把「扩展」当作独立的对局范围：开房前选择、进桌时提示、Elo 分榜。插件只需要在 manifest 里声明扩展，并根据 `createState` 收到的 id 改规则。

## manifest 声明

```json
{
  "expansions": [
    {
      "id": "crystal-mosaic-x2",
      "name": "马赛克水晶 · ×2 面",
      "description": "开房面板上显示的说明",
      "group": "crystal-mosaic"
    },
    {
      "id": "crystal-mosaic-mosaic",
      "name": "马赛克水晶 · 新图案面",
      "group": "crystal-mosaic"
    },
    { "id": "joker-tiles", "name": "百搭砖" }
  ]
}
```

- `id`：插件内唯一，小写字母/数字/连字符；发布会校验重复。
- `group`：同组互斥。上面两个水晶面最多选一个；不填表示可以和任意其他扩展组合。
- 不选任何扩展就是本体。

## 开房与状态

- 开房面板按 manifest 渲染扩展；同组选择会自动取消另一项。
- 服务端按**建桌时锁定的插件版本**校验 id、去重、按 manifest 顺序排序，并检查同组互斥。
- 选择结果写入 `tables.expansions`，并冻结 `tables.rating_scope`（空串 = 本体）。
- `createState(ctx)` 的 `ctx.expansions` 是规范化后的 id 数组；老插件可以忽略。
- 再来一局复制同一组扩展；回放的 start action 也带扩展，能重建初始状态。
- 快速匹配按 `rating_scope` 精确匹配空桌；不传扩展时只匹配本体桌。

## 非房主通知

`GET /api/tables/:id` 与 WS 快照里新增：

```ts
expansions: SelectedExpansionInfo[];
ratingScope: string;
ratingLabel: string;
expansionNotice: ExpansionNotice | null;
```

`expansionNotice` 只在以下条件同时满足时非空：

- 观看者是**非房主玩家**（观战者不弹）；
- 本桌选了至少一个扩展；
- 牌桌还没结束；
- 这个用户还没对（桌, 扩展组合）确认过。

前端先显示版本公告（`notice`），确认后再显示扩展通知；两个字段在同一份快照里，不依赖服务端队列。确认接口：

```http
POST /api/tables/:id/notices/ack
{ "key": "<ratingScope>" }
```

服务端会重新计算本桌的 scope，不信任客户端自报的任意 key；已读存 `table_notice_acks`，刷新/重连不重复，再来一局是新桌会重新提示。

## Elo 分榜

- `ratings`、`match_results` 增加 `rating_scope`；`ratings` 主键为 `(game_id, rating_scope, user_id)`。
- `rating_scope` 为空串 = 本体；非空 = 选中的扩展 id 按 id 排序后用 `+` 连接
  （manifest 顺序变化不会把同一个组合拆成两个榜）。
- 结算时按本桌冻结的 scope 读写分数，不随插件发新版漂移。
- 排行榜接口支持 `?ratingScope=`；`GET /api/games/:id/rating-scopes` 返回已经产生过分数的范围。
- 大厅、游戏详情、个人战绩和最近对局都会显示扩展标签；管理端隐藏评分也按 scope 独立。
- 旧数据、旧牌桌、旧备份默认都是本体榜。

## 数据库

迁移 `012_expansions.sql` / `013_table_notice_acks.sql`：

```sql
ALTER TABLE tables ADD COLUMN IF NOT EXISTS expansions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS rating_scope text NOT NULL DEFAULT '';
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS rating_scope text NOT NULL DEFAULT '';
ALTER TABLE match_results ADD COLUMN IF NOT EXISTS rating_scope text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS table_notice_acks (...);
```

`ratings` 的旧主键会换成 `(game_id, rating_scope, user_id)`；旧行自动落到 `''`。

## 插件作者要做什么

1. manifest 增加 `expansions`。
2. `createState` 读 `ctx.expansions`，建立对应的牌面/规则。
3. 在 `view` 的公开数据里带上扩展 id 或 profile，让客户端知道该画哪套板。
4. 不要自己弹扩展通知、不要自己算 Elo——这些是平台职责。
5. 发布新版本时只增不改扩展 id；Elo 榜和旧桌都靠这个 id 稳定。
