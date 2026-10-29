# Platform

私人桌游平台（BGA 风格），游戏以插件形式存在，**新增/升级游戏不需要重启服务，也不需要重新发布前端**。

当前进度：**M4 完成** —— 骨架、持久化、CAS 并发、插件热加载（含 worker 隔离）、回放/聊天/观战/战绩/Elo 之上，补齐了运维层：**限流、结构化日志、备份恢复、指标**。

## 快速开始

```bash
pnpm install
pnpm dev          # 同时起 server(8787) + web(5173)
```

打开 <http://127.0.0.1:5173>，输入昵称进入。开一张桌，把地址复制到另一个浏览器（或无痕窗口）用另一个昵称加入，房主点「开始游戏」。

> 同一个昵称 = 同一个身份。想模拟两个人，用两个浏览器 profile 或无痕窗口。
>
> **数据库零配置**：默认用 PGlite（嵌入式 Postgres，WASM），数据落在 `.data/pg`。要连真 Postgres，设 `DATABASE_URL=postgres://user:pass@host/db` 即可，SQL 和迁移完全一样。
>
> **插件零配置**：服务启动时自动发布 `games/` 下的所有游戏，产物落在 `storage/plugins/`。

### 其它命令

```bash
pnpm typecheck    # 全仓库类型检查
pnpm build        # 构建前端到 apps/web/dist
pnpm smoke        # 端到端：八段，从对局到限流/备份全跑一遍
pnpm pack:game    # 把某个游戏打成 zip（用于后台上传）
```

## 架构

一句话：**每局游戏 = 可序列化状态 + 纯函数 reducer + 事件日志**，进程里不留长驻游戏对象，所以换游戏代码不需要重启。

详细设计见 [docs/architecture.md](docs/architecture.md)，实现边界见 [docs/m0.md](docs/m0.md)、[docs/m1.md](docs/m1.md)、[docs/m2.md](docs/m2.md)、[docs/m3.md](docs/m3.md)、[docs/m5.md](docs/m5.md)（M4 人机尚未开始）。

```
apps/
  server/          Fastify + WS + 牌桌服务（CAS 并发）+ 存储 + 插件宿主
    src/db/        数据库抽象：PGlite(本地) / pg(生产) + 迁移
    src/pluginHost/  编译 / 静态检查 / 冒烟 / 版本注册表 / worker 运行时
    src/elo.ts     多人局 Elo 评分
    src/presence.ts 在线人数（单实例内存实现）
  web/             React 宿主：登录 / 大厅 / 牌桌 / 回放 / 插件容器
    src/host/      运行时加载 /plugins/<id>/<version>/client.js
packages/
  sdk/             插件契约（服务端 + 客户端）+ 线上协议
  engine/          纯函数引擎：状态机推进、动作校验、视图裁剪
games/
  dice/            示例插件：manifest + 服务端规则 + 原生 DOM 客户端
  mandala/         曼荼罗（移植自 D:\Workspace\gamer\Mandala 的 Lua 实现）
scripts/
  smoke.mjs        端到端验证
  pack-game.mjs    打包插件
```

**分层纪律**：`packages/engine` 不得 import 任何 DB / socket；插件不得碰 DB / socket / 全局随机 / 系统时钟。

## 已有的游戏

| 游戏 | 说明 |
|---|---|
| 骰子对决 | 示例，用来跑通链路 |
| 曼荼罗 | 双人卡牌，规则移植自 Lua 实现，含隐藏信息 / 结算子流程。见 [docs/mandala.md](docs/mandala.md) |

## 玩起来之后

| 能力 | 说明 |
|---|---|
| 回放 | 一局结束后点「看回放」，按步拖动。服务端重放动作日志生成每步的观战者视角 |
| 聊天 | 牌桌内实时聊天，落库持久化 |
| 观战 | 不坐下也能看，顶栏显示当前有几个人在看 |
| 战绩 | 大厅里的「我的战绩」：场次 / 胜场 / 胜率，附最近对局（可直接跳回放） |
| Elo | 每人每个游戏一个分数，默认 1500，零和；开桌时 `ranked: false` 可打休闲局不计分 |

## 运维

| 做什么 | 怎么做 |
|---|---|
| 健康检查 | `GET /api/health` —— db 类型、uptime、内存、worker 数、各状态牌桌数 |
| 指标 | `GET /api/metrics`（管理员）—— Prometheus 文本格式 |
| 备份 | `POST /api/admin/backup`（管理员）—— 整库导出到 `storage/backups/*.json.gz` |
| 恢复 | `pnpm tsx scripts/restore.mjs <备份文件> [--data-dir <目录>]`（**破坏性**） |
| 回收插件 | `POST /api/admin/plugins/gc` —— 卸载无人在用的旧版本 worker |

限流默认全开：登录按 IP、建桌/上传按用户、聊天和动作按 WS 连接。超限返回 `429` + `retry-after`。

细节见 [docs/m5.md](docs/m5.md)。

## 加一个游戏

1. 复制 `games/dice` 到 `games/<你的游戏>`，改 `manifest.json`（id / 版本 / 人数）
2. 写 `src/server.ts`（`GamePlugin`：状态机 + 纯 reducer + 视图裁剪；动作带参数时建议实现 `legalMoves`，UI 才能精确高亮）
3. 写 `src/client.ts`（`GameClient`：`mount` / `update` / `unmount`，可以是原生 DOM、Canvas 或任意框架）
4. 重启 `pnpm dev`（开发态自动发布），或者 `pnpm pack:game games/xxx` 后到后台 `POST /api/admin/plugins` 上传

**不需要改宿主任何代码**——旧的静态注册表已经删掉了。

## 发布新版本

改高 `manifest.json` 里的 `version`，然后上传。新桌用新版本，已经在跑的桌继续用旧版本直到结束（`tables.game_version` 锁死）。同一版本号覆盖内容会被拒绝，避免偷偷换掉进行中牌桌的规则。

开发时想原地替换：`POST /api/admin/plugins/republish`（管理员）。
