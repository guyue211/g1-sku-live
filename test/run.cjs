"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "g1-sku-live.js"), "utf8");

function sandbox(store, opts) {
  opts = opts || {};
  const logs = [];
  const box = { done: null };
  const ctx = {
    $request: opts.url === undefined ? undefined
      : { url: opts.url, method: opts.method || "GET", body: opts.body },
    $response: (opts.response === undefined || opts.response === false)
      ? undefined : { body: opts.response },
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
function run(store, opts) {
  const s = sandbox(store, opts);
  vm.createContext(s.ctx);
  vm.runInContext(SRC, s.ctx);
  return s;
}
function isEmpty(v) { return Object.keys(v || {}).length === 0; }

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✔ " + name); }
  catch (e) { fail++; console.log("  ✖ " + name + "\n      " + e.message); }
}

const IOS_HTML = `<html><body>
<div><span>Google AI Pro (5 TB)</span><span>₺869,99</span></div>
<script>var plans=[{"productId":"g1.ios.ai.2tb.m.ip_1mo_90p.acq","price":"₺86,99","period":"P1M"}];</script>
<a data-sku="g1.ios.2tb.m.3month_ip_75p">3 个月 2.5 折 ₺217,50</a>
<a data-sku="g1.ios.20tb.m.v2">Google AI Ultra (20 TB) US$99.99</a>
<a data-sku="g1.ios.30tb.ai.pro.m">Google AI Ultra (30 TB) US$199.99</a>
<span>g1.ios.100gb.m.3month_ip_75p</span>
<span>com.google.one.generic</span>
</body></html>`;

/* ---- 报告页在 http-request 阶段（本地应答） ---- */
t("报告页：http-request 阶段用 response 包装应答", () => {
  const store = {};
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report" });
  assert.ok(s.box.done.response, "应返回 response 包装");
  assert.strictEqual(s.box.done.response.status, 200);
  assert.match(s.box.done.response.headers["Content-Type"], /text\/html/);
  assert.match(s.box.done.response.body, /v3/);
});

/* ---- 报告页在 http-response 阶段（兜底替换 404） ---- */
t("报告页：http-response 阶段兜底，把 404 换成报告", () => {
  const store = {};
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report", response: "Not Found" });
  assert.strictEqual(s.box.done.status, 200, "应直接把状态改成 200");
  assert.match(s.box.done.body, /G1 SKU Live/);
  assert.strictEqual(s.box.done.response, undefined, "不该用 response 包装");
});

t("报告页：Google 返回 302 也照样替换", () => {
  const store = {};
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report?x=1", response: "" });
  assert.strictEqual(s.box.done.status, 200);
  assert.match(s.box.done.body, /G1 SKU Live/);
});

/* ---- 采集 ---- */
t("采集 + 上下文价格", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai?hl=zh", response: IOS_HTML });
  const scan = JSON.parse(store["g1.live.scan.v1"]);
  assert.strictEqual(scan.ids.length, 6);
  const pro = scan.ids.find((r) => r.id === "g1.ios.20tb.m.v2");
  assert.match(pro.ctx, /Ultra|99/);
});

t("报告页显示已采集编号", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai", response: IOS_HTML });
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report" });
  const html = s.box.done.response.body;
  assert.match(html, /g1\.ios\.2tb\.m\.3month_ip_75p/);
  assert.match(html, /g1\.ios\.20tb\.m\.v2/);
});

/* ---- 解析 ---- */
t("解析四种命名写法", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai", response: IOS_HTML });
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report?format=json" });
  const j = JSON.parse(s.box.done.response.body);
  const by = {};
  for (const r of j.scan.ids) by[r.raw] = r;

  const a = by["g1.ios.ai.2tb.m.ip_1mo_90p.acq"];
  assert.strictEqual(a.tier, "2tb"); assert.strictEqual(a.cycle, "月付");
  assert.strictEqual(a.kind, "discount"); assert.strictEqual(a.discount, 90);
  assert.strictEqual(a.period, "1 个月"); assert.strictEqual(a.ok, true);

  const b = by["g1.ios.2tb.m.3month_ip_75p"];
  assert.strictEqual(b.discount, 75); assert.strictEqual(b.period, "3 个月"); assert.strictEqual(b.ok, true);

  const c = by["g1.ios.20tb.m.v2"];
  assert.strictEqual(c.kind, "entry"); assert.strictEqual(c.ok, false);

  const d = by["com.google.one.generic"];
  assert.strictEqual(d.ns, "apple"); assert.strictEqual(d.ok, false);
});

t("Android 命名空间判红", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai", response: '{"a":"g1.2tb.ai.12months_eft","b":"g1.play.20tb"}' });
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report?format=json" });
  const by = {};
  for (const r of JSON.parse(s.box.done.response.body).scan.ids) by[r.raw] = r;
  assert.strictEqual(by["g1.2tb.ai.12months_eft"].kind, "trial");
  assert.strictEqual(by["g1.2tb.ai.12months_eft"].period, "12 个月");
  assert.strictEqual(by["g1.2tb.ai.12months_eft"].ok, false);
  assert.strictEqual(by["g1.play.20tb"].ns, "play");
});

/* ---- 组合生成 ---- */
t("组合生成 20tb：只有裸入口，命中 0", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai", response: IOS_HTML });
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report?format=json&gen=20tb" });
  const g = JSON.parse(s.box.done.response.body).gen;
  assert.ok(g.generated > 1000);
  assert.strictEqual(g.live, 0);
});

t("组合生成 2tb：命中两种写法", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai", response: IOS_HTML });
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report?format=json&gen=2tb" });
  const ids = JSON.parse(s.box.done.response.body).gen.hits.map((h) => h.raw);
  assert.ok(ids.includes("g1.ios.2tb.m.3month_ip_75p"));
  assert.ok(ids.includes("g1.ios.ai.2tb.m.ip_1mo_90p.acq"));
});

/* ---- 探测 ---- */
t("候选探测：活/死 + 可用性", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai", response: IOS_HTML });
  const s = run(store, {
    url: "https://one.google.com/g1-sku-live-report?format=json&cand=" +
      encodeURIComponent("g1.ios.ai.2tb.m.ip_1mo_90p.acq\ng1.ios.20tb.m.1month_eft.acq"),
  });
  const p = JSON.parse(s.box.done.response.body).probe;
  assert.strictEqual(p.live, 1);
  assert.strictEqual(p.dead, 1);
  assert.strictEqual(p.usable, 1);
});

/* ---- 改写 ---- */
t("改写：整 token 替换 + targetObserved", () => {
  const store = {};
  store["g1.live.cfg.v1"] = JSON.stringify({
    schemaVersion: 1, enabled: true,
    sources: ["g1.ios.20tb.m.v2"], target: "g1.ios.ai.2tb.m.ip_1mo_90p.acq",
  });
  const s = run(store, { url: "https://one.google.com/ai?x=1", response: IOS_HTML });
  assert.match(s.box.done.body, /g1\.ios\.ai\.2tb\.m\.ip_1mo_90p\.acq/);
  assert.doesNotMatch(s.box.done.body, /g1\.ios\.20tb\.m\.v2/);
  const r = JSON.parse(store["g1.live.run.v1"]);
  assert.strictEqual(r.hits, 1);
  assert.strictEqual(r.status, "rewritten");
  assert.strictEqual(r.targetObserved, true);
});

t("请求阶段非报告路径直接放行", () => {
  const store = {};
  const s = run(store, { url: "https://one.google.com/ai?x=1" });
  assert.ok(isEmpty(s.box.done));
});

t("非 /ai 响应不改写，记 path-skip", () => {
  const store = {};
  store["g1.live.cfg.v1"] = JSON.stringify({
    schemaVersion: 1, enabled: true, sources: ["g1.ios.20tb.m.v2"], target: "X",
  });
  const s = run(store, { url: "https://one.google.com/u/0/settings", response: IOS_HTML });
  assert.ok(isEmpty(s.box.done));
  assert.strictEqual(JSON.parse(store["g1.live.run.v1"]).status, "path-skip");
});

t("POST 存配置", () => {
  const store = {};
  const s = run(store, {
    url: "https://one.google.com/g1-sku-live-report", method: "POST",
    body: "target=" + encodeURIComponent("g1.ios.ai.2tb.m.ip_1mo_90p.acq") +
          "&sources=" + encodeURIComponent("g1.ios.20tb.m.v2,g1.ios.30tb.ai.pro.m") + "&enabled=1",
  });
  const cfg = JSON.parse(store["g1.live.cfg.v1"]);
  assert.deepStrictEqual(cfg.sources, ["g1.ios.20tb.m.v2", "g1.ios.30tb.ai.pro.m"]);
  assert.strictEqual(cfg.enabled, true);
  assert.match(s.box.done.response.body, /配置已保存/);
});

t("?clear=1 清空", () => {
  const store = {};
  run(store, { url: "https://one.google.com/ai", response: IOS_HTML });
  const s = run(store, { url: "https://one.google.com/g1-sku-live-report?clear=1" });
  assert.strictEqual(JSON.parse(store["g1.live.scan.v1"]).ids.length, 0);
  assert.match(s.box.done.response.body, /已清空/);
});

t("无外联", () => {
  assert.doesNotMatch(SRC, /\$httpClient|\$task\.fetch|fetch\(|XMLHttpRequest|require\(/);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
