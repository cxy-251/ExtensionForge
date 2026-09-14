/*
 * 页面主世界（MAIN world）脚本，document_start 注入，先于抖音自己的脚本运行。
 *
 * 职责：把页面自身发出的 XHR / fetch 的 JSON 响应「抄一份」丢给隔离世界的
 * content.js；另外定期把页面上的初始状态对象也抄一份。我们不重放、不改写请求，
 * 只旁路读取——跟 002（快手）那份是同一个思路，字段/接口换成抖音的。
 *
 * content.js 载入晚于本脚本，早期响应会先入环形缓冲，等它握手后一次性补发。
 */
(() => {
  "use strict";
  if (window.__dyaPatched) return;
  window.__dyaPatched = true;

  const TAG = "dya";
  const BUFFER_LIMIT = 400;
  const buffer = [];
  let contentReady = false;

  const log = (...a) => { try { console.debug("[抖音归档][inject]", ...a); } catch (_) {} };

  // ---------- 上报 ----------

  function post(payload) {
    payload.source = TAG;
    if (contentReady) {
      window.postMessage(payload, location.origin);
    } else {
      buffer.push(payload);
      if (buffer.length > BUFFER_LIMIT) buffer.shift();
    }
  }

  function flushBuffer() {
    while (buffer.length) window.postMessage(buffer.shift(), location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.source === TAG && d.kind === "content-ready") {
      contentReady = true;
      flushBuffer();
      dumpState("hello");
    }
  });

  // ---------- 判定 ----------

  // 主页作品 aweme/post、合集 mix/aweme、点赞收藏 aweme/favorite、单作品详情
  // aweme/detail、收藏夹 aweme/listcollection —— 这几条是 dyd 那份参考工具验证过真实
  // 有效的抖音接口路径，抖音改版了再照这个思路补新的
  const KEYWORDS = /(aweme_list|aweme_detail|"aweme_id"|"desc"|bit_rate|play_addr|"digg_count"|"nickname")/i;

  function isInterestingUrl(url) {
    if (typeof url !== "string") return false;
    return /aweme\/post/i.test(url)
      || /mix\/aweme/i.test(url)
      || /aweme\/favorite/i.test(url)
      || /aweme\/detail/i.test(url)
      || /aweme\/listcollection/i.test(url)
      || /\/aweme\/v\d+\//i.test(url);
  }

  // 这条响应本身是"作品页/合集页/点赞页/详情页/收藏夹页"里的哪一种接口——跟 dyd
  // 参考实现一样，按接口类型分类。content.js 会拿这个跟"当前页面显示的是哪个
  // 标签"比对，不匹配就丢掉——防止本标签页历史上打开过的其它页面（比如点赞页）
  // 残留的回包被当成当前页面的数据采集进去。
  function classifyUrl(url) {
    if (typeof url !== "string") return "other";
    if (/aweme\/post/i.test(url)) return "post";
    if (/mix\/aweme/i.test(url)) return "collection";
    if (/aweme\/favorite/i.test(url)) return "like";
    if (/aweme\/detail/i.test(url)) return "detail";
    if (/aweme\/listcollection/i.test(url)) return "listcollection";
    return "other";
  }

  function safeParse(text) {
    if (typeof text !== "string" || text.length < 2 || text.length > 8_000_000) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // 有的响应 URL 平平无奇，但正文明显是作品数据，也收
  function forward(meta, text) {
    const looksData = KEYWORDS.test(text.slice(0, 4000)) || KEYWORDS.test(text.slice(-2000));
    if (!isInterestingUrl(meta.url) && !looksData) return;
    const json = safeParse(text);
    const srcType = classifyUrl(meta.url);
    post({ kind: "debug", url: meta.url, method: meta.method, status: meta.status || 0, len: text.length, parsed: !!json });
    if (json) post({ kind: "api", entry: { url: meta.url, method: meta.method, reqBody: meta.reqBody || "", json, srcType, at: Date.now() } });
  }

  // ---------- fetch ----------

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      const reqBody = init && typeof init.body === "string" ? init.body : "";
      const p = nativeFetch.apply(this, arguments);
      try {
        p.then((res) => {
          try {
            const status = res.status;
            res.clone().text().then((t) => forward({ url, method, reqBody, status }, t)).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      } catch (_) {}
      return p;
    };
    log("fetch 已挂钩");
  }

  // ---------- XHR ----------

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__dya = { method, url: typeof url === "string" ? url : String(url) };
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const meta = this.__dya;
      if (meta) {
        this.addEventListener("load", () => {
          try {
            const type = this.responseType;
            let text = "";
            if (type === "" || type === "text") text = this.responseText;
            else if (type === "json" && this.response) text = JSON.stringify(this.response);
            if (text) forward({ url: meta.url, method: meta.method, reqBody: typeof body === "string" ? body : "", status: this.status }, text);
          } catch (_) {}
        });
      }
      return send.apply(this, arguments);
    };
    log("XHR 已挂钩");
  }

  // ---------- 初始状态对象 ----------

  function dumpState(reason) {
    const keys = ["__INITIAL_STATE__", "__NUXT__", "INIT_STATE", "__DATA__", "RENDER_DATA"];
    for (const k of keys) {
      let v;
      try { v = window[k]; } catch { continue; }
      if (v && typeof v === "object") {
        try {
          const json = JSON.parse(JSON.stringify(v));
          post({ kind: "state", key: k, reason, json, at: Date.now() });
        } catch (_) {}
      }
    }
    // 抖音有的页面把首屏数据塞进一个 <script id="RENDER_DATA"> 里，URL-encode 过的 JSON
    try {
      const el = document.getElementById("RENDER_DATA");
      if (el && el.textContent) {
        const json = JSON.parse(decodeURIComponent(el.textContent));
        post({ kind: "state", key: "RENDER_DATA#script", reason, json, at: Date.now() });
      }
    } catch (_) {}
  }

  let stateTicks = 0;
  const stateTimer = setInterval(() => {
    stateTicks++;
    dumpState("poll");
    if (stateTicks > 20) clearInterval(stateTimer);
  }, 2000);
  window.addEventListener("load", () => dumpState("load"));
})();
