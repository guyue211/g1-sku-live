/* G1 SKU Live · 报告 / 探测页 — Loon http-request 脚本
   在 https://one.google.com/g1-sku-live-report 本地生成页面，不转发给 Google。
   路由：
     ?format=json                导出采集、执行、配置
     ?cand=<编号,换行分隔>        探测：候选编号是否真的由服务端下发过
     POST target=&sources=&enabled=1   保存改写配置
     ?clear=1                    清空采集与执行记录
   ES5 语法。 */
"use strict";

(function () {
  var VERSION = "g1-sku-live-v1";
  var ROOT = "https://one.google.com/g1-sku-live-report";
  var SCAN_KEY = "g1.live.scan.v1";
  var CFG_KEY = "g1.live.cfg.v1";
  var RUN_KEY = "g1.live.run.v1";

  var url = (typeof $request === "object" && $request && typeof $request.url === "string")
    ? $request.url : "";
  if (!/^https:\/\/one\.google\.com\/g1-sku-live-report\/?(?:\?|$)/.test(url)) { $done({}); return; }

  var query = (url.split("?")[1] || "");
  var method = (typeof $request === "object" && $request && $request.method) ? $request.method : "GET";
  var postBody = (typeof $request === "object" && $request && typeof $request.body === "string")
    ? $request.body : "";

  function parseForm(text) {
    var out = Object.create(null);
    if (!text) return out;
    var parts = text.split("&");
    for (var i = 0; i < parts.length; i += 1) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf("=");
      var k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
      var v = eq < 0 ? "" : parts[i].slice(eq + 1);
      try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")); }
      catch (error) { out[k] = v; }
    }
    return out;
  }

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
  function esc(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function num(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  var storageOk = typeof $persistentStore !== "undefined" && !!$persistentStore;
  var notice = "";

  /* ---------- 清空 ---------- */
  if (parseForm(query)["clear"] === "1") {
    var a = writeJson(SCAN_KEY, { schemaVersion: 1, version: VERSION, updatedAt: "", scanned: 0, ids: [] });
    var b = writeJson(RUN_KEY, { schemaVersion: 1, version: VERSION, at: "", hits: 0, collected: 0 });
    notice = (a && b) ? "采集与执行记录已清空。" : "清空未完成，存储接口异常。";
  }

  /* ---------- 保存配置 ---------- */
  if (method === "POST" || parseForm(query)["save"] === "1") {
    var form = parseForm(method === "POST" ? postBody : query);
    var target = (form["target"] || "").trim();
    var rawSources = (form["sources"] || "").split(/[,\s]+/);
    var sources = [];
    for (var s = 0; s < rawSources.length; s += 1) {
      var one = rawSources[s].trim();
      if (one && sources.indexOf(one) < 0) sources.push(one);
    }
    var cfgNew = {
      schemaVersion: 1,
      enabled: form["enabled"] === "1" || form["enabled"] === "on" || form["enabled"] === "true",
      sources: sources,
      target: target
    };
    notice = writeJson(CFG_KEY, cfgNew)
      ? "配置已保存：" + (cfgNew.enabled ? "启用" : "停用") + " · " +
        sources.length + " 个源 → " + (target || "（空）")
      : "配置保存失败。";
  }

  /* ---------- 读状态 ---------- */
  var scan = readJson(SCAN_KEY, { schemaVersion: 1, version: "", updatedAt: "", scanned: 0, ids: [] });
  var run = readJson(RUN_KEY, { schemaVersion: 1, version: "", at: "", hits: 0, collected: 0 });
  var cfg = readJson(CFG_KEY, { schemaVersion: 1, enabled: false, sources: [], target: "" });

  var ids = (scan.ids instanceof Array) ? scan.ids : [];
  var byId = Object.create(null);
  var i;
  for (i = 0; i < ids.length; i += 1) {
    if (ids[i] && typeof ids[i].id === "string") byId[ids[i].id] = ids[i];
  }

  function family(id) {
    var parts = String(id).split(".");
    if (parts[0] === "com") return parts.slice(0, 2).join(".") + "." + (parts[2] || "");
    return parts.slice(0, 2).join(".");
  }
  /* 档位 token：20tb / 30tb / 2tb / 10tb / 100gb。
     源编号 g1.ios.20tb.m.v2 与目标 g1.20tb.3months_ip_90p.acq 前缀不同但同档，
     靠这个把它们归到一起。 */
  function tierTokens(id) {
    var found = String(id).toLowerCase().match(/\d+(?:tb|gb)/g);
    return found || [];
  }
  function siblingsOf(cand, all) {
    var tiers = tierTokens(cand);
    var fam = family(cand);
    var out = [];
    for (var key in all) {
      if (!Object.prototype.hasOwnProperty.call(all, key) || key === cand) continue;
      var lower = key.toLowerCase();
      var share = false;
      for (var t = 0; t < tiers.length; t += 1) {
        if (lower.indexOf(tiers[t]) !== -1) { share = true; break; }
      }
      if (share || family(key) === fam) out.push(key);
    }
    return out;
  }
  function looksLikeTarget(id) {
    return /_ip_\d+p|_eft|\.acq$|\d+months?|annual|introprice|promo/i.test(id);
  }

  /* ---------- 候选探测 ---------- */
  var probe = null;
  var candRaw = parseForm(query)["cand"];
  if (typeof candRaw === "string" && candRaw.trim()) {
    var list = candRaw.split(/[\s,，、;；]+/);
    var rows = [];
    var seenCand = Object.create(null);
    for (i = 0; i < list.length; i += 1) {
      var cand = list[i].trim();
      if (!cand || seenCand[cand]) continue;
      seenCand[cand] = 1;
      var hit = byId[cand];
      var siblings = siblingsOf(cand, byId);
      rows.push({
        id: cand,
        live: !!hit,
        count: hit ? num(hit.count) : 0,
        first: hit ? hit.first : "",
        last: hit ? hit.last : "",
        isCurrent: cfg.target === cand,
        siblings: siblings.sort().slice(0, 12)
      });
    }
    probe = { candidates: rows, live: 0, dead: 0 };
    for (i = 0; i < rows.length; i += 1) { if (rows[i].live) probe.live += 1; else probe.dead += 1; }
  }

  /* ---------- JSON ---------- */
  if (parseForm(query)["format"] === "json") {
    var payload = {
      schemaVersion: 1,
      version: VERSION,
      storageAvailable: storageOk,
      config: cfg,
      run: run,
      scan: {
        scanned: num(scan.scanned),
        updatedAt: scan.updatedAt || "",
        total: ids.length,
        suspected: ids.filter(function (r) { return r && looksLikeTarget(String(r.id)); }).length,
        ids: ids
      },
      probe: probe
    };
    $done({ response: { status: 200, headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-G1-SKU-Live": VERSION
    }, body: JSON.stringify(payload, null, 2) } });
    return;
  }

  /* ---------- HTML ---------- */
  var suspected = [];
  var others = [];
  for (i = 0; i < ids.length; i += 1) {
    var r = ids[i];
    if (!r || typeof r.id !== "string") continue;
    (looksLikeTarget(r.id) ? suspected : others).push(r);
  }
  function byCount(x, y) { return num(y.count) - num(x.count) || (x.id < y.id ? -1 : 1); }
  suspected.sort(byCount);
  others.sort(byCount);

  function rowsOf(list) {
    if (!list.length) return "<tr><td colspan=4 class=mute>暂无。</td></tr>";
    var out = [];
    for (var k = 0; k < list.length; k += 1) {
      var row = list[k];
      out.push("<tr><td><code>" + esc(row.id) + "</code></td><td>" + num(row.count) +
        "</td><td class=mute>" + esc(String(row.first || "").slice(11, 19)) +
        "</td><td class=mute>" + esc(row.path || "") + "</td></tr>");
    }
    return out.join("");
  }

  var probeHtml = "";
  if (probe) {
    var pr = [];
    for (i = 0; i < probe.candidates.length; i += 1) {
      var c = probe.candidates[i];
      pr.push("<tr><td><code>" + esc(c.id) + "</code>" +
        (c.isCurrent ? " <span class=tag>当前目标</span>" : "") + "</td>" +
        "<td>" + (c.live ? "<span class=ok>服务端下发过</span>" : "<span class=bad>未采集到</span>") + "</td>" +
        "<td>" + (c.live ? c.count : "-") + "</td>" +
        "<td class=mute>" + (c.live ? esc(String(c.last).slice(11, 19)) : "-") + "</td>" +
        "<td>" + (c.live ? "" : (c.siblings.length
          ? c.siblings.map(function (x) { return "<code>" + esc(x) + "</code>"; }).join("<br>")
          : "<span class=mute>同族无其它编号</span>")) + "</td></tr>");
    }
    probeHtml = "<section><h2>候选探测</h2>" +
      "<p>命中 <strong>" + probe.live + "</strong> · 未命中 <strong>" + probe.dead + "</strong>" +
      "　<span class=mute>「未采集到」= 服务端从未下发过这个编号，改写它不会出单；右列给出同族已下发的编号，用来找活的替代。</span></p>" +
      "<div class=scroll><table><thead><tr><th>候选编号</th><th>状态</th><th>次数</th><th>末见</th><th>同档已下发</th></tr></thead><tbody>" +
      pr.join("") + "</tbody></table></div></section>";
  }

  var html = [
    "<!doctype html><html lang=zh-CN><meta charset=utf-8>",
    "<meta name=viewport content=\"width=device-width,initial-scale=1\">",
    "<title>G1 SKU Live</title>",
    "<style>",
    "body{font:15px/1.65 -apple-system,system-ui,sans-serif;max-width:900px;margin:0 auto;padding:20px 16px 60px;color:#16202e;background:#f4f6fa}",
    "h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;color:#33445c}",
    "section{background:#fff;border:1px solid #dbe2ec;border-radius:12px;padding:16px;margin:14px 0}",
    "code{font-family:ui-monospace,Menlo,monospace;font-size:13px;overflow-wrap:anywhere}",
    "table{border-collapse:collapse;width:100%;font-size:13px}",
    "th,td{padding:7px 8px;border-bottom:1px solid #e6ebf2;text-align:left;vertical-align:top}",
    "th{color:#5a6b82;font-weight:600;white-space:nowrap}",
    ".scroll{overflow:auto;max-height:460px}",
    ".mute{color:#7b8798}.ok{color:#0d7a3e;font-weight:600}.bad{color:#b3261e;font-weight:600}",
    ".tag{background:#e8eef8;color:#2c4b7c;border-radius:6px;padding:1px 6px;font-size:11px}",
    ".note{background:#eef3fb;border-radius:8px;padding:9px 11px;color:#33445c;font-size:13px}",
    "input[type=text],textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cfd8e6;border-radius:8px;font:13px ui-monospace,Menlo,monospace;background:#fbfcfe}",
    "textarea{min-height:88px;resize:vertical}",
    "button{padding:9px 18px;border:0;border-radius:8px;background:#1a56b8;color:#fff;font-size:14px;margin-top:8px}",
    "label{display:inline-flex;gap:6px;align-items:center;margin:8px 0}",
    "nav a{display:inline-block;margin:0 10px 6px 0;color:#1a56b8;text-decoration:none;font-size:13px}",
    "</style>",
    "<h1>G1 SKU Live</h1>",
    "<p class=mute>v1 · 本机采集与探测 · 数据不出设备</p>",
    notice ? "<p class=note>" + esc(notice) + "</p>" : "",
    storageOk ? "" : "<p class=note>本地存储接口不可用，本页只读。</p>",

    "<section><h2>最近一次执行</h2>",
    "<p>路径 <code>" + esc(run.path || "-") + "</code> · 状态 <strong>" + esc(run.status || "无记录") + "</strong>" +
    " · 本次采集 " + num(run.collected) + " · 命中 <strong>" + num(run.hits) + "</strong></p>",
    "<p>目标 <code>" + esc(cfg.target || "（未设置）") + "</code> · 服务端是否下发过该目标：" +
    (run.targetObserved ? "<span class=ok>是</span>" : "<span class=bad>否</span>") + "</p>",
    "<p class=mute>「否」表示目标编号从未出现在响应里，改写等于把未知 ID 交给收银台，通常不出单。</p>",
    "</section>",

    "<section><h2>改写配置</h2>",
    "<form method=post action=\"" + ROOT + "\">",
    "<p><label>目标编号</label><input type=text name=target value=\"" + esc(cfg.target) + "\" placeholder=\"例如 g1.20tb.1month_eft.acq\"></p>",
    "<p><label>源编号（逗号或换行分隔）</label><textarea name=sources>" +
      esc((cfg.sources instanceof Array) ? cfg.sources.join("\n") : "") + "</textarea></p>",
    "<p><label><input type=checkbox name=enabled value=1" + (cfg.enabled ? " checked" : "") + "> 启用改写（仅 /ai、/plans）</label></p>",
    "<button type=submit>保存</button>",
    "</form></section>",

    "<section><h2>候选探测</h2>",
    "<form method=get action=\"" + ROOT + "\">",
    "<p><label>粘贴候选编号，逐个判断服务端有没有下发过</label>",
    "<textarea name=cand placeholder=\"g1.20tb.1month_eft.acq&#10;g1.ai.ultra.3months_ip_90p.acq\"></textarea></p>",
    "<button type=submit>探测</button></form></section>",
    probeHtml,

    "<section><h2>疑似目标池 · " + suspected.length + " 个</h2>",
    "<p class=mute>带 <code>_ip_</code> / <code>_eft</code> / <code>.acq</code> / <code>months</code> / <code>annual</code> 的编号。这一栏就是当前活着的优惠池。</p>",
    "<div class=scroll><table><thead><tr><th>编号</th><th>次数</th><th>首见</th><th>路径</th></tr></thead><tbody>" +
    rowsOf(suspected) + "</tbody></table></div></section>",

    "<section><h2>其它 SKU · " + others.length + " 个</h2>",
    "<div class=scroll><table><thead><tr><th>编号</th><th>次数</th><th>首见</th><th>路径</th></tr></thead><tbody>" +
    rowsOf(others) + "</tbody></table></div></section>",

    "<section><h2>操作</h2><nav>",
    "<a href=\"" + ROOT + "?format=json\">导出 JSON</a>",
    "<a href=\"" + ROOT + "\">刷新</a>",
    "<a href=\"" + ROOT + "?clear=1\">清空记录</a>",
    "</nav>",
    "<p class=mute>累计扫描响应 " + num(scan.scanned) + " 次 · 编号 " + ids.length +
    " 个 · 最近保存 " + esc(String(scan.updatedAt || "").replace("T", " ").slice(0, 19)) + " UTC</p>",
    "</section>"
  ].join("");

  $done({ response: { status: 200, headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  }, body: html } });
})();
