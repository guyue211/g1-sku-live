# iOS 侧 SKU — 5x / 20x 的 0 元与低价试用

口径：**5x = 20TB**，**20x = 30TB**。

## 1. 对应关系

| 档位 | 商品 | iOS 入口编号 | Android 对应 |
|---|---|---|---|
| **5x** | Google AI Ultra (20 TB) | `g1.ios.20tb.m.v2` | `g1.20tb.v2` |
| **20x** | Google AI Ultra (30 TB) | `g1.ios.30tb.ai.pro.m` | `g1.ai.pro` |
| 旧 20x | Ultra 30TB 早期编号 | `g1.ios.30tb.m` | — |
| Pro | Google AI Pro (5 TB) | `g1.ios.2tb.*`（前缀） | `g1.2tb.ai.subs_variant` |

`g1.ios.` 前缀 + `<档>.<周期>` 是 iOS 服务端下发的商品编号族；Android 那边是 `g1.<档>` 或 `g1.play.<档>`，两套不通。

## 2. 实测：Ultra 两档**原生没有试用**

从 MuMu 里抓到的 `GetDynamicStorefront`（270KB，本账号 US 区）逐商品解析 offer：

| SKU | basePlanId | offer | 计费阶段 |
|---|---|---|---|
| `g1.20tb.v2` (5x) | `p1m` | **无** | US$99.99 / P1M |
| `g1.ai.pro` (20x) | `monthly` | **无** | US$199.99 / P1M |
| `g1.10tb` | `p1m` | 无 | US$49.99 / P1M |
| `g1.2tb.ai.subs_variant` (Pro) | `monthly` | `12months-eft` | **免费 P1Y** → US$19.99/P1M |
| 同上 | `monthly` | `6months-eft` / `-2` / `-ss-2026` | 免费 P6M → US$19.99/P1M |

结论：**免费试用（`eft`）全部挂在 Pro 5TB 上，Ultra 两档一个都没有。** 所以 5x/20x 想要 0 元，只能把入口编号改写成带试用的目标编号，不能指望 Ultra 自己的 offer。

## 3. iOS 目标编号

### 0 元试用

| 入口 | 目标 | 内容 | 来源 |
|---|---|---|---|
| 5x `g1.ios.20tb.m.v2` | `g1.20tb.1month_eft.acq` | 1 个月免费 | g1-acq PR #3 |
| 20x `g1.ios.30tb.ai.pro.m` | `g1.ai.ultra.1month_eft.acq` | 1 个月免费 | g1-acq PR #3、g1-ultra-trial |

`eft` = extended free trial，`acq` = acquisition（获取档）。目前社区流通的 Ultra 0 元档**只有 1 个月这一档**，没有 3 / 6 / 12 个月的 Ultra 免费。

### 低价（首期减免）

| 入口 | 目标 | 内容 |
|---|---|---|
| 5x | `g1.20tb.3months_ip_90p.acq` | 3 个月 90% off（一折） |
| 5x | `g1.20tb.3months_ip_75p.acq` | 3 个月 75% off（2.5 折）← 当前默认 |
| 20x | `g1.ai.ultra.3months_ip_90p.acq` | 3 个月 90% off（一折） |
| 20x | `g1.ai.ultra.3months_ip_75p.acq` | 3 个月 75% off ← 当前默认 |

`ip` = intro price，`90p` / `75p` = 减免百分比。

### Pro 路线（更便宜，但不是 5x/20x 权益）

| 入口 | 目标 | 内容 |
|---|---|---|
| `g1.ios.2tb.*` | `g1.2tb.ai.12months_ip_90p` | 12 个月 90% off（一折，无 `.acq`） |
| `g1.ios.20tb.m.v2` | `com.google.gemini.2tb.ai.m.3month_ip_99p` | 3 个月 99% off（g1-pro-tr，未验证） |

## 4. 土区实际标价（App Store 公开列表）

Google Gemini App（`com.google.gemini`），土区：

| 商品 | 价格 | ≈ 人民币 |
|---|---|---|
| Google AI Pro (5 TB) | ₺869.99 | ¥149 |
| Google AI Pro (5 TB) 年付 | ₺539.99 | ¥92 |
| Google AI Plus (2 TB) | ₺359.99 | ¥62 |
| Google AI Plus (400 GB) | ₺199.99 | ¥34 |
| 100 GB | ₺84.99 | ¥15 |

**土区列表里没有 Ultra**（美区 / 英区有：Ultra 30TB $199.99 / £189.99）。这正是"入口点 Ultra 5x、实际到手 Pro"的成因：土区买不到 Ultra，但入口编号仍在响应里，改写成 Pro 的折扣档就能出单。

折扣折算（按 ₺869.99 基准）：

| 折扣 | 实付 | ≈ 人民币 |
|---|---|---|
| 99p | ₺8.70/月 | **¥1.49** |
| 90p | ₺87.00/月 | ¥14.88 |
| 75p | ₺217.50/月 | ¥37.19 |

g1-pro-tr README 写的"10 TRY/月 ≈ ¥1.3"与 99p 折算对得上（₺8.70）。算术没错。

## 5. 建议配置

0 元优先（各 1 个月）：

```
g1.ios.20tb.m.v2      -> g1.20tb.1month_eft.acq
g1.ios.30tb.ai.pro.m  -> g1.ai.ultra.1month_eft.acq
```

要更长就换低价档（3 个月一折）：

```
g1.ios.20tb.m.v2      -> g1.20tb.3months_ip_90p.acq
g1.ios.30tb.ai.pro.m  -> g1.ai.ultra.3months_ip_90p.acq
```

要最省钱、不在乎档位，走 Pro 12 个月一折：

```
g1.ios.2tb.           -> g1.2tb.ai.12months_ip_90p
```

## 6. 证据等级

| 编号 | 等级 |
|---|---|
| `g1.ios.20tb.m.v2` / `g1.ios.30tb.ai.pro.m` | 社区默认源编号，多模块在用 |
| `*.1month_eft.acq` | PR #3 贡献者提供，声称 1 个月免费试用成功；未独立复现 |
| `*.3months_ip_90p.acq` / `_75p.acq` | 同上，作为默认/备用长期在流通 |
| `g1.ios.30tb.m` | 旧编号，历史记录曾调起 ₺2,949.99；当前土区列表已无 Ultra |
| `com.google.gemini.2tb.ai.m.3month_ip_99p` | g1-pro-tr 自述，**无第三方证据** |

两条硬约束：

1. 这些 `.acq` 目标必须真的被 iOS 服务端下发过才可能出单。模块报告页的 `targetObserved=false` 就是"服务端没发过这个编号"的信号，此时改写等于把未知 ID 塞给收银台。
2. 字符串改写的命中 ≠ App Store 面板价格变化。价格以收银台实际显示为准，权益以 Google One 账户页为准。
