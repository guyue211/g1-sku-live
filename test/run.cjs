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
    Date, JSON, Math, isFinite, Number, String, Object, Array, RegExp, decodeURIComponent, encodeURIComponent,
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

const LIVE_BODY = JSON.stringify({
  plans: [
    { productId: "g1.ios.20tb.m.v2", title: "Google AI Ultra (20 TB)", price: "US$99.99" },
    { productId: "g1.ai.ultra.3months_ip_75p.acq" },
    { productId: "g1.2tb.ai.subs_variant" },
    { productId: "com.google.gemini.2tb.ai.m.3month_ip_99p" },
    { productId: "g1.2tb.ai.annual.1y_ip_50p_ghostbusters" },
  ],
});

t("采集 /ai? 响应里的全部编号", () => {
  const s = sandbox(store, { url: "https://one.google.com/ai?hl=zh", response: LIVE_BODY });
  run(MAIN, s.ctx);
  const scan = JSON.parse(store["g1.live.scan.v1"]);
  const got = scan.ids.map((r) => r.id).sort();
  assert.deepStrictEqual(got, [
    "com.google.gemini.2tb.ai.m.3month_ip_99p",
    "g1.2tb.ai.annual.1y_ip_50p_ghostbusters",
    "g1.2tb.ai.subs_variant",
    "g1.ai.ultra.3months_ip_75p.acq",
    "g1.ios.20tb.m.v2",
  ]);
  assert.strictEqual(scan.scanned, 1);
});

t("转义点号解码后再采集", () => {
  const s2 = {};
  const body = '{"id":"g1\\u002eios\\u002e20tb\\u002em\\u002ev2"}';
  const s = sandbox(s2, { url: "https://one.google.com/ai", response: body });
  run(MAIN, s.ctx);
  const scan = JSON.parse(s2["g1.live.scan.v1"]);
  assert.deepStrictEqual(scan.ids.map((r) => r.id), ["g1.ios.20tb.m.v2"]);
});

t("非 one.google.com 直接放行", () => {
  const s = sandbox({}, { url: "https://example.com/ai", response: "g1.ios.20tb.m.v2" });
  run(MAIN, s.ctx);
  assert.ok(isEmpty(s.box.done));
});

t("报告页 URL 不被主脚本接管", () => {
  const s = sandbox({}, { url: "https://one.google.com/g1-sku-live-report", response: "{}" });
  run(MAIN, s.ctx);
  assert.ok(isEmpty(s.box.done));
});

t("未启用时不改写，但记录 targetObserved", () => {
  store["g1.live.cfg.v1"] = JSON.stringify({ schemaVersion: 1, enabled: false, sources: ["g1.ios.20tb.m.v2"], target: "g1.ai.ultra.3months_ip_75p.acq" });
  const s = sandbox(store, { url: "https://one.google.com/ai?x=1", response: LIVE_BODY });
  run(MAIN, s.ctx);
  assert.ok(isEmpty(s.box.done));
  const r = JSON.parse(store["g1.live.run.v1"]);
  assert.strictEqual(r.status, "disabled");
  assert.strictEqual(r.targetObserved, true);
});

t("启用后整 token 改写，JSON 结构完好", () => {
  store["g1.live.cfg.v1"] = JSON.stringify({ schemaVersion: 1, enabled: true, sources: ["g1.ios.20tb.m.v2"], target: "g1.ai.ultra.3months_ip_90p.acq" });
  const s = sandbox(store, { url: "https://one.google.com/ai?x=1", response: LIVE_BODY });
  run(MAIN, s.ctx);
  const out = JSON.parse(s.box.done.body);
  assert.strictEqual(out.plans[0].productId, "g1.ai.ultra.3months_ip_90p.acq");
  assert.strictEqual(out.plans[2].productId, "g1.2tb.ai.subs_variant");
  const r = JSON.parse(store["g1.live.run.v1"]);
  assert.strictEqual(r.hits, 1);
  assert.strictEqual(r.status, "rewritten");
  assert.strictEqual(r.targetObserved, false);
});

t("/plans 也改写，其它路径跳过", () => {
  store["g1.live.cfg.v1"] = JSON.stringify({ schemaVersion: 1, enabled: true, sources: ["g1.ios.20tb.m.v2"], target: "X" });
  let s = sandbox(store, { url: "https://one.google.com/plans", response: '{"a":"g1.ios.20tb.m.v2"}' });
  run(MAIN, s.ctx);
  assert.strictEqual(JSON.parse(s.box.done.body).a, "X");

  s = sandbox(store, { url: "https://one.google.com/u/0/settings", response: '{"a":"g1.ios.20tb.m.v2"}' });
  run(MAIN, s.ctx);
  assert.ok(isEmpty(s.box.done));
  assert.strictEqual(JSON.parse(store["g1.live.run.v1"]).status, "path-skip");
});

t("更长 token 不误伤", () => {
  store["g1.live.cfg.v1"] = JSON.stringify({ schemaVersion: 1, enabled: true, sources: ["g1.ios.20tb.m.v2"], target: "X" });
  const s = sandbox(store, { url: "https://one.google.com/ai", response: '{"a":"g1.ios.20tb.m.v2.v3"}' });
  run(MAIN, s.ctx);
  assert.ok(isEmpty(s.box.done));
});

t("报告页 HTML 正常输出", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report" });
  run(REPORT, s.ctx);
  const res = s.box.done.response;
  assert.strictEqual(res.status, 200);
  assert.match(res.headers["Content-Type"], /text\/html/);
  assert.match(res.body, /疑似目标池/);
  assert.match(res.body, /g1\.ai\.ultra\.3months_ip_75p\.acq/);
  assert.match(res.body, /g1\.ios\.20tb\.m\.v2/);
});

t("候选探测：区分活编号与死编号，并给出同族替代", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?cand=" + encodeURIComponent("g1.ai.ultra.3months_ip_75p.acq,g1.20tb.1month_eft.acq") });
  run(REPORT, s.ctx);
  const body = s.box.done.response.body;
  assert.match(body, /服务端下发过/);
  assert.match(body, /未采集到/);
  assert.match(body, /命中 <strong>1<\/strong> · 未命中 <strong>1<\/strong>/);
});

t("候选探测 JSON 结构", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?format=json&cand=" + encodeURIComponent("g1.20tb.1month_eft.acq") });
  run(REPORT, s.ctx);
  const j = JSON.parse(s.box.done.response.body);
  assert.strictEqual(j.probe.candidates.length, 1);
  assert.strictEqual(j.probe.candidates[0].live, false);
  assert.ok(j.probe.candidates[0].siblings.length >= 1);
  assert.ok(j.scan.total >= 5);
});

t("POST 保存配置", () => {
  const s = sandbox(store, {
    url: "https://one.google.com/g1-sku-live-report", method: "POST",
    body: "target=" + encodeURIComponent("g1.ai.ultra.1month_eft.acq") +
          "&sources=" + encodeURIComponent("g1.ios.20tb.m.v2,g1.ios.30tb.ai.pro.m") + "&enabled=1",
    response: undefined,
  });
  run(REPORT, s.ctx);
  const cfg = JSON.parse(store["g1.live.cfg.v1"]);
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.target, "g1.ai.ultra.1month_eft.acq");
  assert.deepStrictEqual(cfg.sources, ["g1.ios.20tb.m.v2", "g1.ios.30tb.ai.pro.m"]);
  assert.match(s.box.done.response.body, /配置已保存/);
});

t("?clear=1 清空", () => {
  const s = sandbox(store, { url: "https://one.google.com/g1-sku-live-report?clear=1" });
  run(REPORT, s.ctx);
  assert.strictEqual(JSON.parse(store["g1.live.scan.v1"]).ids.length, 0);
  assert.match(s.box.done.response.body, /已清空/);
});

t("两个脚本都不外联", () => {
  for (const src of [MAIN, REPORT]) {
    assert.doesNotMatch(src, /\$httpClient|\$task\.fetch|fetch\(|XMLHttpRequest|require\(/);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
