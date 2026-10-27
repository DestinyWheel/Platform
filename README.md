# Platform

私人桌游平台（BGA 风格），游戏以插件形式存在，**新增/升级游戏不需要重启服务，也不需要重新发布前端**。

当前进度：**M1 完成** —— M0 的骨架（登录、大厅、开桌、WS 实时对局、超时兜底）之上，状态已落库：重启不丢局、CAS 并发、动作日志可重放。示例游戏「骰子对决」。

## 快速开始

```bash
pnpm install
pnpm dev          # 同时起 server(8787) + web(5173)
```

打开 <http://127.0.0.1:5173>，输入昵称进入。开一张桌，把地址复制到另一个浏览器（或无痕窗口）用另一个昵称加入，房主点「开始游戏」。

> 同一个昵称 = 同一个身份。想模拟两个人，用两个浏览器 profile 或无痕窗口。
>
> **数据库零配置**：默认用 PGlite（嵌入式 Postgres，WASM），数据落在 `.data/pg`。要连真 Postgres，设 `DATABASE_URL=postgres://user:pass@host/db` 即可，SQL 和迁移完全一样。

### 其它命令

```bash
pnpm typecheck    # 全仓库类型检查
pnpm build        # 构建前端到 apps/web/dist
pnpm smoke        # 端到端冒烟：打完一局 + 中途重启恢复 + 日志重放校验 + 超时兜底
```

## 架构

一句话：**每局游戏 = 可序列化状态 + 纯函数 reducer + 事件日志**，进程里不留长驻游戏对象，所以换游戏代码不需要重启。

详细设计见 [docs/architecture.md](docs/architecture.md)，实现边界见 [docs/m0.md](docs/m0.md) 与 [docs/m1.md](docs/m1.md)。

```
apps/
  server/          Fastify + WS + 牌桌服务（CAS 并发）+ Postgres/PGlite 存储
    src/db/        数据库抽象：PGlite(本地) / pg(生产) + 迁移
  web/             React 宿主：登录 / 大厅 / 牌桌 / 游戏组件注册表
packages/
  sdk/             插件契约 + 线上协议（前后端共用）
  engine/          纯函数引擎：状态机推进、动作校验、视图裁剪
games/
  dice/            示例插件：骰子对决
scripts/
  smoke.mjs        端到端验证（对局 + 重启恢复 + 日志重放 + 超时）
```

**分层纪律**：`packages/engine` 不得 import 任何 DB / socket；插件不得碰 DB / socket / 全局随机 / 系统时钟。

## 加一个游戏

1. 复制 `games/dice` 到 `games/<你的游戏>`
2. 改 `manifest`、`createState`、`states`、`actions`
3. 在 `apps/server/src/games.ts` 注册服务端插件
4. 在 `apps/web/src/games/registry.ts` 注册前端组件

M2 会把这两处注册都换成运行时扫描，届时第 3、4 步就不需要了。
