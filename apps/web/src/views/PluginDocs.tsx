import type { ReactElement } from 'react';

/** 极简排版：空行分段、`## ` 小标题、`- ` 条目、``` 代码块 */
function render(text: string): ReactElement[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      if (block.startsWith('```')) {
        const body = block.replace(/```[a-z]*\n?/, '').replace(/```$/, '');
        return (
          <pre key={index} className="docs-code">
            {body.trim()}
          </pre>
        );
      }
      if (block.startsWith('## ')) {
        return (
          <h2 key={index} className="docs-h2">
            {block.slice(3)}
          </h2>
        );
      }
      const lines = block.split('\n').map((line) => line.trim());
      if (lines.every((line) => line.startsWith('- '))) {
        return (
          <ul key={index} className="intro-list">
            {lines.map((line, itemIndex) => (
              <li key={itemIndex}>{line.slice(2)}</li>
            ))}
          </ul>
        );
      }
      return <p key={index}>{lines.join(' ')}</p>;
    });
}

const CONTENT = `# 插件开发文档

一个游戏 = 一个插件目录，放进 \`games/\` 或者打成一个 zip 上传，**不需要重启服务器**。

## 目录长什么样

\`\`\`
my-game/
  manifest.json      # 元信息：名字、人数、节奏、介绍
  src/
    server.ts        # 规则：纯函数 reducer，跑在 worker 里
    client.ts        # 界面：自己画，自己管状态
\`\`\`

## manifest.json 要填什么

\`\`\`json
{
  "id": "my-game",
  "name": "我的游戏",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "players": { "min": 2, "max": 4 },
  "modes": ["realtime", "turnbased"],
  "tags": ["卡牌", "策略"],
  "estimatedMinutes": 20,
  "description": "一句话简介，大厅卡片上显示",
  "intro": "详情页的介绍：空行分段，## 是小标题，- 是条目",
  "realtime": { "fast": 40, "normal": 120, "slow": 300 },
  "notes": ["这一版改了什么，玩家第一次进桌会看到"]
}
\`\`\`

字段说明：

- \`id\` 全局唯一、不可变，只能小写字母/数字/连字符
- \`version\` semver。**发新版必须升这个号**，老桌会继续锁着老版本打完
- \`players\` 支持的人数范围；开桌时座位数在这个区间里选
- \`modes\` 支持哪些节奏：\`realtime\`（即时）、\`turnbased\`（回合制）。只写一个也行
- \`estimatedMinutes\` 预估时长，大厅和详情页展示用
- \`description\` / \`intro\` 介绍文案，可省略（详情页会显示"还没写介绍"）
- \`realtime\` **即时制的三档每步时长（秒）**，不同游戏差别很大，所以由插件自己定。
  不填时平台默认 快 20 / 中 45 / 慢 90
- \`notes\` 更新公告：玩家第一次进到跑这一版的桌时会强制读一次

## 两种节奏怎么跑

**即时制**：开桌就等开打，超时由平台自动替你走一手；连续 3 次超时判负。
一个人同一时间只能在一个即时房间里，房间里没有"回大厅"——退出就是认负。

**回合制**：桌会一直等你。节奏按"每天能走几下"选：24 / 12 / 8 / 4 / 2 / 1 回合每天、
2 天一动，或者无限（无限档按友谊赛处理，不计 Elo、不记战绩）。
还可以限定"每日可行动时段"：

- 玩家在自己的时区选时间段（比如 19:00–23:00）
- 平台按 **UTC** 存（当天第几分钟），显示时再转回玩家本地时间
- 到点时刻落在时段外会自动顺延到下一个时段开始，不会因为凌晨三点被扣超时

## 服务端要写什么

只写规则，不碰数据库、不碰 socket：

- \`createState\` 用一个种子建局，**之后所有随机都从 state 里取**，保证可回放
- \`validate\` / \`reduce\` 校验和改状态，纯函数，同样的输入永远同样的输出
- \`view(state, viewer)\` 决定每个人能看见什么（隐藏信息在这里挡）
- \`onTimeout\` 超时替玩家走一手（不实现的话这张桌就不设计时器）
- \`legalMoves\`（可选）给出带参数的合法动作，UI 靠它做高亮

提交给平台之前会做三件事：同一个种子跑两遍比对状态哈希、扫一遍服务端代码里
有没有 \`Date.now()\`/\`Math.random()\` 这类不确定来源、跑一遍冒烟。

## 怎么提交

把游戏目录打成 zip，发到 **2087355993@qq.com**，或者让管理员在
「管理后台 → 插件 → 上传插件包」直接上传。

上传后平台自动：校验 manifest → 构建 → 冒烟 → 原子改名进 storage → 激活，全程不重启。
`;

export function PluginDocs({ onBack }: { onBack: () => void }) {
  return (
    <div className="lobby docs-page">
      <header className="topbar">
        <button className="ghost" onClick={onBack}>
          ← 大厅
        </button>
        <div className="title">插件开发文档</div>
      </header>
      <article className="docs-body">{render(CONTENT)}</article>
    </div>
  );
}
