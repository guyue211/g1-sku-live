"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = fs.readFileSync(path.join(ROOT, "g1-sku-live.js"), "utf8");
const REPORT = fs.readFileSync(path.join(ROOT, "g1-sku-live-report.js"), "utf8");

function sandbox(store, opts) {
  opts = opts || {};
  const logs = [];
  const box = { done: null };
  const ctx = {
    $request: opts.url === undefined ? undefined : { url: opts.url, method: opts.method || "GET", body: opts.body },
    $response: (opts.response === undefined || opts.response === false) ? undefined : { body: opts.response },
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; },
    },
    $done: (v) => { box.done = v; },
    console: { log: (...a) => logs.push(a.join(" ")) },
    Date, JSON, Math, isFinite, Number, String, Object, Array, RegExp,
    decodeURIComponent, encodeURIComponent,
  };
  return { ctx, box, logs };
}
function run(code, ctx) { vm.createContext(ctx); vm.runInContext(code, ctx); }
function isEmpty(v) { return Object.keys(v || {}).length === 0; }

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✔ " + name); }
  catch (e) { fail++; console.log("  ✖ " + name + "\n      " + e.message); }
}

const store = {};

/* 模拟 iOS 的 one.google.com/ai HTML 片段：带价格与周期 */
const IOS_HTML = `<html><body>
<div><span>Google AI Pro (5 TB)</span><span>₺869,99</span></div>
<script>var plans=[{"productId":"g1.ios.ai.2tb.m.ip_1mo_90p.acq","price":"₺86,99","period":"P1M"}];</script>
<a data-sku="g1.ios.2tb.m.3month_ip_75p">3 个月 2.5 折 ₺217,50</a>
<a data-sku="g1.ios.20tb.m.v2">Google AI Ultra (20 TB) US$99.99</a>
<a data-sku="g1.ios.30tb.ai.pro.m">Google AI Ultra (30 TB) US$199.99</a>
<span>g1.ios.100gb.m.3month_ip_75p</span>
<span>com.google.one.generic</span>
</body></html>`;

t("采集并抓上下文（价格/周期）", () => {
  const s = sandbox(store, { url: "https://one.google.com/ai?hl=zh", response: IOS_HTML });
  run(MAIN, s.ctx);
  const scan = JSON.parse(store["g1.live.scan.v1"]);
  const ids = scan.ids.map((r) => r.id).sort();
  assert.deepStrictEqual(ids, [
    "com.google.one.generic",
    "g1.ios.100gb.m.3month_ip_75p",
    "g1.ios.20tb.m.v2",
    "g1.ios.2tb.m.3month_ip_75p",
    "g1.ios.30tb.ai.pro.m",
    "g1.ios.ai.2tb.m.ip_1mo_90p.acq",
  ]);
  const withCtx = scan.ids.filter((r) => typeof r.ctx === "string" && r.ctx.length > 0);
  assert.strictEqual(withCtx.length, scan.ids.length, "每个编号都应带上下文");
  const pro = scan.ids.find((r) => r.id === "g1.ios.20tb.m.v2");
  assert.match(pro.ctx, /Ultra|99/, "上下文里应能读到价格或名称");
});

t("解析：命名空间 / 档位 / 周期 / 类型 / 折扣率", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?format=json" });
  run(REPORT, s.ctx);
  const j = JSON.parse(s.box.done.response.body);
  const by = {};
  for (const r of j.scan.ids) by[r.raw] = r;

  const a = by["g1.ios.ai.2tb.m.ip_1mo_90p.acq"];
  assert.strictEqual(a.ns, "ios");
  assert.strictEqual(a.tier, "2tb");
  assert.strictEqual(a.cycle, "月付");
  assert.strictEqual(a.kind, "discount");
  assert.strictEqual(a.discount, 90);
  assert.strictEqual(a.period, "1 个月");
  assert.strictEqual(a.acq, true);
  assert.strictEqual(a.ok, true, "iOS 折扣编号应判为可作目标");

  const b = by["g1.ios.2tb.m.3month_ip_75p"];
  assert.strictEqual(b.discount, 75);
  assert.strictEqual(b.period, "3 个月");
  assert.strictEqual(b.ok, true);

  const c = by["g1.ios.20tb.m.v2"];
  assert.strictEqual(c.kind, "entry");
  assert.strictEqual(c.ok, false, "裸入口不能当目标");
  assert.match(c.note, /入口/);

  const d = by["com.google.one.generic"];
  assert.strictEqual(d.ns, "apple");
  assert.strictEqual(d.ok, false);
});

t("解析：Android 命名空间判为不可用", () => {
  const st = {};
  const s0 = sandbox(st, { url: "https://one.google.com/ai", response: '{"a":"g1.2tb.ai.12months_eft","b":"g1.play.20tb"}' });
  run(MAIN, s0.ctx);
  const s = sandbox(st, { url: "https://one.google.com/g1-sku-live-report?format=json" });
  run(REPORT, s.ctx);
  const j = JSON.parse(s.box.done.response.body);
  const by = {};
  for (const r of j.scan.ids) by[r.raw] = r;
  assert.strictEqual(by["g1.2tb.ai.12months_eft"].ns, "android");
  assert.strictEqual(by["g1.2tb.ai.12months_eft"].kind, "trial");
  assert.strictEqual(by["g1.2tb.ai.12months_eft"].period, "12 个月");
  assert.strictEqual(by["g1.2tb.ai.12months_eft"].ok, false);
  assert.match(by["g1.2tb.ai.12months_eft"].note, /非 iOS/);
  assert.strictEqual(by["g1.play.20tb"].ns, "play");
});

t("组合生成：只列出服务端真的下发过的", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?format=json&gen=20tb" });
  run(REPORT, s.ctx);
  const j = JSON.parse(s.box.done.response.body);
  assert.ok(j.gen.generated > 100, "应生成大量候选");
  assert.strictEqual(j.gen.live, 0, "20TB 只有裸入口，不该命中任何 offer 组合");
});

t("组合生成：2tb 档位能命中已下发的折扣编号", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?format=json&gen=2tb" });
  run(REPORT, s.ctx);
  const j = JSON.parse(s.box.done.response.body);
  assert.ok(j.gen.live >= 2, "应命中 3month_ip_75p 与 ip_1mo_90p 两类");
  const ids = j.gen.hits.map((h) => h.raw);
  assert.ok(ids.includes("g1.ios.2tb.m.3month_ip_75p"), "周期在前的写法");
  assert.ok(ids.includes("g1.ios.ai.2tb.m.ip_1mo_90p.acq"), "ai.2tb 词序 + 周期在 ip 里");
});

t("候选探测：下发过 + 可作目标", () => {
  const s = sandbox(store, {
    url: "https://one.google.com/g1-sku-live-report?cand=" +
      encodeURIComponent("g1.ios.ai.2tb.m.ip_1mo_90p.acq\ng1.ios.20tb.m.1month_eft.acq"),
  });
  run(REPORT, s.ctx);
  const body = s.box.done.response.body;
  assert.match(body, /下发过/);
  assert.match(body, /未采集到/);
  const j = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?format=json&cand=" + encodeURIComponent("g1.ios.ai.2tb.m.ip_1mo_90p.acq") });
  run(REPORT, j.ctx);
  const p = JSON.parse(j.box.done.response.body).probe;
  assert.strictEqual(p.candidates[0].live, true);
  assert.strictEqual(p.candidates[0].ok, true);
  assert.strictEqual(p.usable, 1);
});

t("报告页 HTML 分栏渲染", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report" });
  run(REPORT, s.ctx);
  const b = s.box.done.response.body;
  assert.match(b, /免费试用 · /);
  assert.match(b, /折扣 · /);
  assert.match(b, /入口编号 · /);
  assert.match(b, /组合生成/);
  assert.match(b, /g1\.ios\.2tb\.m\.3month_ip_75p/);
});

t("改写：启用后整 token 替换，命中计数", () => {
  store["g1.live.cfg.v1"] = JSON.stringify({
    schemaVersion: 1, enabled: true,
    sources: ["g1.ios.20tb.m.v2"], target: "g1.ios.ai.2tb.m.ip_1mo_90p.acq",
  });
  const s = sandbox(store, { url: "https://one.google.com/ai?x=1", response: IOS_HTML });
  run(MAIN, s.ctx);
  assert.match(s.box.done.body, /g1\.ios\.ai\.2tb\.m\.ip_1mo_90p\.acq/);
  assert.doesNotMatch(s.box.done.body, /g1\.ios\.20tb\.m\.v2/);
  const r = JSON.parse(store["g1.live.run.v1"]);
  assert.strictEqual(r.hits, 1);
  assert.strictEqual(r.status, "rewritten");
  assert.strictEqual(r.targetObserved, true, "目标本身也在响应里，应记为已下发");
});

t("非 /ai 路径不改写", () => {
  const s = sandbox(store, { url: "https://one.google.com/u/0/settings", response: IOS_HTML });
  run(MAIN, s.ctx);
  assert.ok(isEmpty(s.box.done));
  assert.strictEqual(JSON.parse(store["g1.live.run.v1"]).status, "path-skip");
});

t("POST 保存配置", () => {
  const s = sandbox(store, {
    url: "https://one.google.com/g1-sku-live-report", method: "POST",
    body: "target=" + encodeURIComponent("g1.ios.ai.2tb.m.ip_1mo_90p.acq") +
          "&sources=" + encodeURIComponent("g1.ios.20tb.m.v2,g1.ios.30tb.ai.pro.m") + "&enabled=1",
  });
  run(REPORT, s.ctx);
  const cfg = JSON.parse(store["g1.live.cfg.v1"]);
  assert.deepStrictEqual(cfg.sources, ["g1.ios.20tb.m.v2", "g1.ios.30tb.ai.pro.m"]);
  assert.strictEqual(cfg.enabled, true);
});

t("?clear=1 清空", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?clear=1" });
  run(REPORT, s.ctx);
  assert.strictEqual(JSON.parse(store["g1.live.scan.v1"]).ids.length, 0);
});

t("两个脚本都不外联", () => {
  for (const src of [MAIN, REPORT]) {
    assert.doesNotMatch(src, /\$httpClient|\$task\.fetch|fetch\(|XMLHttpRequest|require\(/);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
