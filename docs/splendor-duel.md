# 璀璨宝石：对决（Splendor Duel）插件

规则来源：根目录 `SCSPL2P01EN_Rules_Planche_BD.pdf`。

卡表来源：开源仓库 `sone359/Splendor_Duel`：

- `data/info_cartejoaillerie`：67 张 Jewel 卡（30 张 1 级、24 张 2 级、13 张 3 级）
- `source/Back/partie.cpp`：4 张 Royal 卡（2 分偷 token / 2 分拿特权 / 2 分再来一回合 / 3 分无效果）

## 实现结构

```
games/splendor-duel/
  manifest.json
  src/cards.ts      # 静态卡表
  src/server.ts     # 回合、拿 token、购买、能力、Royal、预购可见
  src/client.ts     # 金字塔 / 5×5 宝石版图 / 双方面板
```

## 房规：预购可见窗口

官方规则是对手始终看不到预留牌。用户要求：

- 某人预购一张卡后，对手在**预购当回合 + 对手接下来的整个回合**都能看到牌面；
- 到预购者下一次回合开始时翻回背面。

实现：每张预留卡记录 `publicUntilTurn = 预购时 turnSeq + 2`；`view` 里
`viewer === owner` 或 `publicUntilTurn > turnSeq` 时给牌面，否则只给牌背/张数。
观战者按同一公开状态处理。

## 已实现的规则

- 可选动作：用特权（可一次用多张）、补版图；各最多一次，且特权必须在补版图之前。
- 强制动作：拿 1–3 个连续相邻非金 token、拿 1 金 + 预留、购买。
- 3 同色或 2 珍珠给对手特权；金只能通过预留获得。
- 5×5 版图，中心螺旋补版图；袋空不能补。
- 3 张特权；需要特权但没有时从对手拿；已有 3 张则无事。
- 预留上限 3；对手只看到张数/公开窗口内的牌面。
- 金万能；购买时自动先用本色 token、再用金补缺口；花掉的 token 回袋。
- 复制色卡购买时必须选一个已有奖励色；分数和奖励归入该色。
- 第 3/6 个皇冠拿 Royal；Royal 效果：偷 token / 拿特权 / 再来一回合 / 无。
- 回合结束弃到 10 个 token，然后检查 20 分 / 10 皇冠 / 同色 10 分。
- 平局规则不适用（先满足条件的人立即赢）。

## v1 取舍

- 皇家卡能力已按开源仓库核对；如果后续实物有差异，改 `cards.ts`。
- 数字版不显示实体卡面，全部 CSS 绘制。
- 预留牌可见窗口是房规，不是官方规则。

## 测试

`tests/splendor-duel.test.ts`：卡表 67 张、拿 token 直线/特权、购买与 Royal、
预购可见窗口的时序。
