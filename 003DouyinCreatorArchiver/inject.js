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

  // 抖音信息流里最大、最频繁的响应本来就是视频分片/图片/字体这些二进制体，天生不可能
  // 是作品接口的 JSON 回包，靠 content-type/长度直接排除，省下整段 clone().text() 解码。
  const BINARY_CT_RE = /^(video|audio|image|font)\//i;
  const MAX_SCAN_BYTES = 3_000_000;   // aweme_list 分页 JSON 远小于此，视频分片/图片远大于此

  // 有的响应 URL 平平无奇，但正文明显是作品数据，也收
  function forward(meta, text) {
    const looksData = KEYWORDS.test(text.slice(0, 4000)) || KEYWORDS.test(text.slice(-2000));
    if (!isInterestingUrl(meta.url) && !looksData) return;
    const json = safeParse(text);
    const srcType = classifyUrl(meta.url);
    post({ kind: "debug", url: meta.url, method: meta.method, status: meta.status || 0, len: text.length, parsed: !!json });
    if (json) post({ kind: "api", entry: { url: meta.url, method: meta.method, reqBody: meta.reqBody || "", json, srcType, at: Date.now() } });
  }

  // XHR responseType === "json" 时浏览器已经帮我们解析好了对象，不用先 JSON.stringify
  // 变回文本、再让 forward() 里的 safeParse() 解析回去——已知接口 URL 时直接按"已解析
  // 对象"这条路径走，一次 JSON 转换都不用做；只有 URL 本身不像已知接口时才现转一次
  // 文本去过关键词兜底扫描（这条本来就是小概率兜底分支）。
  function forwardParsedJson(meta, jsonObj) {
    const interesting = isInterestingUrl(meta.url);
    let text = "";
    if (!interesting) {
      try { text = JSON.stringify(jsonObj); } catch (_) { text = ""; }
      if (!(KEYWORDS.test(text.slice(0, 4000)) || KEYWORDS.test(text.slice(-2000)))) return;
    }
    const srcType = classifyUrl(meta.url);
    post({ kind: "debug", url: meta.url, method: meta.method, status: meta.status || 0, len: text.length, parsed: true });
    post({ kind: "api", entry: { url: meta.url, method: meta.method, reqBody: meta.reqBody || "", json: jsonObj, srcType, at: Date.now() } });
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
            const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
            if (BINARY_CT_RE.test(ct)) return;
            const len = Number((res.headers && res.headers.get && res.headers.get("content-length")) || 0);
            if (len > MAX_SCAN_BYTES) return;
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
            let ct = "";
            try { ct = this.getResponseHeader("content-type") || ""; } catch (_) {}
            if (BINARY_CT_RE.test(ct)) return;
            const type = this.responseType;
            const reqBody = typeof body === "string" ? body : "";
            if (type === "json" && this.response) {
              forwardParsedJson({ url: meta.url, method: meta.method, reqBody, status: this.status }, this.response);
            } else if (type === "" || type === "text") {
              const text = this.responseText;
              if (text && text.length <= MAX_SCAN_BYTES) {
                forward({ url: meta.url, method: meta.method, reqBody, status: this.status }, text);
              }
            }
          } catch (_) {}
        });
      }
      return send.apply(this, arguments);
    };
    log("XHR 已挂钩");
  }

  // ---------- 初始状态对象 ----------

  // key -> 上一次 JSON.stringify 的文本。这几个全局状态对象在信息流页面上通常不小，
  // 深拷贝（JSON.parse(JSON.stringify(...))）本身就不便宜；轮询期间大多数 tick 其实
  // 什么都没变，值不值得再花一次 JSON.parse + postMessage 靠这个缓存判断——没变就直接
  // 跳过，只有 stringify 这一次扫描省不掉（要拿它来判断"变没变"本身）。
  const _lastDumpText = {};

  function dumpState(reason) {
    const keys = ["__INITIAL_STATE__", "__NUXT__", "INIT_STATE", "__DATA__", "RENDER_DATA"];
    for (const k of keys) {
      let v;
      try { v = window[k]; } catch { continue; }
      if (v && typeof v === "object") {
        try {
          const text = JSON.stringify(v);
          if (text === _lastDumpText[k]) continue;
          _lastDumpText[k] = text;
          post({ kind: "state", key: k, reason, json: JSON.parse(text), at: Date.now() });
        } catch (_) {}
      }
    }
    // 抖音有的页面把首屏数据塞进一个 <script id="RENDER_DATA"> 里，URL-encode 过的 JSON
    try {
      const el = document.getElementById("RENDER_DATA");
      if (el && el.textContent && el.textContent !== _lastDumpText["RENDER_DATA#script"]) {
        _lastDumpText["RENDER_DATA#script"] = el.textContent;
        const json = JSON.parse(decodeURIComponent(el.textContent));
        post({ kind: "state", key: "RENDER_DATA#script", reason, json, at: Date.now() });
      }
    } catch (_) {}
  }

  // 原来固定跑 20 次 x 2s = 40 秒，不管页面早就加载完了还是一直没完成都是这个时长。
  // 现在改成"页面 complete 后再等 2 个 tick 收尾就停"，配合上面的按内容去重，
  // 稳定态（没有新内容）下这个定时器几乎不再产生实际开销。
  let stateTicks = 0;
  let ticksAfterLoad = 0;
  const STATE_POLL_MAX_TICKS = 10;
  const stateTimer = setInterval(() => {
    stateTicks++;
    dumpState("poll");
    if (document.readyState === "complete") {
      ticksAfterLoad++;
      if (ticksAfterLoad >= 2) { clearInterval(stateTimer); return; }
    }
    if (stateTicks >= STATE_POLL_MAX_TICKS) clearInterval(stateTimer);
  }, 2000);
  window.addEventListener("load", () => dumpState("load"));
})();
