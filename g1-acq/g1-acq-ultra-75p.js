/* G1 ACQ Loon Script: Ultra 20TB / 30TB · 三个月 75p (ultra-75p)
 * Upstream: https://github.com/crhywun/g1-acq (v7.12.0)
 * Mappings:
 *   exact g1.ios.20tb.m.v2      -> g1.20tb.3months_ip_75p.acq
 *   exact g1.ios.30tb.ai.pro.m  -> g1.ai.ultra.3months_ip_75p.acq
 */
"use strict";

(function () {
  var TAG = "g1-acq:ultra-75p";
  var RULES = [
    { match: "exact", from: "g1.ios.20tb.m.v2", to: "g1.20tb.3months_ip_75p.acq" },
    { match: "exact", from: "g1.ios.30tb.ai.pro.m", to: "g1.ai.ultra.3months_ip_75p.acq" }
  ];

  var url = typeof $request === "object" && $request ? $request.url : "";
  if (typeof url !== "string" || !/^https:\/\/one\.google\.com\/ai\?/.test(url)) {
    $done({});
    return;
  }

  var body = typeof $response === "object" && $response ? $response.body : undefined;
  if (typeof body !== "string" || !body) {
    console.log("[" + TAG + "] non-text or empty body");
    $done({});
    return;
  }

  function validSku(id) {
    return /^(?:g1\.|com\.google\.(?:one|gemini)\.)[A-Za-z0-9._-]{0,159}[A-Za-z0-9_-]$/.test(id);
  }

  function resolve(id) {
    if (!validSku(id)) return null;
    var selected = null;
    for (var i = 0; i < RULES.length; i += 1) {
      var rule = RULES[i];
      if (rule.match === "exact" && rule.from === id) return rule;
      if (rule.match === "prefix" && id.length > rule.from.length && id.indexOf(rule.from) === 0 &&
          (!selected || rule.from.length > selected.from.length)) {
        selected = rule;
      }
    }
    return selected;
  }

  var hits = 0;
  var counts = Object.create(null);
  var out = body.replace(
    /(^|[^A-Za-z0-9._@%-])((?:g1\.|com\.google\.(?:one|gemini)\.)[A-Za-z0-9._-]+)(?=$|[^A-Za-z0-9._-])/g,
    function (match, before, id) {
      var rule = resolve(id);
      if (!rule) return match;
      hits += 1;
      var key = id + " -> " + rule.to;
      counts[key] = (counts[key] || 0) + 1;
      return before + rule.to;
    }
  );

  if (hits > 0) {
    console.log("[" + TAG + "] rewritten hits=" + hits);
    Object.keys(counts).sort().forEach(function (k) {
      console.log("[" + TAG + "] " + k + " x" + counts[k]);
    });
    $done({ body: out });
  } else {
    console.log("[" + TAG + "] no-match");
    $done({});
  }
})();
