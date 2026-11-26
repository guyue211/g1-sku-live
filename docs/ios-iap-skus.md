# iOS 内购 SKU 实测清单

口径：**5x = 20TB**，**20x = 30TB**。

数据来源不是猜的，是三方独立实测：

1. **iOS 侧实测目录** —— `lqvp/google-ai-pro-2y` 的 `docs/IOS-EXPERIMENTS.md`（2026-11-25）。用 mitmproxy 解 iPhone 的 HTTPS，从 `one.google.com/ai` 的约 1.2 MB HTML 里抠出 11 条 SKU。
2. **Play 侧爆破扫描** —— `Dgkncn/g1-acq-plus` 的 `sku-catalog.json`，15,000+ 候选命名组合扫出 124 个命中。
3. **Android 抓包** —— 本项目作者在 MuMu 模拟器里抓的 `GetDynamicStorefront`（270 KB）+ App 本地 `StoragePlansDataCache.db`，13 个商品逐条解析 offer。

## 一、iOS 实测 SKU 全表（11 条）

| SKU | 周期 | 内容 |
|---|---|---|
| `g1.ios.ai.2tb.m.ip_1mo_90p.acq` | 月付 | 首月 90% off |
| `g1.ios.ai.2tb.a.ip_1yr_10p.acq` | 年付 | 1 年 10% off |
| `g1.ios.helium.m.1month_ip_90p.acq` | 月付 | 首月 90% off |
| `g1.ios.helium.a.ip_1yr_10p.acq` | 年付 | 1 年 10% off |
| `g1.ios.2tb.m.3month_ip_75p` | 月付 | 3 个月 75% off |
| `g1.ios.100gb.m.3month_ip_75p` | 月付 | 3 个月 75% off |
| `g1.ios.2tb.a.12month_ip_15p` | 年付 | 12 个月 15% off |
| `g1.ios.100gb.a.12month_ip_15p` | 年付 | 12 个月 15% off |
| `g1.ios.20tb.m.v2` | 月付 | **Ultra 20TB 入口（无优惠）** |
| `g1.ios.30tb.ai.pro.m` | 月付 | **Ultra 30TB 入口（无优惠）** |
| `com.google.one.generic` | — | 通用 |

命名规则：`g1.ios.<tier>.<m\|a>.<期间>_ip_<折扣>p[.acq]`

- `m` / `a` = 月付 / 年付
- `ip_90p` = 90% off，`15p` = 15% off
- `.acq` = 获取型促销标记
- `helium` / `ai.2tb` / `100gb` 是 iOS 独有的 tier 写法

## 二、iOS 与 Android 不是同一套编号

| | iOS | Android |
|---|---|---|
| 前缀 | `g1.ios.` | `g1.` / `g1.play.` |
| tier 词序 | `ai.2tb`（容量在后） | `2tb.ai`（容量在前） |
| 免费试用 | **目录里没有 `_eft`** | `_eft` 大量存在 |
| 折扣 | `_ip_` | `_ip_` |

iOS 的 ID 和 Android 的 ID **不互通**。名字像也不是同一个商品。

## 三、结论：5x / 20x 在 iOS 上没有任何试用或折扣编号

三条独立证据都指向同一件事：

- **iOS 实测**：20TB / 30TB 只有入口编号 `g1.ios.20tb.m.v2`、`g1.ios.30tb.ai.pro.m`，没有任何 `_ip_` 或 `_eft` 变体。
- **Play 爆破**：124 个命中里，`g1.20tb` / `g1.ai.pro` / `g1.play.20tb` / `g1.play.ai.pro` 全部只是裸入口 SKU，无 offer 变体。而 `_eft` 全部集中在 `100gb` / `200gb` / `2tb` / `30gb` / `2tb.ai` 上。
- **Android 抓包**：`g1.20tb.v2` 的 basePlan 是 `p1m`，`g1.ai.pro` 是 `monthly`，两者 `subscriptionOfferDetails` 为空 —— 一个 offer 都没有。

所以「0 元试用」和「一折」的那几个 Ultra 编号拉不起来，不是配置错，不是编号退役，是**这些编号在 iOS 目录里从来没存在过**。

`g1.20tb.1month_eft.acq` / `g1.ai.ultra.1month_eft.acq` 的来源是上游 PR #3，按 Android 的 `_eft` 语法拼出来的；`lqvp` 的实测文档直接点名：`g1.20tb.1month_eft.acq` は実測カタログに存在しない ID。

## 四、iOS 上真正的 0 元是账号授予，不是 SKU

`lqvp` 实测拿到过 Ultra 1 个月免费，但同页明确写：

> **書き換えは一度も実行されていない。**（改写一次都没执行）

- 改写只在 `one.google.com/ai` 被重新拉取时才生效，而 App 从 WebView 缓存读，日志里 `REWRITE` 行 0 条；
- 那次成功是**账号本身就有这个 offer**，加上支付路径修好之后正常出单。

也就是说：iOS 的 Ultra 免费试用是**账号个例**，不是可以靠改 SKU 造出来的。

## 五、最要紧的坑：Apple 支付域名不能 MITM

`lqvp` 那篇里最关键的一句：

> 原因は Apple の決済エンドポイント（`bag.itunes.apple.com`、`gateway.icloud.com`）がピニングで MITM を拒否していたこと。プロキシ経由では購入自体が不可能だった。

Apple 的支付端点有证书 pinning。**只要 MITM 到 `*.apple.com` / `*.icloud.com`，购买就必然失败**，报 "Unable to Complete Purchase"。

对应到本插件：

```
[MITM]
hostname = %APPEND% one.google.com
```

只加 `one.google.com`，**不要**把 `apple.com` / `icloud.com` 加进去。如果你之前为了抓 Apple 的接口把它们加进了 MITM 列表，那就是"点升级没反应"的直接原因。

mitmproxy 侧对应 `--ignore-hosts '^(.*\.)?apple\.com:443|^(.*\.)?icloud\.com:443'`。

## 六、真正能拿到长免费的是 Pro 5TB，不是 Ultra

Play 侧实测有效的 `_eft`（`sku-catalog.json` 124 条命中）：

| SKU | 免费时长 |
|---|---|
| `g1.2tb.ai.12months_eft` | 12 个月 |
| `g1.2tb.ai.6months_eft` | 6 个月 |
| `g1.2tb.ai.3months_eft` | 3 个月 |
| `g1.2tb.ai.2months_eft` | 2 个月 |
| `g1.2tb.1year_eft` / `g1.2tb.6months_eft` / `g1.2tb.3months_eft` / `g1.2tb.1month_eft` | 1 年 / 6 / 3 / 1 个月 |
| `g1.100gb.1year_eft`、`g1.200gb.1year_eft` 等 | 1 年 |

`lqvp` 用 `g1.2tb.ai.subs_variant` 的四个 offer 叠到 **730 天（2 年）**：`12months-eft` → `6months-eft` → `6months-eft-2`，第四步 `6months-eft-ss-2026` 被 Play 拒绝。

但这些都是 **Android / Play** 的编号。iOS 侧要对应，只能用 `g1.ios.*` 那一套 `_ip_` 折扣：

| iOS 目标 | 内容 |
|---|---|
| `g1.ios.ai.2tb.m.ip_1mo_90p.acq` | 首月一折 |
| `g1.ios.2tb.m.3month_ip_75p` | 3 个月 2.5 折 |
| `g1.ios.2tb.a.12month_ip_15p` | 年付 15% off |

## 七、证据等级

| 结论 | 等级 |
|---|---|
| iOS 11 条 SKU 清单 | 第三方实测（lqvp，2026-11-25），可复现 |
| Ultra 无 offer | 三方独立一致（iOS 实测 / Play 爆破 / Android 抓包） |
| iOS 无 `_eft` | 第三方实测 |
| `1month_eft.acq` 不存在 | 第三方实测点名 + 爆破扫描无命中 |
| Apple 支付域名 pinning | 第三方实测（MITM 即购买失败） |
| iOS 0 元是账号授予 | 第三方实测（改写未执行仍拿到） |
