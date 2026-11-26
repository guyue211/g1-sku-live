/* G1 SKU Live — Loon 插件主脚本
   职责：
     1) 采集：把 one.google.com 每个响应里所有 SKU 形态的 token 全量入库
        （含 \u002e 等转义解码），记录次数、首次/末次时间、来源路径。
     2) 改写：按本地配置的 sources -> target 做整 token 替换，仅在 /ai、/plans。
     3) 取证：记录命中数、targetObserved（目标编号是否本来就由服务端下发）。
   Loon 运行时：$request / $response / $persistentStore / $done / console.log
   ES5 语法，不用箭头函数与模板串。 */
"use strict";

(function () {
  var VERSION = "g1-sku-live-v1";
  var SCAN_KEY = "g1.live.scan.v1";
  var CFG_KEY = "g1.live.cfg.v1";
  var RUN_KEY = "g1.live.run.v1";
  var LIMIT = 400;
  var MAX_BODY = 8 * 1024 * 1024;

  var url = (typeof $request === "object" && $request && typeof $request.url === "string")
    ? $request.url : "";
  if (!/^https:\/\/one\.google\.com\//.test(url)) { $done({}); return; }
  if (/^https:\/\/one\.google\.com\/g1-sku-live-report\/?(?:\?|$)/.test(url)) { $done({}); return; }

  var body = (typeof $response === "object" && $response) ? $response.body : undefined;
  var path = url.replace(/^https:\/\/one\.google\.com/, "").split(/[?#]/)[0] || "/";

  /* ---------- 存储 ---------- */
  function readJson(key, fallback) {
    try {
      if (typeof $persistentStore === "undefined" || !$persistentStore) return fallback;
      var raw = $persistentStore.read(key);
      if (!raw) return fallback;
      var value = JSON.parse(raw);
      return (value && typeof value === "object") ? value : fallback;
    } catch (error) { return fallback; }
  }
  function writeJson(key, value) {
    try {
      if (typeof $persistentStore === "undefined" || !$persistentStore) return false;
      return $persistentStore.write(JSON.stringify(value), key) !== false;
    } catch (error) { return false; }
  }

  var now = new Date().toISOString();

  /* ---------- 采集 ---------- */
  var TOKEN = /(^|[^A-Za-z0-9._@%-])((?:g1|com\.google\.(?:gemini|one|android\.apps\.subscriptions))\.[A-Za-z0-9._-]{1,120})(?=$|[^A-Za-z0-9._-])/g;

  function decodeEscapes(text) {
    return text
      .replace(/\\u002e|\\x2e|&#0*46;|&#x0*2e;|&period;/gi, ".")
      .replace(/\\u002d|&#0*45;|&#x0*2d;/gi, "-");
  }

  var scan = readJson(SCAN_KEY, null);
  if (!scan || scan.schemaVersion !== 1 || !(scan.ids instanceof Array)) {
    scan = { schemaVersion: 1, version: VERSION, updatedAt: now, scanned: 0, ids: [] };
  }

  var index = Object.create(null);
  var i;
  for (i = 0; i < scan.ids.length && i < LIMIT; i += 1) {
    var row = scan.ids[i];
    if (row && typeof row.id === "string" && !index[row.id]) index[row.id] = row;
  }

  var found = 0;
  if (typeof body === "string" && body.length <= MAX_BODY) {
    var text = decodeEscapes(body);
    var seen = Object.create(null);
    TOKEN.lastIndex = 0;
    var match;
    while ((match = TOKEN.exec(text)) !== null) {
      var id = match[2];
      if (seen[id]) continue;
      seen[id] = 1;
      found += 1;
      if (index[id]) {
        index[id].count = (Number(index[id].count) || 0) + 1;
        index[id].last = now;
        if (typeof index[id].path !== "string") index[id].path = path;
      } else if (scan.ids.length < LIMIT) {
        index[id] = { id: id, count: 1, first: now, last: now, path: path };
        scan.ids.push(index[id]);
      }
    }
    scan.scanned = (Number(scan.scanned) || 0) + 1;
  }
  scan.updatedAt = now;
  scan.version = VERSION;
  writeJson(SCAN_KEY, scan);

  /* ---------- 改写 ---------- */
  var cfg = readJson(CFG_KEY, null);
  if (!cfg || cfg.schemaVersion !== 1) {
    cfg = { schemaVersion: 1, enabled: false, sources: [], target: "" };
  }
  var sources = (cfg.sources instanceof Array) ? cfg.sources : [];
  var target = (typeof cfg.target === "string") ? cfg.target : "";
  var targetObserved = false;
  var hits = 0;
  var out = body;
  var rewritable = /^\/(?:ai|plans)\/?$/.test(path);

  if (typeof body === "string") {
    targetObserved = target ? body.indexOf(target) !== -1 : false;
  }

  if (cfg.enabled && target && rewritable && typeof body === "string" && sources.length) {
    out = body.replace(TOKEN, function (whole, before, id) {
      for (var k = 0; k < sources.length; k += 1) {
        if (sources[k] === id) { hits += 1; return before + target; }
      }
      return whole;
    });
  }

  var run = {
    schemaVersion: 1,
    version: VERSION,
    at: now,
    path: path,
    sources: sources,
    target: target,
    enabled: !!cfg.enabled,
    rewritable: rewritable,
    bodyType: typeof body === "string" ? "text" : "non-text",
    collected: found,
    hits: hits,
    targetObserved: targetObserved,
    status: typeof body !== "string" ? "non-text"
      : (!cfg.enabled ? "disabled" : (!rewritable ? "path-skip" : (hits ? "rewritten" : "no-match")))
  };
  writeJson(RUN_KEY, run);

  console.log("[g1-sku-live] " + VERSION + " path=" + path +
    " collected=" + found + " hits=" + hits +
    " targetObserved=" + targetObserved + " status=" + run.status);

  $done(hits ? { body: out } : {});
})();
