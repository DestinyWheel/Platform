# TODO / 未做的事

> 这份文件存在的唯一目的：让"还没做"是有据可查的，而不是藏在某个人脑子里。
> 每条都写清楚**为什么没做**和**真要做的话怎么做**，避免下次重新想一遍。

---

## 一、M3 遗留：体验打磨

### 1. 多语言（i18n）

**现状**：日志用 key + args 表达（`LogEntry.key`），插件可以在 `formatLog` 里自己翻译；
但界面文案全是硬编码中文，插件也没有 `locales/` 的落地实现。

**没做的原因**：要先决定"支持哪几种语言"。这是个产品决定，不是技术决定。

**要做的话**：

1. 宿主文案抽成 `locales/zh-CN.json` / `en.json`，用 `t('lobby.create')` 取
2. manifest 加 `locales?: string[]`，插件产物里允许 `locales/*.json`
3. `formatLog(entry)` 的上下文里注入当前语言和插件的字典
4. 语言选择存 `localStorage` + 用户表 `locale` 列（跨设备一致）

### 2. 音效

**现状**：SDK 的 effect 里有 `{ type: 'sound', key: string }`，但**前端没有任何播放逻辑**。
也就是说插件现在 emit 一个 sound 效果，除了进日志以外什么都不会发生。

**要做的话**：

1. 插件产物里允许 `assets/`，音频 URL 走 `/plugins/<id>/<version>/assets/xxx.mp3`
2. 宿主维护一个 `Map<key, Audio>`，收到 sound 效果就播
3. 浏览器自动播放限制：首次用户交互前不播（记住 `unlocked` 状态）
4. 顶栏加静音开关，存 `localStorage`
5. 音量/静音是宿主设置，插件只负责说"该响什么"

### 3. 移动端

**现状**：只有两条 `@media (max-width: 860px)` 的 `grid-template-columns: 1fr`，
把牌桌的左右栏折成上下。牌桌和曼荼罗在真机上**没有实测过**。

**要做的话**：

1. 先在真机上过一遍：iPhone SE（375×667）和一台 Android
2. 触摸目标 ≥ 44px（现在按钮是 8px padding，偏小）
3. 曼荼罗的牌面用 `clamp()` 或容器查询做流式尺寸
4. 聊天/日志在窄屏上改成抽屉或 tab，别和小屏幕抢纵向空间
5. 横屏时牌桌是最舒服的——考虑提示用户转屏，而不是硬塞进竖屏

---

## 二、这次明确推迟的

| 项 | 为什么推迟 | 真要做怎么做 |
|---|---|---|
| **多人局的认负语义** | 现在认负 = 整局结束。2 人局没问题，4 人局一个人退出不该把别人也劝退 | 认负只标记该座位失败、对局继续；剩余能行动的人数 ≤ 1 时才结束。`TablePlayer.forfeited` 已经留好了 |
| **回放分页** | 现在超过 400 步就只回放最后一段（靠 `match_snapshots` 起算） | `replay(tableId, fromSeq)` 加分页游标，前端加"跳到下一步/上一步"的分页控件 |
| **插件前端隔离** | 插件 `client.js` 和宿主同源，理论上能读 localStorage 里的令牌 | ① `iframe` + `postMessage`（改动大）；② 先把会话从 localStorage 挪到 httpOnly cookie（见下） |
| **大厅分页** | 房间列表已经删掉了，"我的对局"只查自己的、最多 20 条 | 真需要时再加 `?before=<createdAt>` 游标 |

---

## 三、已知取舍（不是遗漏，是选了另一条路）

| 现状 | 影响 | 要改的话 |
|---|---|---|
| 限流、在线人数在进程内存 | 多实例部署时各算各的 | 抽 `RateLimiterStore` / `PresenceStore` 接口，加 Redis 实现；现在已经是类，改成接口+工厂 |
| 没有审计表 | 管理操作只进结构化日志，日志轮转后就没了 | `audit_log(actor, action, target, detail, at)` + 管理端只读页 |
| 会话令牌在 localStorage | 同源脚本（含插件）能读到 | 挪到 httpOnly cookie + CSRF token；影响所有请求，得单独一轮做 |
| WS 令牌在 query string | 会进访问日志 | 改成连接后第一帧发 token，或 `Sec-WebSocket-Protocol` |
| 退出登录 = 所有设备退出 | 令牌无状态，作废就是整版本作废 | 每会话一个 sid + 服务端黑名单表 |
| 备份是逻辑备份 | 没有 PITR，恢复只能到某次备份的点 | 用 Postgres 的话上 `pg_basebackup` + WAL 归档 |
| 没有告警 | 服务挂了只有人发现 | `/api/metrics` 已经能抓，接一个 Prometheus + 简单规则即可 |

---

## 四、工程化（部分已做）

- [x] CI（GitHub Actions：typecheck + test + build + smoke）
- [x] 单元测试（`pnpm test`，19 条，覆盖引擎/ElO/密码/令牌/哈希）
- [x] `.env.example`
- [ ] eslint（先只开 `recommended`，得先清一遍存量告警）
- [ ] 前端测试（组件层，需要先决定用 testing-library 还是 Playwright）
- [ ] Dockerfile（要真部署再做；注意服务端靠 tsx 直接跑 TS，镜像里得带 devDependencies）
- [ ] 发布流程文档（版本号策略、回滚步骤）

## 五、功能上还想要的

- [ ] 大厅显示"谁在线"（`Presence` 已经在统计，只是没暴露成全局视图）
- [ ] 观战者能发弹幕？先不要。
- [ ] 对局结束后自动生成一张"战报"图（分享用）
- [ ] 房间密码（现在房间号就是通行证）
- [ ] 把 `ranked: false` 的休闲局也做得更明显（现在只是不记分）
