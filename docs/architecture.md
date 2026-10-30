# 私人桌游平台 —— 前后端框架规划

> 目标：BGA 式的私人桌游平台，游戏以插件形式存在，**新增/升级游戏不需要重启服务，也不需要重新发布前端**。

---

## 0. 结论先行

| 层 | 选型 | 一句话理由 |
|---|---|---|
| 运行时 | Node.js 22 + TypeScript (strict) | 游戏规则与前端 UI 共享类型，插件生态最省力 |
| HTTP | Fastify | 快、schema 驱动、插件化生态 |
| 实时 | `@fastify/websocket`（原生 ws） | 协议自己定，比 Socket.IO 轻，可完全掌控补丁/seq |
| 数据库 | PostgreSQL 16 + Drizzle ORM | JSONB 存局面、事务保证单表原子推进 |
| 缓存/广播 | Redis 7 | presence、计时器 zset、多实例 pub/sub |
| 校验 | Zod | 同一份 schema 用于 manifest、动作入参、WS 协议 |
| 插件构建 | esbuild | 上传即构建客户端 bundle，毫秒级，不用重启 |
| 宿主前端 | React 19 + Vite + Zustand + Tailwind | 宿主只做"壳"，游戏 UI 由插件自己渲染 |
| 隔离 | `node:worker_threads`（每版本一个 worker） | 可 `terminate()` → 真正卸载旧版本代码 |
| 工程 | pnpm workspaces monorepo | SDK / 引擎 / 协议 / 游戏插件分仓同管 |

**架构一句话**：把每局游戏建模成 **「可序列化状态 + 纯函数 reducer + 事件日志」**，进程里不留任何长驻游戏对象；游戏代码放在按版本隔离的 worker 里，升级 = 起新 worker + 切换版本指针，运行中的旧桌继续用旧版本直到结束。

### 已定决策

| 决策 | 结论 | 影响 |
|---|---|---|
| 对局节奏 | **回合制为主**（同步轮流出手，每步一个 deadline） | 计时器模型极简：一桌同时只有一个 deadline；异步长局只预留字段（§9） |
| AI / 人机 | 暂不做。**预留 Bot 口子**，后期做"行为优先级打分"式简单人机 | bot = 没有 socket 的玩家，走完全相同的动作通道（§3.5） |
| 插件信任 | **内部人员上传，按可信处理** | worker 隔离用于「可卸载 + 故障隔离 + 确定性校验」，不作为安全边界（§12） |
| 部署 | 默认单实例；但代码按"随时可多实例"写 | 只依赖 `Bus` / `Presence` / `TimerScheduler` 三个接口（§2.2–2.3） |

---

## 1. 为什么这样设计能"零重启"

BGA 的原始设计其实已经回答了这个问题的一半：**PHP 每个请求都重新加载游戏代码，从数据库重建局面**。所以线上代码换了，下一个请求自然用新代码。

我们把这个思路升级成显式架构：

```
action ──▶ [ 从 DB 读 state ] ──▶ reduce(state, action) ──▶ [ 写回 state + 追加 event log ]
                                        ▲
                                  纯函数，无 I/O
```

由此得到的热插拔能力：

- **没有需要迁移的内存对象**。进程重启/换代码/换机器，局面从 DB 恢复，行为完全一致。
- **没有"游戏进行中"的模块状态**。旧版本 worker 只要还有桌在用就活着，没有桌了就 `terminate()`。
- **版本可以并行共存**。`tables.game_version` 锁定版本，A 桌跑 1.2.0、B 桌跑 1.3.0，互不干扰。
- **副作用被抽成 `Effect[]`**，由宿主统一落实（写日志、广播、设定计时器、结算 Elo）。插件碰不到 DB 和 socket。

这套模型顺带白送：**回放、断线重连、撤销、AI 自对弈、插件冒烟测试**——全都是"重放 action 序列"。

---

## 2. 后端分层

```
apps/server/src/
  http/         REST：认证、大厅、战绩、管理端（插件上传/启停）
  ws/           连接鉴权、订阅房间、协议编解码、心跳
  table/        单桌 actor：加入/准备/开始/动作/超时/结算/放弃
  engine/       纯函数引擎：状态机推进、动作校验、视图裁剪
  pluginHost/   插件注册表、构建、加载、worker 池、健康检查、版本切换
  timer/        截止时间调度（Redis zset + 启动重建）
  store/        Postgres 仓储 + Redis 封装
```

**硬性分层规则**：

- `engine/` 不得 `import` 任何 `store/`、`ws/`、`http/`。它只接受 `(state, action, ctx)`，返回 `{ state, effects }`。
- `pluginHost/` 是唯一会执行第三方代码的地方，被 `engine/` 通过接口调用。
- `table/` 是唯一会写 DB 的地方。

这样引擎可以单测到 100%，而且将来想换成"独立进程跑引擎"时只换一个实现。

### 2.1 单桌并发模型

一张桌同一时刻只能有一个写者。用**乐观并发 + CAS 重试**，不引入内存锁（内存锁会破坏无状态性）：

```sql
UPDATE tables
   SET state = $1, state_version = state_version + 1, current_player = $2, deadline_at = $3
 WHERE id = $4 AND state_version = $5;
-- 影响 0 行 → 读到新状态重试（最多 3 次）
```

超时打牌、玩家落子、观战者加入，走的是同一条 CAS 路径，天然不会互相覆盖。

### 2.2 部署形态：单实例 vs 多实例

先澄清一个常见误解：**多实例首先是"多进程/多机器"，分流（负载均衡）只是它带来的结果之一。真正的成本不在分流，而在"同一张桌的两个人可能连在不同进程上"。**

#### 单实例

一个 Node 进程 + 内部 N 个插件 worker。所有 WS 连接、所有桌、所有广播都在同一份内存里。

- 好处：广播用 `EventEmitter`、presence 用 `Map`、调度器天然单例，零分布式复杂度。
- 上限：Node 单线程只能吃一个核。瓶颈依次是 ① WS 连接数（约 1 万连接 / 1–2 GB 内存）② DB 写（每步一次 CAS UPDATE）③ 引擎 CPU（桌游逻辑基本可忽略）。
- 结论：**回合制桌游，单机 4C8G 撑几百到几千在线、几十上百张活跃桌毫无压力**。这就是私人平台的常态，别提前上分布式。

#### 多实例

N 个进程（同机 cluster 或多机）+ 前置 LB。

- 目的：吃多核、滚动发布不中断、容灾、极端流量分流。
- 新增的复杂度，全部在"跨进程"上：

| 问题 | 后果 | 解法 |
|---|---|---|
| 跨实例广播 | A 连实例 1、B 连实例 2，实例 1 处理完动作，实例 2 不知道 | Redis pub/sub |
| presence | 谁在线、连在哪台 | Redis Hash + TTL |
| 计时器唯一性 | 两个实例同时扫到同一桌到期 → **重复超时打牌** | Redis zset + `SET NX` 抢单例锁 |
| 热加载生效范围 | 只在某台生效，别的实例还在跑旧版本 | 版本切换事件广播 |
| 产物共享 | 插件 bundle、头像、回放导出不在本地 | 对象存储或共享卷 |

- **好消息：不需要粘性会话（sticky session）**。局面在 DB、reducer 无状态，任何实例都能处理任何动作，断线重连落到哪台都行。这是无状态 reducer 白送的第三个红利（前两个是回放和热插拔）。
- 另一个坑：`worker_threads` 是用来**卸载插件**的，不是用来"跑满多核业务"的。真要扩，先在单机起多进程 cluster，形态上已经是多实例了。

#### 怎么选

| 场景 | 选择 |
|---|---|
| 私人平台、朋友局 | 单实例，别犹豫 |
| 单机 CPU 打满 / 要求发布零中断 | 同机 cluster 多进程（也是多实例形态） |
| 多机容灾 | 真多实例 + Redis |

### 2.3 保持不变形的"接缝"

现在不部署多实例，但**现在就把三处写成可替换接口**，将来从单机到多机只是换实现：

```ts
// packages/engine/src/bus.ts
export interface Bus {
  publish(tableId: string, msg: ServerMessage): Promise<void>;
  subscribe(tableId: string, fn: (msg: ServerMessage) => void): () => void;
}
// 单机实现：EventEmitter  多机实现：Redis pub/sub
```

| 接缝 | 单实例实现 | 多实例实现 |
|---|---|---|
| `Bus` 广播 | `EventEmitter` | Redis pub/sub |
| `Presence` | `Map` | Redis Hash + TTL |
| `TimerScheduler` | 进程内定时器 | Redis zset + `SET NX` 单例锁 |
| 会话 | JWT（本身无状态） | 同左 |
| 插件产物 | 本地目录 | 对象存储 |

**唯一纪律：业务代码永不直接 `import` Redis 或 EventEmitter，只依赖这些接口。** 守住这条，"先单机后集群"就是换实现而不是重写。

---

## 3. 插件契约（整个平台的核心）

一个插件 = 一个 zip 包：

```
six-nimmt-1.3.0.zip
├── manifest.json
├── server.js           # 游戏规则（ESM）
├── client.js           # 前端 UI（ESM，只允许引用宿主提供的依赖）
├── assets/             # 图片/音频
└── locales/
    ├── zh-CN.json
    └── en.json
```

### 3.1 manifest

```ts
// packages/sdk/src/manifest.ts
export interface GameManifest {
  id: string;                    // 'six-nimmt'，全局唯一，不可变
  name: string;
  version: string;               // semver，每次上传递增
  apiVersion: string;            // '^1.0.0' —— 依赖的插件 API 版本范围
  players: { min: number; max: number };
  modes: ('realtime' | 'turnbased')[];
  tags: string[];
  estimatedMinutes: number;
  entry: { server: string; client: string };
  assets?: string[];
  locales?: string[];
}
```

`apiVersion` 是**宿主兼容性的唯一开关**：不满足宿主当前 API 范围时，管理端标红、拒绝激活，但绝不让宿主崩溃。

### 3.2 服务端插件接口

```ts
// packages/sdk/src/game.ts
export interface GamePlugin<S extends GameState = GameState> {
  manifest: GameManifest;

  /** 发牌、洗牌、初始化。必须纯：随机数来自 ctx.rng（ seeded），时间来自 ctx.now */
  initialState(ctx: InitContext): S;

  /** BGA 风格状态机 */
  states: Record<string, StateDef<S>>;

  /** 动作处理器 */
  actions: Record<string, ActionDef<S>>;

  /** 裁剪视图：按观察者身份返回"他能看到的世界"。隐藏信息只能在这里决定 */
  view(state: S, ctx: ViewContext): PublicView;

  /** 给 UI 的可用动作提示（非权威，可返回空表示"所有动作自己试"） */
  legalActions?(state: S, playerId: PlayerId): ActionRef[];

  /** 终局计分 */
  score?(state: S): ScoreBoard | null;
}
```

状态机定义：

```ts
export interface StateDef<S> {
  /** private: 只有当事人可见的输入态；global: 全局等待；activePlayer: 等待某位玩家 */
  type: 'private' | 'global' | 'activePlayer';
  activePlayer?: 'next' | 'current' | ((s: S) => PlayerId);

  /** 进入该状态时产生的副作用 */
  onEnter?(s: S, ctx: ReduceContext): Effect[];

  /** 超时兜底：宿主到点调用，必须能产生一个合法动作（跳过/随机/自动） */
  onTimeout?(s: S, ctx: ReduceContext): ReduceResult<S>;
}
```

动作定义（**`validate` 是权威判定，`allowedIn` 是状态机路由**）：

```ts
export interface ActionDef<S> {
  allowedIn: string[];              // 只在这些状态名里可执行
  schema: z.ZodType<unknown>;       // 入参运行时校验
  validate?(s: S, a: unknown, ctx: ValidateContext): ValidationResult;
  reduce(s: S, a: unknown, ctx: ReduceContext): ReduceResult<S>;
}

export interface ReduceContext {
  playerId: PlayerId;
  players: PlayerId[];
  rng: () => number;                // 确定性随机，种子来自 state.rngSeed
  now: number;                      // 由宿主注入，插件不得用 Date.now()
  t: (key: string, args?: object) => string;
}

export interface ReduceResult<S> {
  state: S;
  effects: Effect[];
  /** 可选：显式指定下一个状态名；不填则由状态机默认流转 */
  goTo?: string;
}
```

副作用（插件唯一的"对外说话"方式）：

```ts
export type Effect =
  | { type: 'log'; key: string; args?: object; to?: 'all' | PlayerId[] }
  | { type: 'notify'; player: PlayerId; key: string; args?: object }
  | { type: 'clock'; player: PlayerId; ms: number }        // 交给宿主 scheduler
  | { type: 'sound'; key: string }                          // 客户端播放
  | { type: 'end'; ranking: PlayerId[][] };                 // 结算并算 Elo
```

### 3.3 一个真实片段

```ts
// games/six-nimmt/server.ts
const states: Record<string, StateDef<SixNimmtState>> = {
  pickCard: {
    type: 'activePlayer',
    activePlayer: 'current',
    onEnter: (s, ctx) => [{ type: 'clock', player: s.turn, ms: 30_000 }],
    onTimeout: (s, ctx) => playCard.reduce(s, { cardId: lowestCard(s, s.turn) }, ctx),
  },
  resolve: {
    type: 'global',
    onEnter: (s, ctx) => [{ type: 'log', key: 'log.reveal' }, ...applyRow(s, ctx)],
  },
};

const playCard: ActionDef<SixNimmtState> = {
  allowedIn: ['pickCard'],
  schema: z.object({ cardId: z.string() }),
  validate: (s, a, ctx) => {
    const cardId = (a as { cardId: string }).cardId;
    if (ctx.playerId !== s.turn) return { ok: false, reason: 'not.your.turn' };
    if (!s.hands[ctx.playerId].includes(cardId)) return { ok: false, reason: 'card.not.in.hand' };
    return { ok: true };
  },
  reduce: (s, a, ctx) => {
    const { cardId } = a as { cardId: string };
    const next = structuredClone(s);
    next.hands[ctx.playerId] = next.hands[ctx.playerId].filter((c) => c !== cardId);
    next.pending.push({ card: cardId, by: ctx.playerId });
    return {
      state: next,
      effects: [
        { type: 'log', key: 'log.played', args: { player: ctx.playerId } },
        { type: 'sound', key: 'card.place' },
      ],
    };
  },
};
```

### 3.4 客户端插件接口

```ts
// packages/sdk/src/client.ts
export interface GameClient<S = unknown> {
  mount(root: HTMLElement, api: ClientApi<S>): void;
  update(view: PublicView, meta: UpdateMeta): void;
  unmount(): void;
}

export interface ClientApi<S> {
  send(action: { type: string; payload?: unknown }): void;
  t(key: string, args?: object): string;
  me: PlayerId;
  players: PlayerInfo[];
  settings: Record<string, unknown>;   // 房主配置的规则选项
  sfx(key: string): void;
  log(entry: LogEntry): void;
}

export function defineGameClient(c: GameClient): GameClient { return c; }
```

**关键约束**：`client.js` 里 `import 'react'` / `import '@platform/sdk'` 会被标记为 external，运行时通过 **import map** 指向宿主已加载的那一份。这样插件永远不会打进第二份 React，也不会因为版本不同崩掉。

### 3.5 人机接口（后期做，先留口子）

设计上只有一句话：**bot 就是一个"没有 socket 的玩家"**。它提交的动作走和真人完全相同的 `validate → reduce → CAS` 通道，宿主里不允许出现 `if (isBot)` 分支。

```ts
export interface BotPolicy<S> {
  id: string;                 // 'random' | 'greedy'
  name: string;
  /** 返回一个动作；返回 null 表示本回合放弃，交给 state.onTimeout 兜底 */
  choose(ctx: BotContext<S>): { type: string; payload?: unknown } | null;
}

export interface BotContext<S> {
  /** ★ 只给裁剪后的视图。bot 永远看不到隐藏信息，后期加难度也不会变成作弊 */
  view: PublicView;
  me: PlayerId;
  legal: ActionRef[];         // 来自 legalActions
  history: LogEntry[];
  level: 'easy' | 'normal' | 'hard';
  rng: () => number;
  thinkBudgetMs: number;      // 单步思考预算，超时直接走 onTimeout 兜底
}
```

两条来源，按优先级：

1. **平台兜底 `randomLegalPolicy`**：从 `legalActions` 里随机挑一个合法动作。所有游戏零成本获得人机。
2. **插件自带策略**：插件可选导出 `bots: BotPolicy<S>[]`，作者自己写"行为优先级打分"。

所谓"给行为打优先级"的简单人机，本质上就是一个打分器，20 行：

```ts
// games/six-nimmt/bot.ts
const greedy: BotPolicy<State> = {
  id: 'greedy',
  name: '贪心',
  choose({ view, legal, rng }) {
    return legal
      .map((a) => ({ a, score: heuristic(view, a) }))  // 吃牌 +2、弃大牌 -1、卡下家 +3
      .sort((x, y) => y.score - x.score)[0]?.a ?? null;
  },
};
```

配套约定：

- 开局时房主勾选"加入 N 个人机"，在 `table_players` 插一条 `is_bot = true` 的玩家记录。
- bot 思考延迟模拟 400–1500ms，避免瞬间连走刷屏；超时直接调 `state.onTimeout`。
- 含 bot 的对局 `ranked = false`，不计 Elo（或单独记 bot 分）。
- 将来若想做更强的蒙特卡洛人机，可以直接复用"纯 reducer 可模拟推进"这一点，**不需要改任何宿主代码**。这就是要留的口子。

---

## 4. 热加载流程（核心）

```
[管理端上传 zip] 或 [games/ 目录热扫描]
        │
        ▼
1. 校验包    zip 路径穿越 / 体积上限 / manifest schema / id+version 唯一
        │
        ▼
2. 构建      esbuild 打包 client.js（external: react, react-dom, @platform/sdk）
            产物 → storage/plugins/<id>/<version>/client.<contenthash>.js
        │
        ▼
3. 静态检查  AST 扫描：禁止 Math.random / Date.now / process / require / fs / net
            禁止访问 state 以外的东西
        │
        ▼
4. 冒烟测试  起一个临时 worker，setup 一个 3 人局，随机合法动作跑 300 步
            断言：不抛错、状态可 JSON 序列化、同样输入两次 hash 相同、无私有信息进入 view
        │
        ▼
5. 激活      DB 里 status: pending → active（原子事务 + 单条 UPDATE 切指针）
            Redis pub/sub 广播 plugin.updated，其它实例失效缓存
        │
        ▼
6. 新桌可见  大厅立刻列出新游戏/新版本，无需任何重启
        │
        ▼
7. 排空旧版  旧版本 worker 继续服务"锁定旧版本的桌"
            当该版本活跃桌数 = 0 且版本已 retired → worker.terminate()
            客户端旧 bundle 保留 N 天供断线重连的桌使用，之后 GC
```

### 必须守住的不变量

| 不变量 | 为什么 |
|---|---|
| `tables.game_version` 一旦创建不可变 | 否则进行中的桌会被换掉规则 |
| 插件不得执行 DDL，只能写 `game_id` 命名空间下的 JSONB / KV | 宿主 schema 才会稳定，升级不用迁移 |
| 插件不碰 socket/DB | 才能保证可重放、可沙箱、可并行 |
| 客户端 bundle URL 含内容 hash，永久缓存 | 升级不影响旧桌，秒开 |
| 动作日志只追加不修改 | 回放/审计/申诉的唯一真相 |

---

## 5. 数据模型

```sql
-- 插件版本
CREATE TABLE game_versions (
  game_id       text NOT NULL,
  version       text NOT NULL,
  api_version   text NOT NULL,
  manifest      jsonb NOT NULL,
  client_url    text NOT NULL,
  bundle_hash   text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',  -- pending|active|retired|failed
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (game_id, version)
);

-- 桌
CREATE TABLE tables (
  id            uuid PRIMARY KEY,
  game_id       text NOT NULL,
  game_version  text NOT NULL,          -- ★ 锁版本
  status        text NOT NULL,          -- lobby|playing|finished|abandoned
  options       jsonb NOT NULL,         -- 规则选项、房主设置
  state         jsonb NOT NULL,         -- 完整局面（服务端私有）
  state_version int NOT NULL DEFAULT 0, -- CAS 用
  state_hash    text NOT NULL,          -- 确定性校验
  current_player text,
  deadline_at   timestamptz,            -- 计时器唯一真相
  created_at, started_at, finished_at timestamptz
);

-- 动作日志（只追加）
CREATE TABLE match_actions (
  table_id   uuid NOT NULL,
  seq        int  NOT NULL,
  player_id  text,
  action     jsonb NOT NULL,
  effects    jsonb NOT NULL,
  state_hash text NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (table_id, seq)
);

-- 其余：users / table_players / elo / replay_views
```

**账号**：昵称即登录名，密码用 scrypt（`scrypt$N$r$p$salt$hash`）存；JWT 里带
`ver`，和 `users.token_version` 对不上就作废——改密码、退出登录都靠它立即生效。
详见 [auth.md](./auth.md)。

**房间码**：`tables.code` 是 6 位、去掉 0/O/1/I 的码，念得清、抄得对。首页不再有
"房间列表"，只有「随便来一局 / 输房间号 / 我的对局」。

**平台侧结算**：`tables.result` 存平台自己算出来的结果（认负、解散）。`recordResult()`
优先读它，读不到才回落到插件状态里的 `ranking`——因为中途认负时插件根本没跑过结算。

**快照**：每 50 步把 `state` 存一份到 `match_snapshots`（存的是**服务端状态**，含隐藏信息，
只存库不下发）。回放超过 400 步时从最近的快照起算，至少能看到结局，而不是卡在第 400 步。

**版本公告**：`version_acks(user_id, game_id, version)`。manifest 里写 `notes`，
玩家第一次进到跑这一版的桌会强制读一次，每人对每个版本只记一条。

---

## 6. 实时协议

```ts
// 客户端 → 服务端
{ t: 'join',    tableId, as: 'player' | 'spectator', resumeFromSeq?: number }
{ t: 'action',  tableId, type, payload, clientSeq }
{ t: 'ping' }

// 服务端 → 客户端
{ t: 'snapshot', tableId, seq, view, legal, clock, players }        // 首次/落后太多
{ t: 'patch',    tableId, seq, patch, meta }                        // RFC6902 JSON Patch
{ t: 'log',      tableId, entries[] }
{ t: 'clock',    tableId, player, remainingMs }
{ t: 'ended',    tableId, ranking, stats }
{ t: 'error',    code, message }
```

- 每次状态变化 `seq++`，客户端保存 `lastSeq`。重连时带 `resumeFromSeq`，服务端补补丁；差额过大就发 `snapshot`。
- 「视图已裁剪」是安全边界：客户端在拼装 `patch` 前从未见过别人的手牌。

---

## 7. 前端结构

```
apps/web/src/
  app/            路由、布局、登录
  lobby/          游戏列表（读服务端插件目录）、开桌、加入
  table/          牌桌壳：座位、计时器、聊天、日志、观战、设置
  host/           插件运行时：加载 client.js、import map、错误边界、版本切换
  admin/          管理后台：概览、插件（上传/激活/回收）、用户
  components/     宿主 UI 库（Avatar、Timer、Chat、Confirm…）
```

管理后台不是独立应用，就是同一个 SPA 里的一个路由（`#/admin`）：只有 `isAdmin` 的人能看到入口，
前端隐藏只是礼貌，**真正的边界是每个 `/api/admin/*` 路由里的 `requireAdmin`**。详见 [admin.md](./admin.md)。

插件运行时要点：

```ts
// apps/web/src/host/loadPlugin.ts
export async function loadGameClient(gameId: string, version: string) {
  const url = `/plugins/${gameId}/${version}/client.js`;   // 内容 hash，可强缓存
  const mod = await import(/* @vite-ignore */ `${url}?v=${version}`);
  return mod.default as GameClient;
}
```

- `index.html` 里注入 import map，把 `react`、`react-dom`、`@platform/sdk` 映射到宿主自己那份 ESM 产物。
- 插件崩溃用 ErrorBoundary 兜住，显示"重连"而不是白屏。
- 观战者复用同一个 `view`，只是 `me = spectator`，`legal = []`。

---

## 8. 确定性约束（决定项目成败的细节）

| 约束 | 做法 |
|---|---|
| 不用 `Math.random()` | `ctx.rng()`，种子存在 `state.rngSeed` 里，随状态持久化 |
| 不用 `Date.now()` | `ctx.now`，由宿主注入并随动作落库 |
| 分数用整数 | 避免浮点在重放中漂移 |
| 遍历顺序稳定 | 一律排过序再遍历，禁止依赖 `Object.keys` 插入序做规则判定 |
| 每步算 `state_hash` | 加载时重放校验，发现插件不纯立即降级该版本 |
| 版本固定 | 回放永远用当时的 `game_version` 加载插件 |

**静态检查 + 冒烟测试**是双保险：前者拦住"用了全局随机"，后者拦住"逻辑上不纯"。

---

## 9. 计时器与超时

**回合制为主的直接红利**：一张桌同一时刻只有一个 `deadline_at`，计时模型极简——不需要并发事件、不需要游戏内实时时钟、不需要帧同步。整局的节奏就是"当前玩家 → 动作 → 下一个玩家"，卡住就超时替他走一步。

如果要加**异步长局（correspondence）**，也只是把 `options.deadlineMs` 从 60s 拉到几小时/几天，加一个"轮到你"的通知，核心结构不动。

计时器**不能**只存在内存里（否则重启就丢）：

1. 动作提交时把 `deadline_at` 写进 `tables`，同时 `ZADD timers <deadline_ms> <table_id>`。
2. 调度器轮询到期项 → 调 `table.forceTimeout(tableId)` → 走与普通动作完全相同的 CAS 路径。
3. 服务启动时 `SELECT id, deadline_at FROM tables WHERE status='playing'` 重建 zset。
4. CAS 失败说明玩家刚好落子，直接丢弃超时任务（这就是为什么超时必须走 CAS 而不是直接执行）。

---

## 10. 目录结构

```
platform/
├── apps/
│   ├── server/           # Fastify + WS + 插件宿主 + 引擎装配
│   └── web/              # React 宿主
├── packages/
│   ├── sdk/              # 插件契约（server/client 共享类型 + Zod schema）
│   ├── engine/           # 纯函数状态机推进、校验、视图裁剪（零 I/O）
│   ├── plugin-host/      # 构建、静态检查、worker 池、版本管理
│   ├── protocol/         # WS 消息 schema，前后端共用
│   └── ui/               # 宿主共用组件
├── games/
│   ├── tictactoe/        # 最小示例：验证契约
│   └── six-nimmt/        # 真实游戏：验证状态机 + 隐藏信息
├── storage/plugins/      # 构建产物（gitignore）
└── docs/
```

新游戏 = `games/` 下加一个目录 + `pnpm game:pack` 打成 zip + 管理端上传。**不动宿主一行代码**。

---

## 11. 里程碑

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| **M0** 骨架 | monorepo、认证、大厅、单桌 WS、假游戏（骰子） | 两人能开桌玩完一局 | ✅ |
| **M1** 契约 | `sdk` + `engine` + 表 actor + 计时器 + 首个真游戏 | 动作、超时、断线重连、复盘全通 | ✅ |
| **M2** 热加载 | 上传/构建/冒烟/激活/排空、管理端（含 worker 隔离与回收） | 运行中上传 v2，旧桌不停，新桌用 v2，全程不重启 | ✅ |
| **M3** 体验 | 聊天、观战、回放、Elo、i18n、音效、移动端 | 一局完整流程可对外邀请 | 🟡 聊天/观战/回放/Elo 完成，i18n/音效/移动端未做 |
| **M4** 人机 | `BotPolicy` 接口 + 兜底随机人机 + 首个插件贪心策略 | 单人也能开局，动作走同一通道 | ✅ |
| **M5** 加固 | worker 超时/内存熔断、限流、日志、备份、监控 | 插件死循环不拖垮宿主 | ✅ 提前完成 |

**建议 M2 提前到 M1 之后立刻做**：热加载是这套架构的最大卖点，越早跑通越早暴露契约设计问题。

---

## 12. 风险清单

1. **隐藏信息侧信道**：`view` 裁剪不彻底、日志文案泄漏、`legalActions` 暴露手牌。→ 每插件强制跑"观战者视角不含任何私有字段"的断言测试。
2. **插件不确定性**：一旦用了全局随机，回放/复现全废。→ AST 拦截 + hash 校验 + 失败自动降级。
3. **模块缓存泄漏**：动态 `import()` 无法真正卸载。→ 用 worker 而非 `?v=` cache bust 做隔离。
4. **信任模型**：插件由内部人员上传，**按可信代码处理**。worker 隔离的目的不是防恶意代码，而是 ① 旧版本代码能真正卸载 ② 插件崩溃/死循环不拖垮宿主 ③ 确定性校验有独立容器。AST 扫描保留，但理由是"保证确定性"，不是"防攻击"。将来若开放外部上传，才需要升级为独立子进程 + `--permission` 或容器。
5. **插件 API 破坏性变更**：宿主必须保留 N-1 兼容层，或明确"只保证当前大版本"。
6. **日志表膨胀**：按 `finished_at` 分区归档，快照压缩。
7. **时钟漂移**：所有时间比较用服务端 `now`，客户端只做展示性倒计时。

---

## 13. 尚未决定

已定的四条见文首「已定决策」，不重复。剩下这些不影响 M0–M2 开工：

- **异步长局（correspondence）要不要做？** 现在按"同桌在线、60s/步"设计，`tables.options` 已预留 `mode` 与 `deadlineMs`。真要做，主要补"轮到你"的通知（Web Push / 邮件）和更长的截止时间，核心结构不用动。
- **多实例什么时候上？** 见 §2.2。单机够用就不动，但 `Bus`/`Presence`/`TimerScheduler` 三个接口现在就要留好。
- **Elo 是否分游戏、是否支持让分？** 建议先按游戏分表，让分功能等有数据再说。
- **观战和回放谁先做？** 建议回放先（几乎白送，重放 action 即可），观战次之。
- **插件包要不要签名？** 内部上传可先不做，只记录上传人和 sha256；将来要放开再说。
