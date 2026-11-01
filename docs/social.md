# 身份与社交：账户、昵称、关注、私聊、提醒、成就

这一层解决五件事：**怎么认人**（账户 / 昵称）、**怎么把人分堆**（关注 / 分组）、
**怎么私下说话**（私聊）、**怎么提醒**（@提及 / 订阅 / 邀请 / 成就）、
**怎么留下痕迹**（成就徽章）。

## 一、账户 + 昵称

| 东西 | 位置 | 说明 |
| --- | --- | --- |
| 账户名 | `users.account` | 全局唯一，**登录用它**，注册后不可改 |
| 昵称 | `users.name` | 界面上显示的名字，可以重复、随时可改 |
| 头像 | `users.avatar` | `preset:<id>` / `upload:<文件>` / null（按 id 稳定挑一个） |
| 签名 | `users.signature` | 一句话，60 字以内 |

- **登录只认账户名**。昵称不能用来登录——重名的人太多了，昵称不是身份。
- 老数据迁移：把原来的 `名字#编号` 去掉 `#编号` 当作账户名，`#编号` 这一列整个删掉。
  极少数同名账户会被自动加上数字后缀（`zhangsan2`），保证唯一索引建得起来。
- 展示的地方（大厅、牌桌座位、聊天、榜单、管理端、回放）一律用**昵称**。
- 需要认人的地方（@提及、检索、登录）用**账户名**，界面上以 `@account` 的形式标出来。

## 二、头像与签名

- 头像先只做**预设**：10 个 emoji + 深色底，`packages/sdk/src/avatar.ts` 前后端共用。
- 没设置过的人按 `id` 稳定地挑一个——同一个人每次刷新都是同一张，不会闪。
- 上传头像的代码已经写好了（`POST /api/me/avatar`，PNG/JPEG/WebP、512KB 上限、
  校验文件头、存 `storage/avatars/`、按 URL 长缓存），但**默认关着**：
  `AVATAR_UPLOAD=1` 才开放。现在前端只给预设选择器。

## 三、关注、分组、特别关注

- `follow_groups`：每人一份，第一次用社交功能时自动建「默认分组」。
  删分组不删关注，人回默认组；默认组不能删。
- `follows`：`(follower_id, followee_id)` 主键，单向。带 `group_id` 和 `special`。
- 特别关注只影响排序（置顶）和提醒（不折叠）。

## 四、私聊与拉黑

- `direct_messages`：一行一条，`read_at` 标已读；会话按对方聚合（LATERAL 取最后一条 + 未读数）。
- `blocks`：单向拉黑、双向生效——任一方拉黑，双方都发不了私聊。
- 邀请某人来打牌也走私聊：发一条带房间号的私聊 + 一条提醒。

## 五、提醒中心

`notifications(user_id, kind, title, body, link, created_at, read_at)`

| kind | 什么时候产生 | link |
| --- | --- | --- |
| `mention` | 牌桌聊天里 `@账户名` | `#/table/<id>` |
| `follow` | 有人关注你 | `#/u/<id>` |
| `subscribe` | 你订阅的游戏有人开桌 / 你订阅的人开桌 | `#/join/<房间号>` |
| `achievement` | 解锁成就 | `#/game/<id>` |
| `system` | 邀请你打牌 | `#/join/<房间号>` |

- 大厅铃铛上的数字 = 未读私聊 + 未读提醒。
- 「消息」页分两个页签：私聊 / 提醒；打开提醒页签就把未读清零。
- 通知会通过 WebSocket 的 `user:<id>` 频道即时推给所有连接（`{ t: 'notice' }`），
  推不到也没关系——下次打开页面列表还在。

## 六、订阅

`subscriptions(user_id, kind, target)`，`kind` 是 `game` 或 `user`：

- 订阅游戏 → 这个游戏有人开桌时提醒你（`#/game/:id` 上的「订阅开桌提醒」）
- 订阅人 → 这个人开桌时提醒你

订阅是"轻量的关注牌桌"，和关注不是一回事：关注管的是人和分组，订阅管的是**开桌这件事**。

## 七、@提及

牌桌聊天里写 `@账户名`：

- 只提醒**同一桌**的真人（不在桌上的人被 @ 到也一脸问号）
- 服务端解析、落 `notifications`、推 WS、铃铛加一
- 前端把 `@xxx` 高亮成一个小标签

## 八、最近一起玩过 + 一键邀请

- `recentPlayers`：从 `tables.players` 里反查同桌过的人（排除机器人和自己），
  按最近一次同局时间倒序。
- 大厅直接列出来，可以私聊。
- 开桌等人的时候，牌桌里列「叫个人来」，点一下就给对方发邀请（私聊 + 提醒）。

## 九、成就：定义权在插件

平台只存「谁在什么时候解锁了哪个 id」：

```sql
user_achievements(user_id, game_id, achievement_id, table_id, unlocked_at)
PRIMARY KEY (user_id, game_id, achievement_id)
```

- **成就的名字、说明、徽章长什么样（emoji + 颜色）全部来自插件 manifest 的
  `achievements` 字段**，平台不认识任何具体成就。
- 插件在 `reduce` / `onEnter` 里 `ctx.emit({ type: 'achievement', player, key })`。
- 平台只认 manifest 里声明过的 key（写错不落库），同一人同一成就只记一次，
  机器人不记，解锁后给那个人发一条提醒。
- 个人主页按解锁时间倒序列出徽章；点开能看到说明和所属游戏。
- 现有三个游戏各自声明了自己的成就：骰子（首胜 / 六六大顺）、
  曼荼罗（首次染指 / 大丰收）、纸牌帮（开张大吉 / 全身而退 / 滴水不漏）。

## 十、接口一览

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{account, name?, password}` |
| POST | `/api/auth/login` | `{account, password}` |
| PATCH | `/api/me/profile` | `{name?, signature?, avatar?}` |
| POST | `/api/me/avatar` | 原始二进制图片（默认关闭） |
| GET | `/api/users/search?q=` | 账户精确/前缀、昵称包含 |
| GET | `/api/users/:id` | 主页：资料、战绩、成就、关注/拉黑状态 |
| GET | `/api/notifications` / POST `.../read` | 提醒列表 / 全部已读 |
| GET | `/api/subscriptions` / POST / DELETE `/:kind/:target` | 订阅管理 |
| GET | `/api/players/recent` | 最近一起玩过的人 |
| POST | `/api/tables/:id/invite` | 邀请某人来这张桌 |
| GET | `/api/dm`、`/api/dm/:id`、POST `/api/dm/:id` | 会话列表 / 对话 / 发消息 |
| GET/POST/DELETE/PATCH | `/api/social/*` | 关注、分组、拉黑 |
| GET/POST | `/api/admin/ratings`、`/api/admin/ratings/hide` | 榜单隐藏 |

## 十一、迁移注意

- `010_accounts.sql`：补 `account`（从昵称去掉 `#编号`）、删 `tag` 列、建唯一索引，
  再建 `notifications` / `subscriptions` / `user_achievements`。
- **在这之前的备份恢复不了**（老备份里没有 `account` 列），要恢复先升级表结构。
- 老牌桌里座位上的名字还是当时写进去的（带 `#编号`），会一直留到那一局结束；
  新开的桌都是纯昵称。
- 上传头像的目录是 `storage/avatars/`，备份脚本不包含它（图片丢了重新选一个就行）。

## 十二、验证

`tests/social.test.ts` 起一个真的 PGlite 跑迁移，覆盖：账户唯一、同名昵称、
资料修改、检索、关注分组、拉黑、私聊、提醒、订阅、成就幂等、最近一起玩过、
排行榜隐藏。

端到端 `.preview/accounts-e2e.mjs` 走真实 HTTP + WebSocket：注册两个同名不同账户 →
账户登录 → 改资料 → 关注/提醒 → 订阅开桌 → 打一局骰子（@提及 + 解锁成就）→
查看最近一起玩过 → 邀请进桌 → 全部已读。
