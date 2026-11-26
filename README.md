# G1 SKU Live · Loon 插件

探测 Google One（iOS）真正下发的 SKU。解决一个具体问题：**改写的目标编号已经退役，但现象和"配置写错"一模一样——点升级，价格不动。**

这个插件把判断依据摊开：服务端到底下发过哪些编号、你手上那个候选编号在不在里面。

## 文件

| 文件 | 作用 |
|---|---|
| `g1-sku-live.plugin` | Loon 插件本体，装这一个 |
| `g1-sku-live.js` | 单文件脚本，同时挂在 http-request 与 http-response |
| `test/run.cjs` | node 测试，16 项 |

一个文件同时注册两次：请求阶段负责给报告页本地应答，响应阶段负责采集改写 + 报告页兜底。这样任一侧能力不可用，报告页都打得开。

## 安装（一个固定地址，长期用这一条）

```
https://ghproxy.net/https://raw.githubusercontent.com/guyue211/g1-sku-live/main/g1-sku-live.plugin
```

Loon 里：**配置 → 插件 → 添加 → 从 URL 添加**。

**以后更新不用删了重加。** 我在仓库推了新版本，你在 Loon 插件页对这个插件下拉刷新（或点更新）就会重新拉取脚本。

不用 jsDelivr：它的 `@main` 缓存清不掉，`purge` 之后还发旧版，只能靠 commit sha 钉版本 —— 那样每次更新都要换地址。

备用镜像（ghproxy 挂了才用）：

```
https://gh-fast.top/https://raw.githubusercontent.com/guyue211/g1-sku-live/main/g1-sku-live.plugin
https://gh-proxy.com/https://raw.githubusercontent.com/guyue211/g1-sku-live/main/g1-sku-live.plugin
```

## 使用

1. Loon 里开启 **HTTPS 解密**（MITM 证书装好，`one.google.com` 在主机名列表里）；
2. 打开 Google One App → **升级** → 进方案页，停两秒让响应跑完；
3. Safari 打开 `https://one.google.com/g1-sku-live-report`。

**MITM 只加 `one.google.com`。** 绝对不要把 `apple.com` / `icloud.com` 加进去 —— Apple 的支付端点（`bag.itunes.apple.com`、`gateway.icloud.com`）有证书 pinning，被 MITM 后购买必然失败，报 "Unable to Complete Purchase"。

### 找可替换的 offer 的流程

1. **组合生成**：填档位（`20tb` / `30tb` / `2tb` / `helium`），点生成。它按 `g1.ios.` 与 `g1.` 两套前缀 × 周期 × 期间 × 折扣率展开几千个候选，**只列出服务端真的下发过的**。命中 0 个就是这个档位没有可用 offer。
2. **候选探测**：把候选编号贴进去，看它是不是真下发过、解析出来是什么、能不能当目标。
3. **改写配置**：从「可作目标」的编号里挑一个填进去，启用。

报告页五块：

**最近一次执行** —— 路径、状态、命中数。状态有五种：

| 状态 | 含义 |
|---|---|
| `rewritten` | 命中并改写了 |
| `no-match` | 走了改写分支，但源编号没出现 → **源编号可能升版了** |
| `path-skip` | 不是 `/ai` 或 `/plans`，没进改写 |
| `disabled` | 配置里没启用 |
| `non-text` | 响应不是文本（protobuf / 二进制） |

**疑似目标池** —— 带 `_ip_` / `_eft` / `.acq` / `months` / `annual` 的编号。这一栏就是**当前活着的优惠池**，按次数排序。你之前那些 0 元和一折的编号如果不在这一栏里，就是真的没了。

**候选探测** —— 把候选编号贴进去（一行一个），逐个告诉你：

- `服务端下发过` —— 编号是真的，改写它有机会出单；
- `未采集到` —— 服务端从未下发，改写等于把未知 ID 交给收银台；
- 右列 **同档已下发** —— 按档位 token（`20tb` / `30tb` / `2tb`）匹配，直接给出同档位上还活着的编号。这是找替代品最快的一条路：`g1.20tb.1month_eft.acq` 死了，右列会列出 `g1.ios.20tb.m.v2`、`g1.20tb.v2` 这些同档活编号。

**改写配置** —— 目标编号 + 源编号 + 启用开关，存本地。改完不用重装插件，下一个 `/ai?` 响应就生效。

**导出 JSON** —— `?format=json`，含采集、执行、配置、探测结果。

## 先读这个

iOS 内购 SKU 的实测清单、以及 5x/20x 为什么没有试用编号：[docs/ios-iap-skus.md](docs/ios-iap-skus.md)。

一句话：**Ultra 20TB / 30TB 在 iOS 目录里只有入口编号，没有任何 `_ip_` / `_eft` 变体。** 三方独立实测一致。

## 为什么"拉不起来"

三条原因，现象一样：

| # | 原因 | 判别 |
|---|---|---|
| 1 | 源编号升版（`g1.ios.20tb.m.v2` → `.v3`） | `hits=0`，疑似目标池里出现新的 `g1.ios.20tb.*` |
| 2 | 目标编号退役，服务端不再下发 | `hits>0`，`targetObserved=否` |
| 3 | 目标下发了但收银台不认 | `hits>0`，`targetObserved=是`，面板仍报错 |

`.acq` 是**活动期编号**，不是常驻商品。证据：我在 Android 侧抓到的 live 目录里有 `g1.2tb.ai.annual.1y_ip_50p_ghostbusters`（电影联动活动）和 `6months-eft-ss-2026`（年度活动）。活动结束，编号退役。`g1-acq` 上游也早把 `1month_eft` / `3months_ip_90p` 从默认配置撤了，只留历史记录。

## 与小火箭模块的差异

| | 小火箭 `.sgmodule` | Loon `.plugin` |
|---|---|---|
| 脚本行 | `pattern=<regex>, script-path=` | `<regex> script-path=` |
| 正文开关 | `requires-body=1` | `requires-body=true` |
| 脚本 API | 相同（`$request` / `$response` / `$persistentStore` / `$done`） | 相同 |
| 本地响应 | `$done({response:{...}})` | 相同 |

`$persistentStore` 在两边都是 `read(key)` / `write(value, key)`，脚本可以直接复用。

## 测试

```sh
node test/run.cjs
```

覆盖：采集全量编号、`\u002e` 转义解码、非目标域名放行、报告页排除、四种执行状态、整 token 改写不误伤、`/plans` 改写、报告页 HTML、候选探测活/死判定、同档替代、JSON 结构、POST 存配置、清空、无外联。

```
14 passed, 0 failed
```

## 隐私

两个脚本全文没有 `$httpClient` / `$task.fetch` / `fetch(` / `XMLHttpRequest`。采集只写 `$persistentStore`，报告页由 `http-request` 脚本本地生成，不转发给 Google，页面 CSP 是 `default-src 'none'`。
