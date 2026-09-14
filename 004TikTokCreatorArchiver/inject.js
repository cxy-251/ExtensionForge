/*
 * 页面主世界（MAIN world）脚本，document_start 注入，先于 TikTok 自己的脚本运行。
 *
 * 职责：把页面自身发出的 XHR / fetch 的 JSON 响应「抄一份」丢给隔离世界的
 * content.js；另外定期把页面上的初始状态对象也抄一份。我们不重放、不改写请求，
 * 只旁路读取——这样完全不用去逆向 TikTok 那套 X-Bogus/msToken 请求签名算法，
 * 浏览器自己浏览时算好的签名请求，我们只是抄一份它自己的回包，跟 002/003 是
 * 同一个思路，字段/接口换成 TikTok 的。
 *
 * content.js 载入晚于本脚本，早期响应会先入环形缓冲，等它握手后一次性补发。
 */
(() => {
  "use strict";
  if (window.__ttaPatched) return;
  window.__ttaPatched = true;

  const TAG = "tta";
  const BUFFER_LIMIT = 400;
  const buffer = [];
  let contentReady = false;

  const log = (...a) => { try { console.debug("[TikTok归档][inject]", ...a); } catch (_) {} };

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

  // 主页作品 /api/post/item_list、点赞列表 /api/favorite/item_list、
  // 合集/擭辑 /api/playlist(或 mix)/item_list、单作品详情内嵌在页面初始状态里（不是
  // 单独接口）——这几条是公开可查的 TikTok Web 接口路径，TikTok 改版了再照这个思路补新的。
  const KEYWORDS = /(itemList|itemStruct|"authorStats"|"playAddr"|"diggCount"|"secUid"|"uniqueId")/i;

  // 故意不收 /api/recommend/item_list（首页"For You"推荐流）——这是踩过坑之后拿掉的：
  // TikTok 首页本身就是个不停自动加载推荐视频的信息流，哪怕只是这个标签页在后台悄悄
  // 刷过一次首页，也会把一堆完全不相关的陌生人视频抓进来，跟当前正在采集的主页/单
  // 视频/点赞/合集完全无关——v1 范围本来就没有"采集推荐流"这个需求，收了只有坏处。
  function isInterestingUrl(url) {
    if (typeof url !== "string") return false;
    return /\/api\/post\/item_list/i.test(url)
      || /\/api\/favorite\/item_list/i.test(url)
      || /\/api\/(playlist|mix)\/item_list/i.test(url);
  }

  // 这条响应本身是"作品页/点赞页/合集页"里的哪一种接口——跟 003 一样，按接口类型分类。
  // content.js 会拿这个跟"当前页面显示的是哪个标签"比对，不匹配就丢掉——防止本标签页
  // 历史上打开过的其它页面（比如点赞页、首页推荐流）残留的回包被当成当前页面的数据
  // 采集进去。注意：content.js 那边现在对"other"（分类不到的）一律严格拦截，不再有
  // 例外豁免，所以就算 KEYWORDS 内容嗅探兜底逮到了没匹配上面这几条 URL 规则的响应，
  // 也不会被当成当前页面数据收进去。
  function classifyUrl(url) {
    if (typeof url !== "string") return "other";
    if (/\/api\/post\/item_list/i.test(url)) return "post";
    if (/\/api\/favorite\/item_list/i.test(url)) return "like";
    if (/\/api\/(playlist|mix)\/item_list/i.test(url)) return "collection";
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
      this.__tta = { method, url: typeof url === "string" ? url : String(url) };
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const meta = this.__tta;
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
  //
  // 单视频详情页（/video/xxx）不走上面那几个 item_list 接口，作品数据直接内嵌在页面
  // 首屏的 <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> 里（老版本页面用
  // <script id="SIGI_STATE">）。主页/点赞/合集页首屏也会各自内嵌一份初始列表。

  function dumpState(reason) {
    const keys = ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE", "__NEXT_DATA__"];
    for (const id of keys) {
      try {
        const el = document.getElementById(id);
        if (el && el.textContent) {
          const json = JSON.parse(el.textContent);
          post({ kind: "state", key: id, reason, json, at: Date.now() });
        }
      } catch (_) {}
    }
    // 兜底：万一挂在 window 全局对象上而不是 <script> 标签里
    for (const k of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]) {
      try {
        const v = window[k];
        if (v && typeof v === "object") {
          const json = JSON.parse(JSON.stringify(v));
          post({ kind: "state", key: k + "#window", reason, json, at: Date.now() });
        }
      } catch (_) {}
    }
  }

  let stateTicks = 0;
  const stateTimer = setInterval(() => {
    stateTicks++;
    dumpState("poll");
    if (stateTicks > 20) clearInterval(stateTimer);
  }, 2000);
  window.addEventListener("load", () => dumpState("load"));
})();
