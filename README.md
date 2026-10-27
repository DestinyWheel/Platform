# Platform

私人桌游平台（BGA 风格），游戏以插件形式存在，**新增/升级游戏不需要重启服务，也不需要重新发布前端**。

当前进度：**M0 骨架已跑通** —— 登录、大厅、开桌、WS 实时对局、超时兜底、终局排名，用示例游戏「骰子对决」验证。

## 快速开始

```bash
pnpm install
pnpm dev          # 同时起 server(8787) + web(5173)
```

打开 <http://127.0.0.1:5173>，输入昵称进入。开一张桌，把地址复制到另一个浏览器（或无痕窗口）用另一个昵称加入，房主点「开始游戏」。

> 同一个昵称 = 同一个身份。想模拟两个人，用两个浏览器 profile 或无痕窗口。

### 其它命令

```bash
pnpm typecheck    # 全仓库类型检查
pnpm build        # 构建前端到 apps/web/dist
pnpm smoke        # 端到端冒烟：真起服务，两个客户端把一局骰子打完
```

## 架构

一句话：**每局游戏 = 可序列化状态 + 纯函数 reducer + 事件日志**，进程里不留长驻游戏对象，所以换游戏代码不需要重启。

详细设计见 [docs/architecture.md](docs/architecture.md)，M0 的实现边界见 [docs/m0.md](docs/m0.md)。

```
apps/
  server/          Fastify + WS + 牌桌 actor + 内存存储
  web/             React 宿主：登录 / 大厅 / 牌桌 / 游戏组件注册表
packages/
  sdk/             插件契约 + 线上协议（前后端共用）
  engine/          纯函数引擎：状态机推进、动作校验、视图裁剪
games/
  dice/            示例插件：骰子对决
scripts/
  smoke.mjs        端到端验证
```

**分层纪律**：`packages/engine` 不得 import 任何 DB / socket；插件不得碰 DB / socket / 全局随机 / 系统时钟。

## 加一个游戏

1. 复制 `games/dice` 到 `games/<你的游戏>`
2. 改 `manifest`、`createState`、`states`、`actions`
3. 在 `apps/server/src/games.ts` 注册服务端插件
4. 在 `apps/web/src/games/registry.ts` 注册前端组件

M2 会把这两处注册都换成运行时扫描，届时第 3、4 步就不需要了。
