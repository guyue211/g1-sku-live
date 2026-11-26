/* G1 SKU Live — Loon 单文件版（采集 + 解析 + 组合探测 + 改写 + 报告）
   同一个文件同时注册到 http-request 与 http-response：
     · http-request  ：报告页 URL 本地直接应答，不转发给 Google
     · http-response ：采集与改写；报告页 URL 兜底，把 Google 的 404/302 换成报告
   这样任一侧能力不可用，报告页仍然打得开。
   Loon 运行时：$request / $response / $persistentStore / $done / console.log
   ES5 语法，无箭头函数、无模板串。 */
"use strict";

(function () {
  var VERSION = "g1-sku-live-v5";
  var ROOT = "https://one.google.com/g1-sku-live-report";
  var SCAN_KEY = "g1.live.scan.v1";
  var CFG_KEY = "g1.live.cfg.v1";
  var RUN_KEY = "g1.live.run.v1";
  var RING_KEY = "g1.live.paths.v1";
  var LIMIT = 400;
  var MAX_BODY = 8 * 1024 * 1024;
  var GEN_CAP = 12000;

  var url = (typeof $request === "object" && $request && typeof $request.url === "string")
    ? $request.url : "";
  if (!/^https:\/\/one\.google\.com\//.test(url)) { $done({}); return; }

  var hasResponse = (typeof $response === "object" && $response !== null);
  var body = hasResponse ? $response.body : undefined;
  var path = url.replace(/^https:\/\/one\.google\.com/, "").split(/[?#]/)[0] || "/";
  var isReport = /^\/g1-sku-live-report\/?$/.test(path);
  var query = (url.split("?")[1] || "");
  var method = (typeof $request === "object" && $request && $request.method) ? $request.method : "GET";
  var postBody = (typeof $request === "object" && $request && typeof $request.body === "string")
    ? $request.body : "";

  /* ================= 通用 ================= */

  function parseForm(text) {
    var out = Object.create(null);
    if (!text) return out;
    var parts = String(text).split("&");
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
  /* 原始探针：不依赖解析，直接数 body 里有没有 SKU 形态的字符串。
     「g1.」出现 0 次 → 这份响应里根本没有编号，得去找别的接口。 */
  function probeRaw(text) {
    var out = { g1: 0, cg: 0, samples: [] };
    if (typeof text !== "string") return out;
    var hits = text.match(/g1\./g);
    out.g1 = hits ? hits.length : 0;
    var cg = text.match(/com\.google/g);
    out.cg = cg ? cg.length : 0;
    var from = 0;
    while (out.samples.length < 3) {
      var at = text.indexOf("g1.", from);
      if (at < 0) break;
      out.samples.push(text.slice(Math.max(0, at - 50), at + 90)
        .replace(/\s+/g, " ").trim().slice(0, 140));
      from = at + 3;
    }
    return out;
  }

  /* 环形缓冲：记录脚本实际收到的请求。
     采集为空时，这一栏能立刻区分「流量没进来」和「body 没取到」。 */
  function notePath(entry) {
    var ring = readJson(RING_KEY, null);
    if (!ring || !(ring.rows instanceof Array)) ring = { schemaVersion: 1, rows: [] };
    ring.rows.push(entry);
    while (ring.rows.length > 30) ring.rows.shift();
    writeJson(RING_KEY, ring);
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
  function emit(payload, contentType) {
    var headers = {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    if (contentType.indexOf("html") !== -1) {
      headers["Content-Security-Policy"] =
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    }
    if (hasResponse) {
      /* http-response 阶段：覆盖 Google 的响应，404 / 302 都替换掉 */
      $done({ status: 200, headers: headers, body: payload });
    } else {
      /* http-request 阶段：本地直接应答，不转发 */
      $done({ response: { status: 200, headers: headers, body: payload } });
    }
  }

  /* ================= 解析：SKU -> 结构 ================= */

  function parseId(rawId) {
    var id = String(rawId || "");
    var out = {
      raw: id, ns: "", tier: "", cycle: "", period: "",
      kind: "entry", discount: 0, acq: /\.acq$/.test(id),
      store: "", price: "", ok: true, note: ""
    };
    if (/^com\.google\./.test(id)) {
      out.ns = "apple"; out.store = "App Store / IAP 通用编号";
      out.kind = "generic"; out.ok = false;
      out.note = "不是 Google 方案编号，无法当改写目标";
      return out;
    }
    if (/^g1\.ios\./.test(id)) { out.ns = "ios"; out.store = "iOS"; }
    else if (/^g1\.play\./.test(id)) { out.ns = "play"; out.store = "Play"; }
    else if (/^g1\./.test(id)) { out.ns = "android"; out.store = "Android"; }
    else { out.ns = "unknown"; out.ok = false; out.note = "无法识别前缀"; return out; }

    var core = id.replace(/^g1\.ios\./, "").replace(/^g1\.play\./, "").replace(/^g1\./, "");
    core = core.replace(/\.acq$/, "");
    var segs = core.split(".");

    for (var i = 0; i < segs.length; i += 1) {
      var low = segs[i].toLowerCase();
      if (!out.tier && (/^\d+(?:gb|tb)$/.test(low) || low === "helium")) out.tier = low;
      else if (!out.cycle && (low === "m" || low === "a" || low === "monthly" || low === "annual")) {
        out.cycle = (low === "m" || low === "monthly") ? "月付" : "年付";
      }
    }
    if (/eft/i.test(core)) out.kind = "trial";
    else if (/(?:^|[._])ip(?:[._]|$)/i.test(core)) out.kind = "discount";

    var dsc = core.match(/(?:^|[._])(\d+)p$/i);
    if (dsc && out.kind === "discount") out.discount = Number(dsc[1]) || 0;

    var m, n = 0;
    if ((m = core.match(/ip_(\d+)(mo|month|months|y|yr|year|years)_/i))) {
      n = Number(m[1]);
      if (/^(y|yr|year|years)$/i.test(m[2])) n = n * 12;
      out.period = n + " 个月";
    } else if ((m = core.match(/(\d+)(months?|years?)/i))) {
      n = Number(m[1]);
      if (/^years?$/i.test(m[2])) n = n * 12;
      out.period = n + " 个月";
    } else if ((m = core.match(/(?:^|[._])(\d+)(mo|yr|y)(?:[._]|$)/i))) {
      n = Number(m[1]);
      if (/^(yr|y)$/i.test(m[2])) n = n * 12;
      out.period = n + " 个月";
    }

    if (out.kind === "entry") {
      out.note = "裸入口编号，没有 offer，不能当目标"; out.ok = false;
    } else if (out.ns !== "ios") {
      out.note = "非 iOS 命名空间（" + out.store + "），iOS 收银台大概率不认"; out.ok = false;
    } else {
      out.note = "同命名空间，可作改写目标"; out.ok = true;
    }
    return out;
  }

  function kindLabel(k) {
    if (k === "trial") return "免费试用";
    if (k === "discount") return "折扣";
    if (k === "generic") return "通用";
    return "入口";
  }
  function extractPrice(ctx) {
    if (!ctx) return "";
    var m = String(ctx).match(/(?:US\$|₺|\$|￥|¥|£|€)\s?[\d][\d.,]*|[\d][\d.,]*\s?(?:TRY|USD|CNY|JPY|GBP|EUR)/);
    return m ? m[0].replace(/\s+/g, "") : "";
  }

  function genCandidates(tier) {
    var t = String(tier || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!t) return [];
    var prefixes = ["g1.ios.", "g1."];
    var cycles = ["m.", "a.", "monthly.", "annual.", ""];
    var periods = ["1month", "1months", "1mo", "2month", "2months", "3month", "3months", "3mo",
      "4month", "6month", "6months", "6mo", "9month", "12month", "12months", "12mo",
      "15month", "18month", "24month", "1y", "1yr", "1year"];
    var discounts = [50, 75, 80, 85, 90, 95, 99];
    var out = [];
    var seen = Object.create(null);
    function push(id) {
      if (seen[id]) return;
      seen[id] = 1;
      out.push(id);
    }
    for (var p = 0; p < prefixes.length; p += 1) {
      var tierForms = [t];
      if (prefixes[p] === "g1.ios.") tierForms.push("ai." + t);
      for (var tf = 0; tf < tierForms.length; tf += 1) {
        var tierStr = tierForms[tf];
        for (var c = 0; c < cycles.length; c += 1) {
          var head = prefixes[p] + tierStr + "." + cycles[c];
          for (var k = 0; k < periods.length; k += 1) {
            push(head + periods[k] + "_eft");
            push(head + periods[k] + "_eft.acq");
            for (var d = 0; d < discounts.length; d += 1) {
              push(head + periods[k] + "_ip_" + discounts[d] + "p");
              push(head + periods[k] + "_ip_" + discounts[d] + "p.acq");
              if (periods[k] === "1mo" || periods[k] === "3mo" || periods[k] === "6mo" ||
                  periods[k] === "12mo" || periods[k] === "1yr" || periods[k] === "1y") {
                push(head + "ip_" + periods[k] + "_" + discounts[d] + "p");
                push(head + "ip_" + periods[k] + "_" + discounts[d] + "p.acq");
              }
            }
          }
          push(prefixes[p] + tierStr + "." + cycles[c].replace(/\.$/, ""));
        }
      }
      push(prefixes[p] + t);
      push(prefixes[p] + t + ".subs_variant");
      push(prefixes[p] + t + ".annual");
      if (out.length > GEN_CAP) return out;
    }
    return out;
  }

  /* ================= 采集与改写 ================= */

  function collectAndRewrite() {
    var now = new Date().toISOString();
    var rawProbe = probeRaw(body);
    var TOKEN = /(^|[^A-Za-z0-9._@%-])((?:g1|com\.google\.(?:gemini|one|android\.apps\.subscriptions))\.[A-Za-z0-9._-]{1,120})(?=$|[^A-Za-z0-9._-])/g;

    var scan = readJson(SCAN_KEY, null);
    if (!scan || scan.schemaVersion !== 1 || !(scan.ids instanceof Array)) {
      scan = { schemaVersion: 1, version: VERSION, updatedAt: now, scanned: 0, ids: [] };
    }
    var index = Object.create(null);
    var i;
    for (i = 0; i < scan.ids.length && i < LIMIT; i += 1) {
      if (scan.ids[i] && typeof scan.ids[i].id === "string" && !index[scan.ids[i].id]) {
        index[scan.ids[i].id] = scan.ids[i];
      }
    }

    var found = 0;
    if (typeof body === "string" && body.length <= MAX_BODY) {
      var text = body
        .replace(/\\u002e|\\x2e|&#0*46;|&#x0*2e;|&period;/gi, ".")
        .replace(/\\u002d|&#0*45;|&#x0*2d;/gi, "-");
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
        } else if (scan.ids.length < LIMIT) {
          var from = Math.max(0, match.index - 160);
          var to = Math.min(text.length, match.index + id.length + 160);
          var ctx = text.slice(from, to)
            .replace(/<[^>]*>/g, " ")
            .replace(/\\u003c|\\u003e|\\"/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          index[id] = { id: id, count: 1, first: now, last: now, path: path, ctx: ctx };
          scan.ids.push(index[id]);
        }
      }
      scan.scanned = (Number(scan.scanned) || 0) + 1;
    }
    scan.updatedAt = now;
    scan.version = VERSION;
    writeJson(SCAN_KEY, scan);

    notePath({
      t: now.slice(11, 19),
      path: path,
      len: typeof body === "string" ? body.length : 0,
      type: typeof body === "string" ? "text" : "non-text",
      skus: found,
      g1: rawProbe.g1,
      cg: rawProbe.cg,
      samples: rawProbe.samples
    });

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

    if (typeof body === "string" && target) {
      targetObserved = body.indexOf(target) !== -1;
    }
    if (cfg.enabled && target && rewritable && typeof body === "string" && sources.length) {
      out = body.replace(TOKEN, function (whole, before, id) {
        for (var k = 0; k < sources.length; k += 1) {
          if (sources[k] === id) { hits += 1; return before + target; }
        }
        return whole;
      });
    }

    writeJson(RUN_KEY, {
      schemaVersion: 1, version: VERSION, at: now, path: path,
      sources: sources, target: target, enabled: !!cfg.enabled, rewritable: rewritable,
      bodyType: typeof body === "string" ? "text" : "non-text",
      collected: found, hits: hits, targetObserved: targetObserved,
      status: typeof body !== "string" ? "non-text"
        : (!cfg.enabled ? "disabled" : (!rewritable ? "path-skip" : (hits ? "rewritten" : "no-match")))
    });

    console.log("[g1-sku-live] " + VERSION + " path=" + path + " collected=" + found +
      " hits=" + hits + " targetObserved=" + targetObserved);
    $done(hits ? { body: out } : {});
  }

  /* ================= 报告 ================= */

  function renderReport() {
    var storageOk = typeof $persistentStore !== "undefined" && !!$persistentStore;
    var notice = "";
    var q = parseForm(query);

    if (q["clear"] === "1") {
      var a = writeJson(SCAN_KEY, { schemaVersion: 1, version: VERSION, updatedAt: "", scanned: 0, ids: [] });
      var b = writeJson(RUN_KEY, { schemaVersion: 1, version: VERSION, at: "", hits: 0, collected: 0 });
      notice = (a && b) ? "采集与执行记录已清空。" : "清空未完成，存储接口异常。";
    }
    if (method === "POST" || q["save"] === "1") {
      var form = parseForm(method === "POST" ? postBody : query);
      var tgt = (form["target"] || "").trim();
      var rawS = (form["sources"] || "").split(/[,\s]+/);
      var srcs = [];
      for (var si = 0; si < rawS.length; si += 1) {
        var oneS = rawS[si].trim();
        if (oneS && srcs.indexOf(oneS) < 0) srcs.push(oneS);
      }
      var cfgNew = {
        schemaVersion: 1,
        enabled: form["enabled"] === "1" || form["enabled"] === "on" || form["enabled"] === "true",
        sources: srcs, target: tgt
      };
      notice = writeJson(CFG_KEY, cfgNew)
        ? "配置已保存：" + (cfgNew.enabled ? "启用" : "停用") + " · " + srcs.length + " 个源 → " + (tgt || "（空）")
        : "配置保存失败。";
    }

    var scan = readJson(SCAN_KEY, { schemaVersion: 1, version: "", updatedAt: "", scanned: 0, ids: [] });
    var run = readJson(RUN_KEY, { schemaVersion: 1, version: "", at: "", hits: 0, collected: 0 });
    var cfg = readJson(CFG_KEY, { schemaVersion: 1, enabled: false, sources: [], target: "" });
    var ring = readJson(RING_KEY, { schemaVersion: 1, rows: [] });
    var ringRows = (ring.rows instanceof Array) ? ring.rows.slice().reverse() : [];
    var ids = (scan.ids instanceof Array) ? scan.ids : [];
    var byId = Object.create(null);
    var i;
    for (i = 0; i < ids.length; i += 1) {
      if (ids[i] && typeof ids[i].id === "string") byId[ids[i].id] = ids[i];
    }

    var probe = null;
    var candRaw = q["cand"];
    if (typeof candRaw === "string" && candRaw.trim()) {
      var list = candRaw.split(/[\s,，、;；]+/);
      var rows = [];
      var seenC = Object.create(null);
      for (i = 0; i < list.length; i += 1) {
        var cand = list[i].trim();
        if (!cand || seenC[cand]) continue;
        seenC[cand] = 1;
        var hit = byId[cand];
        var parsed = parseId(cand);
        parsed.price = hit ? extractPrice(hit.ctx) : "";
        parsed.live = !!hit;
        parsed.count = hit ? num(hit.count) : 0;
        parsed.ctx = hit ? (hit.ctx || "") : "";
        rows.push(parsed);
      }
      probe = { candidates: rows, live: 0, dead: 0, usable: 0 };
      for (i = 0; i < rows.length; i += 1) {
        if (rows[i].live) probe.live += 1; else probe.dead += 1;
        if (rows[i].live && rows[i].ok) probe.usable += 1;
      }
    }

    var gen = null;
    if (typeof q["gen"] === "string" && q["gen"].trim()) {
      var genTier = q["gen"].trim();
      var all = genCandidates(genTier);
      var liveHits = [];
      for (i = 0; i < all.length; i += 1) {
        if (byId[all[i]]) {
          var gp = parseId(all[i]);
          gp.count = num(byId[all[i]].count);
          gp.price = extractPrice(byId[all[i]].ctx);
          liveHits.push(gp);
        }
      }
      liveHits.sort(function (x, y) {
        return (y.kind === "trial" ? 1 : 0) - (x.kind === "trial" ? 1 : 0) || y.discount - x.discount;
      });
      gen = { tier: genTier, generated: all.length, live: liveHits.length, hits: liveHits };
    }

    if (q["format"] === "json") {
      emit(JSON.stringify({
        schemaVersion: 1, version: VERSION, storageAvailable: storageOk,
        config: cfg, run: run, probe: probe, gen: gen, paths: ringRows,
        scan: {
          scanned: num(scan.scanned), updatedAt: scan.updatedAt || "", total: ids.length,
          ids: ids.map(function (r) {
            var p = parseId(r.id);
            p.count = num(r.count);
            p.ctx = r.ctx || "";
            p.price = extractPrice(r.ctx);
            return p;
          })
        }
      }, null, 2), "application/json; charset=utf-8");
      return;
    }

    var parsedRows = [];
    for (i = 0; i < ids.length; i += 1) {
      if (!ids[i] || typeof ids[i].id !== "string") continue;
      var pr = parseId(ids[i].id);
      pr.count = num(ids[i].count);
      pr.price = extractPrice(ids[i].ctx);
      parsedRows.push(pr);
    }
    var trialRows = [], discountRows = [], entryRows = [], appleRows = [];
    for (i = 0; i < parsedRows.length; i += 1) {
      var kd = parsedRows[i].kind;
      if (kd === "trial") trialRows.push(parsedRows[i]);
      else if (kd === "discount") discountRows.push(parsedRows[i]);
      else if (kd === "generic") appleRows.push(parsedRows[i]);
      else entryRows.push(parsedRows[i]);
    }
    function byCount(x, y) { return num(y.count) - num(x.count) || (x.raw < y.raw ? -1 : 1); }
    trialRows.sort(byCount); discountRows.sort(byCount); entryRows.sort(byCount); appleRows.sort(byCount);

    function skuTable(list, emptyText) {
      if (!list.length) return "<tr><td colspan=7 class=mute>" + esc(emptyText || "暂无。") + "</td></tr>";
      var out = [];
      for (var n = 0; n < list.length; n += 1) {
        var r = list[n];
        out.push("<tr><td><code>" + esc(r.raw) + "</code></td>" +
          "<td>" + esc(r.tier || "-") + "</td>" +
          "<td>" + esc(r.cycle || "-") + "</td>" +
          "<td>" + esc(r.period || "-") + "</td>" +
          "<td>" + (r.kind === "discount" ? (r.discount ? r.discount + "% off" : "-")
            : (r.kind === "trial" ? "免费" : "-")) + "</td>" +
          "<td class=mute>" + esc(r.price || "-") + "</td>" +
          "<td>" + (r.ok ? "<span class=ok>可作目标</span>" : "<span class=bad>" + esc(r.note) + "</span>") + "</td></tr>");
      }
      return out.join("");
    }
    var HEAD = "<thead><tr><th>编号</th><th>档位</th><th>周期</th><th>期间</th><th>优惠</th><th>价格</th><th>判定</th></tr></thead>";

    var probeHtml = "";
    if (probe) {
      var prs = [];
      for (i = 0; i < probe.candidates.length; i += 1) {
        var c = probe.candidates[i];
        prs.push("<tr><td><code>" + esc(c.raw) + "</code></td>" +
          "<td>" + (c.live ? "<span class=ok>下发过</span>" : "<span class=bad>未采集到</span>") + "</td>" +
          "<td>" + esc(c.tier || "-") + "</td><td>" + esc(c.cycle || "-") + "</td>" +
          "<td>" + (c.kind === "discount" ? (c.discount + "% off") : kindLabel(c.kind)) + "</td>" +
          "<td class=mute>" + esc(c.price || "-") + "</td>" +
          "<td>" + (c.ok ? "<span class=ok>可作目标</span>" : "<span class=bad>" + esc(c.note) + "</span>") + "</td></tr>");
        if (c.ctx) prs.push("<tr><td colspan=7 class=ctx>" + esc(c.ctx.slice(0, 150)) + "</td></tr>");
      }
      probeHtml = "<section><h2>候选探测结果</h2><p>下发过 <strong>" + probe.live +
        "</strong> · 未采集到 <strong>" + probe.dead + "</strong> · 可直接当目标 <strong>" + probe.usable + "</strong></p>" +
        "<div class=scroll><table><thead><tr><th>编号</th><th>服务端</th><th>档位</th><th>周期</th><th>优惠</th><th>价格</th><th>判定</th></tr></thead><tbody>" +
        prs.join("") + "</tbody></table></div></section>";
    }

    var genHtml = "";
    if (gen) {
      var gr = [];
      for (i = 0; i < gen.hits.length; i += 1) {
        var g1 = gen.hits[i];
        gr.push("<tr><td><code>" + esc(g1.raw) + "</code></td><td>" + kindLabel(g1.kind) + "</td>" +
          "<td>" + (g1.kind === "discount" ? (g1.discount + "% off") : (g1.kind === "trial" ? "免费" : "-")) + "</td>" +
          "<td>" + esc(g1.period || "-") + "</td><td class=mute>" + esc(g1.price || "-") + "</td>" +
          "<td>" + (g1.ok ? "<span class=ok>可作目标</span>" : "<span class=bad>" + esc(g1.note) + "</span>") + "</td></tr>");
      }
      genHtml = "<section><h2>组合生成 · " + esc(gen.tier) + "</h2><p>生成 <strong>" + gen.generated +
        "</strong> 个候选，其中 <strong>" + gen.live + "</strong> 个真的被服务端下发过" +
        (gen.live ? "" : " —— 这个档位没有可用的 offer 组合") + "。</p>" +
        (gen.live ? "<div class=scroll><table><thead><tr><th>编号</th><th>类型</th><th>优惠</th><th>期间</th><th>价格</th><th>判定</th></tr></thead><tbody>" +
          gr.join("") + "</tbody></table></div>" : "") + "</section>";
    }

    var html = [
      "<!doctype html><html lang=zh-CN><meta charset=utf-8>",
      "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>G1 SKU Live</title>",
      "<style>",
      "body{font:15px/1.65 -apple-system,system-ui,sans-serif;max-width:960px;margin:0 auto;padding:20px 16px 60px;color:#16202e;background:#f4f6fa}",
      "h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;color:#33445c}",
      "section{background:#fff;border:1px solid #dbe2ec;border-radius:12px;padding:16px;margin:14px 0}",
      "code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;overflow-wrap:anywhere}",
      "table{border-collapse:collapse;width:100%;font-size:13px}",
      "th,td{padding:6px 8px;border-bottom:1px solid #e6ebf2;text-align:left;vertical-align:top}",
      "th{color:#5a6b82;font-weight:600;white-space:nowrap}",
      ".scroll{overflow:auto;max-height:520px}.mute{color:#7b8798}.ctx{color:#8794a6;font-size:12px;background:#fafbfd}",
      ".ok{color:#0d7a3e;font-weight:600}.bad{color:#b3261e}",
      ".note{background:#eef3fb;border-radius:8px;padding:9px 11px;color:#33445c;font-size:13px}",
      "input[type=text],textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cfd8e6;border-radius:8px;font:13px ui-monospace,Menlo,monospace;background:#fbfcfe}",
      "textarea{min-height:84px;resize:vertical}",
      "button{padding:9px 18px;border:0;border-radius:8px;background:#1a56b8;color:#fff;font-size:14px;margin-top:8px}",
      "label{display:inline-flex;gap:6px;align-items:center;margin:8px 0}",
      "nav a{display:inline-block;margin:0 12px 6px 0;color:#1a56b8;text-decoration:none;font-size:13px}",
      "</style>",
      "<h1>G1 SKU Live</h1>",
      "<p class=mute>v3 · 采集 / 解析 / 组合探测 · 数据不出设备</p>",
      notice ? "<p class=note>" + esc(notice) + "</p>" : "",
      storageOk ? "" : "<p class=note>本地存储接口不可用，本页只读。</p>",
      num(scan.scanned) === 0
        ? "<p class=note>脚本已生效，但还没采集到任何响应。先去 Google One App 里打开「升级 / 方案」页，再回来刷新本页。</p>"
        : "",

      "<section><h2>汇总</h2>",
      "<p style=\"font-size:16px\">累计扫描 <strong>" + num(scan.scanned) +
      "</strong> 个响应 · 采集到编号 <strong>" + ids.length + "</strong> 个</p>",
      (function () {
        var lastAi = null;
        for (var z = 0; z < ringRows.length; z += 1) {
          if (/^\/ai$/.test(ringRows[z].path || "")) { lastAi = ringRows[z]; break; }
        }
        if (!lastAi) return "<p class=mute>还没见到 <code>/ai</code> 响应。进 Google One → 升级 → 方案页，让它重新拉一次。</p>";
        return "<p><code>/ai</code> 最近一次：body " + (lastAi.len || 0) + " B · 采集到 <strong>" +
          (lastAi.skus || 0) + "</strong> 个编号 · body 里 <code>g1.</code> 出现 <strong>" +
          (lastAi.g1 || 0) + "</strong> 次</p>" +
          (lastAi.g1 === 0
            ? "<p class=note>body 里一次 <code>g1.</code> 都没有 —— 这个响应不含编号，编号来自别的接口。</p>"
            : (lastAi.skus === 0
              ? "<p class=note>有 <code>g1.</code> 但没解析出编号 —— 形态不匹配，看下面的样本。</p>"
              : ""));
      })(),
      "</section>",

      "<section><h2>最近一次执行</h2>",
      "<p>路径 <code>" + esc(run.path || "-") + "</code> · 状态 <strong>" + esc(run.status || "无记录") +
      "</strong> · 本次采集 " + num(run.collected) + " · 命中 " + num(run.hits) + "</p>",
      "<p>目标 <code>" + esc(cfg.target || "（未设置）") + "</code> · 服务端下发过该目标：" +
      (run.targetObserved ? "<span class=ok>是</span>" : "<span class=bad>否</span>") + "</p></section>",

      "<section><h2>脚本收到的请求 · " + ringRows.length + "</h2>",
      "<p class=mute>看 <code>SKU</code> 与 <code>g1.</code> 两列：前者是解析出来的编号数，后者是 body 里 <code>g1.</code> 出现的原始次数。</p>",
      (ringRows.length ? "<div class=scroll><table><thead><tr><th>时间</th><th>路径</th><th>body</th><th>SKU</th><th>g1.</th><th>样本</th></tr></thead><tbody>" +
        ringRows.map(function (r) {
          return "<tr><td class=mute>" + esc(r.t || "") + "</td><td><code>" + esc(r.path || "") +
            "</code></td><td>" + esc((r.type || "") + " " + (r.len || 0) + " B") + "</td>" +
            "<td>" + (r.skus || 0) + "</td><td>" + (r.g1 || 0) + "</td>" +
            "<td class=ctx>" + esc((r.samples && r.samples[0]) || "") + "</td></tr>" +
            (r.samples && r.samples.length > 1
              ? "<tr><td colspan=6 class=ctx>" + esc(r.samples.slice(1).join(" ｜ ")) + "</td></tr>"
              : "");
        }).join("") + "</tbody></table></div>" : "") + "</section>",

      "<section><h2>组合生成（找可替换的 offer）</h2>",
      "<form method=get action=\"" + ROOT + "\">",
      "<p><label>档位（20tb / 30tb / 2tb / 10tb / helium / 100gb）</label>",
      "<input type=text name=gen placeholder=\"20tb\" value=\"" + esc(q["gen"] || "") + "\"></p>",
      "<button type=submit>生成并比对</button>",
      "<p class=mute>按 <code>g1.ios.</code> 与 <code>g1.</code> 两套前缀 × 词序 × 周期 × 期间 × 折扣率展开候选，只列出服务端真的下发过的。</p>",
      "</form></section>",
      genHtml,

      "<section><h2>候选探测</h2><form method=get action=\"" + ROOT + "\">",
      "<p><label>贴候选编号，一行一个</label>",
      "<textarea name=cand placeholder=\"g1.ios.20tb.m.3month_ip_90p.acq\"></textarea></p>",
      "<button type=submit>探测</button></form></section>",
      probeHtml,

      "<section><h2>改写配置</h2><form method=post action=\"" + ROOT + "\">",
      "<p><label>目标编号</label><input type=text name=target value=\"" + esc(cfg.target) + "\" placeholder=\"从可作目标的编号里选一个\"></p>",
      "<p><label>源编号（逗号或换行分隔）</label><textarea name=sources>" +
        esc((cfg.sources instanceof Array) ? cfg.sources.join("\n") : "") + "</textarea></p>",
      "<p><label><input type=checkbox name=enabled value=1" + (cfg.enabled ? " checked" : "") + "> 启用改写（仅 /ai、/plans）</label></p>",
      "<button type=submit>保存</button></form></section>",

      "<section><h2>免费试用 · " + trialRows.length + "</h2><div class=scroll><table>" + HEAD +
        "<tbody>" + skuTable(trialRows, "服务端没下发过任何试用编号。") + "</tbody></table></div></section>",
      "<section><h2>折扣 · " + discountRows.length + "</h2><div class=scroll><table>" + HEAD +
        "<tbody>" + skuTable(discountRows, "服务端没下发过任何折扣编号。") + "</tbody></table></div></section>",
      "<section><h2>入口编号 · " + entryRows.length + "</h2><p class=mute>方案入口，本身没有 offer，只能当改写的源。</p>" +
        "<div class=scroll><table>" + HEAD + "<tbody>" + skuTable(entryRows) + "</tbody></table></div></section>",
      "<section><h2>其它 · " + appleRows.length + "</h2><div class=scroll><table>" + HEAD +
        "<tbody>" + skuTable(appleRows) + "</tbody></table></div></section>",

      "<section><h2>操作</h2><nav>",
      "<a href=\"" + ROOT + "?format=json\">导出 JSON</a>",
      "<a href=\"" + ROOT + "\">刷新</a>",
      "<a href=\"" + ROOT + "?clear=1\">清空记录</a>",
      "</nav><p class=mute>累计扫描 " + num(scan.scanned) + " 次 · 编号 " + ids.length +
      " 个 · 保存于 " + esc(String(scan.updatedAt || "").replace("T", " ").slice(0, 19)) + " UTC</p></section>"
    ].join("");

    emit(html, "text/html; charset=utf-8");
  }

  /* ================= 入口 ================= */
  if (isReport) { renderReport(); return; }
  if (!hasResponse) { $done({}); return; }
  collectAndRewrite();
})();
