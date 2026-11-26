"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "g1-acq");

const PLUGINS = [
  {
    slug: "g1-acq-pro-1yuan",
    tag: "G1AcqPro1Yuan",
    sampleIn: '["g1.ios.2tb.ai.m","g1.ios.2tb.ai.y","g1.ios.20tb.m.v2","g1.ios.2tb."]',
    expectPresent: ['"com.google.gemini.2tb.ai.m.3month_ip_99p"', '"g1.ios.20tb.m.v2"', '"g1.ios.2tb."'],
    expectAbsent: ['"g1.ios.2tb.ai.m"', '"g1.ios.2tb.ai.y"'],
  },
  {
    slug: "g1-acq-tr-ultra-20tb",
    tag: "G1AcqTrUltra20TB",
    sampleIn: '["g1.ios.20tb.m.v2","g1.ios.20tb.m.v20","g1.ios.30tb.ai.pro.m","g1.ios.2tb.ai.m"]',
    expectPresent: ['"g1.ios.20tb.m"', '"g1.ios.20tb.m.v20"', '"g1.ios.30tb.ai.pro.m"', '"g1.ios.2tb.ai.m"'],
    expectAbsent: ['"g1.ios.20tb.m.v2"'],
  },
  {
    slug: "g1-acq-tr-ultra-30tb",
    tag: "G1AcqTrUltra30TB",
    sampleIn: '["g1.ios.30tb.ai.pro.m","g1.ios.30tb.ai.pro.m.v2","g1.ios.20tb.m.v2"]',
    expectPresent: ['"g1.ios.30tb.m"', '"g1.ios.30tb.ai.pro.m.v2"', '"g1.ios.20tb.m.v2"'],
    expectAbsent: ['"g1.ios.30tb.ai.pro.m"'],
  },
  {
    slug: "g1-acq-ultra-75p",
    tag: "G1AcqUltra75p",
    sampleIn: '["g1.ios.20tb.m.v2","g1.ios.30tb.ai.pro.m","g1.ios.2tb.ai.m"]',
    expectPresent: ['"g1.20tb.3months_ip_75p.acq"', '"g1.ai.ultra.3months_ip_75p.acq"', '"g1.ios.2tb.ai.m"'],
    expectAbsent: ['"g1.ios.20tb.m.v2"', '"g1.ios.30tb.ai.pro.m"'],
  },
  {
    slug: "g1-acq-pro-12months-90p",
    tag: "G1AcqPro12m90p",
    sampleIn: '["g1.ios.2tb.ai.m","g1.ios.2tb.ai.y","g1.ios.20tb.m.v2","g1.ios.2tb."]',
    expectPresent: ['"g1.2tb.ai.12months_ip_90p"', '"g1.ios.20tb.m.v2"', '"g1.ios.2tb."'],
    expectAbsent: ['"g1.ios.2tb.ai.m"', '"g1.ios.2tb.ai.y"'],
  },
];

function runScript(jsPath, url, body) {
  const code = fs.readFileSync(jsPath, "utf8");
  let result;
  const logs = [];
  const sandbox = {
    $request: { url },
    $response: { body },
    $done: (val) => { result = val; },
    console: { log: (m) => logs.push(String(m)) },
  };
  vm.runInNewContext(code, sandbox, { filename: jsPath });
  return { result, logs };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  PASS", name);
  } catch (err) {
    failed += 1;
    console.error("  FAIL", name, "-", err.message);
  }
}

const seenTags = new Set();

for (const item of PLUGINS) {
  const jsPath = path.join(DIR, `${item.slug}.js`);
  const pluginPath = path.join(DIR, `${item.slug}.plugin`);

  test(`${item.slug}: plugin metadata & Loon syntax`, () => {
    const content = fs.readFileSync(pluginPath, "utf8");
    assert.match(content, /^#!name=.+/m);
    assert.match(content, /^#!desc=.+/m);
    assert.match(content, /^#!system=ios$/m);
    assert.match(content, /^\[Rule\]$/m);
    assert.match(content, /^AND,\(\(PROTOCOL,UDP\),\(DEST-PORT,443\)\),REJECT-NO-DROP$/m);
    assert.match(content, /^\[Script\]$/m);
    assert.match(content, new RegExp(`^http-response \\^https:\\\\/\\\\/one\\\\\\.google\\\\\\.com\\\\/ai\\\\\\? script-path=https://gh-proxy\\.com/https://raw\\.githubusercontent\\.com/guyue211/g1-sku-live/main/g1-acq/${item.slug}\\.js\\?v=\\d+, requires-body=true, timeout=60, tag=${item.tag}$`, "m"));
    assert.doesNotMatch(content, /max-size/);
    assert.match(content, /^\[MITM\]$/m);
    assert.match(content, /^hostname=one\.google\.com$/m);
    assert.equal(seenTags.has(item.tag), false, `duplicate tag ${item.tag}`);
    seenTags.add(item.tag);
  });

  test(`${item.slug}: rewrites target SKUs on /ai?`, () => {
    const { result } = runScript(jsPath, "https://one.google.com/ai?hl=en", item.sampleIn);
    assert.equal(typeof result.body, "string");
    for (const s of item.expectPresent) assert.ok(result.body.includes(s), `expected ${s} in ${result.body}`);
    for (const s of item.expectAbsent) assert.ok(!result.body.includes(s), `unexpected ${s} in ${result.body}`);
  });

  test(`${item.slug}: passthrough on non-/ai? URL`, () => {
    const { result } = runScript(jsPath, "https://one.google.com/plans", item.sampleIn);
    assert.equal(JSON.stringify(result), "{}");
  });

  test(`${item.slug}: passthrough on non-text or empty body`, () => {
    assert.equal(JSON.stringify(runScript(jsPath, "https://one.google.com/ai?hl=en", undefined).result), "{}");
    assert.equal(JSON.stringify(runScript(jsPath, "https://one.google.com/ai?hl=en", "").result), "{}");
  });

  test(`${item.slug}: no network calls`, () => {
    const code = fs.readFileSync(jsPath, "utf8");
    assert.doesNotMatch(code, /\$httpClient|\$task\.fetch|\bfetch\s*\(|XMLHttpRequest/);
  });
}

test("coexistence: pro-1yuan + tr-ultra-20tb + tr-ultra-30tb compose cleanly", () => {
  const url = "https://one.google.com/ai?hl=tr";
  let body = '["g1.ios.2tb.ai.m","g1.ios.20tb.m.v2","g1.ios.30tb.ai.pro.m"]';
  for (const slug of ["g1-acq-pro-1yuan", "g1-acq-tr-ultra-20tb", "g1-acq-tr-ultra-30tb"]) {
    const { result } = runScript(path.join(DIR, `${slug}.js`), url, body);
    if (result.body) body = result.body;
  }
  assert.equal(body, '["com.google.gemini.2tb.ai.m.3month_ip_99p","g1.ios.20tb.m","g1.ios.30tb.m"]');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
