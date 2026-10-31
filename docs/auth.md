# 账号：注册 / 登录 / 改密码

> 从"输个昵称就能进"升级成真正的账号体系。核心只有一句话：
> **昵称是登录名，密码用 scrypt 存，令牌版本决定它什么时候失效。**

## 1. 为什么不能停在昵称登录

旧版本 `POST /api/auth/login {name}` 会 `findOrCreateUser`，也就是说：

- 任何人输入 `管理员` 就是管理员（第一个注册的是 admin）
- 换个浏览器输同一个昵称，身份就跟着走
- 没有任何"这个人是不是他"的判断

在内网、几个人自娱自乐时能忍；一旦要发链接给朋友、或者在意战绩和 Elo 的真实性，就必须有密码。

## 2. 表结构（迁移 `005_auth.sql`）

```sql
ALTER TABLE users ADD COLUMN password_hash  text;
ALTER TABLE users ADD COLUMN password_set_at bigint;
ALTER TABLE users ADD COLUMN last_login_at  bigint;
ALTER TABLE users ADD COLUMN token_version  integer NOT NULL DEFAULT 0;
```

- `password_hash` 为空 = 旧版本留下的账号（还没设过密码）
- `password_set_at` 有值 = 这个账号设过密码。用它而不是 `password_hash IS NOT NULL`
  判断，是为了以后换算法时语义不变
- `token_version` 见 §4

## 3. 密码怎么存

`apps/server/src/password.ts`，用 Node 内置的 **scrypt**：

```
scrypt$N$r$p$salt$hash        # 例：scrypt$16384$8$1$<16B b64url>$<32B b64url>
```

选它的理由：

| | scrypt | bcrypt | argon2 |
|---|---|---|---|
| 需要原生依赖 | 否（`node:crypto`） | 是 | 是 |
| 内存硬（抗 GPU） | 是 | 否 | 是 |
| Windows 零编译 | 是 | 要工具链 | 要工具链 |

参数 `N=16384, r=8, p=1`，一次校验约 30–40ms、占 16MB 内存——挡得住离线撞库，又不至于让登录明显变慢。

参数写在哈希串里，将来调参不用迁移数据。校验用 `timingSafeEqual`，密码先做 `NFKC` 归一化（避免全角/半角、组合字符导致的"看着一样登不上"）。

**强度规则只在注册/改密时校验**，登录时不校验——否则某天收紧规则，会把老用户锁在门外：

- 8–128 位
- 不能等于昵称
- 不能全是同一个字符
- 不在常见弱口令表里

## 4. 令牌怎么失效（`token_version`）

JWT 是无状态的，签出去就收不回来。但只要在库里放一个版本号，就能随时作废：

```
签发：token 里带 ver = users.token_version
校验：requireUser() 读库比较 auth.ver === user.token_version，不等就 401
```

于是：

- **改密码** → `token_version + 1` → 所有旧设备立刻掉线，当前设备换新令牌
- **退出登录** → `token_version + 1` → 被抄走的令牌当场作废（不只是前端删 localStorage）
- 老令牌没有 `ver` 字段，按 `0` 处理，正好等于默认值——升级不会把已有会话踢下线

过期时间：不勾「记住我」12 小时，勾了 30 天。WS 在**建立连接时**校验一次，长连接不会被中途踢掉（下一版可以加定期续验）。

## 5. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/config` | 认领通道是否开着（运维/工具用的能力探测） |
| `POST` | `/api/auth/register` | `{name, password, confirm?, code?}` → `{token, user}`；`code` 选填 |
| `POST` | `/api/auth/login` | `{name, password, remember?}` → `{token, user}` |
| `POST` | `/api/auth/claim` | 给旧账号补密码，见 §6 |
| `POST` | `/api/auth/password` | 改密码 `{oldPassword, newPassword}` → 新令牌 |
| `POST` | `/api/auth/logout` | 作废令牌 |
| `GET` | `/api/me` | 当前用户 |
| `GET` | `/api/me/invite` | `{code, createdAt, invited[]}`：我的邀请码和我拉来的人 |
| `POST` | `/api/me/invite` | 生成我的邀请码；**只能生成一次**，已有则 409 |

错误码（前端靠它决定走哪个流程，不靠文案）：

| code | HTTP | 含义 |
|---|---|---|
| `invalid_credentials` | 401 | 昵称或密码不对（账号不存在也用这个，不泄露"这个昵称在不在"） |
| `password_not_set` | 409 | 老账号还没设密码 → 前端自动切到「设置密码」 |
| `name_taken` | 409 | 注册时昵称被占 |
| `weak_password` | 400 | 密码不合规 |
| `claim_unavailable` | 409 | 这个昵称没有可认领的账号 |
| `bad_code` | 403 | 邀请码填了但对不上任何人 |
| `invite_exists` | 409 | 邀请码已经生成过，不能改 |

## 5.1 邀请码

**邀请码是社交机制，不是门禁。** 注册不填码照样能注册；填了就把「谁邀请的」记下来，用户在个人中心能看到自己邀请的人。

```
注册   → 系统自动生成一个 8 位个人邀请码（31 进制，去掉 0/O/1/I/L）
老账号 → 上线前注册的人 invite_code 为 NULL，可在个人中心生成一次
约束   → 只能生成一次：UPDATE ... WHERE invite_code IS NULL，并发点两次也只写一次
注册时 → 填了码就校验，对不上报 bad_code；对上了把 invited_by 记成邀请人的 user id
```

为什么不用"邀请码 = 准入"：那样第一个用户永远进不来（没人发码给他），要么留后门、要么手工插库。现在开放注册 + 记录来源，两个问题都没有了。

## 6. 老账号怎么办

升级前用昵称登录过的账号没有密码。三种处理：

1. **自助认领**（默认）：登录时提示 `password_not_set`，前端切到"设置密码"，设完就沿用**原来的 user id**——战绩、Elo、历史对局全都在。
2. **管理员重置**：直接在库里把 `password_hash` 置空，再让对方认领。
3. **关掉认领**：`AUTH_ALLOW_CLAIM=0`。

> ⚠️ 认领窗口的代价要说清楚：知道昵称的人可以先一步把账号占走。这与升级前的安全性**等价**（那时谁都能输这个昵称进来），不是退步，但它是个有限窗口。
> 建议：上线后把在意的账号都认领/设密一遍，然后 `AUTH_ALLOW_CLAIM=0`。

## 7. 限流

| 桶 | 维度 | 额度 | 防什么 |
|---|---|---|---|
| `login` | IP | 20 / 分钟 | 批量注册、单机撞库 |
| `loginFailure` | 账号名 | 5 / 5 分钟 | **换 IP 接着撞同一个账号** |

只有账号名这一维是必须的：IP 是攻击者可以换的，账号名不是。这个桶只在校验密码失败时扣，登录成功立即清零，所以正常用户永远碰不到。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JWT_SECRET` | `dev-secret-change-me` | **上线必须改**。改了等于所有旧令牌失效 |
| `AUTH_ALLOW_CLAIM` | 开 | `0` 关闭旧账号自助认领 |

> `REGISTER_CODE` 已经废弃：邀请码改成每人一个、且注册不再需要它。留着这个变量不会有任何效果。

## 9. 已知取舍

- **没有邮箱/短信**：找不回密码，只能管理员重置。私人平台够用，也免掉了一整套发信设施。
- **退出登录 = 所有设备退出**：令牌是无状态的，作废就是整版本作废。想只退当前设备，需要给每个会话单独一个 id + 黑名单。
- **WS 只在握手时校验**：改密码不会切断已建立的连接，只影响新连接和 HTTP 请求。
- **限流在进程内存里**：多实例部署时需要换成 Redis（接口不变）。
