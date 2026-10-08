/*
 * 页面主世界（MAIN world）脚本，document_start 注入，先于平台自己的脚本运行。
 *
 * 只做一件事：把「创作者主页作品列表」接口的 JSON 响应抄一份 postMessage 给隔离世界的
 * content 脚本，外加页面首屏的初始状态对象（首屏那一页作品有时直接内嵌在里面）。
 * 不重放、不改写请求，只旁路读——所以完全不用碰各家的请求签名。
 * 不认识的接口一律不转发，不做内容嗅探：点赞、合集、详情、推荐流都不收。
 *
 * content 脚本载入晚于本脚本，早期响应先入环形缓冲，等它握手后一次性补发。
 */
(() => {
  "use strict";
  if (window.__svaPatched) return;
  window.__svaPatched = true;

  const TAG = "sva";

  const CONFIGS = {
    kuaishou: {
      hosts: /(^|\.)kuaishou\.com$/,
      // 网页版主页作品走 graphql（operationName visionProfilePhotoList，在请求体里），
      // 老接口/移动端是 profile/public、profile/feed —— 参考 dyd/src-deobfuscated/service/ks.annotated.js
      isProfileFeed: (url, body) =>
        (/\/graphql/i.test(url) && /visionProfilePhotoList/.test(body)) ||
        /\/profile\/(public|feed)\b/i.test(url),
      windowKeys: ["__APOLLO_STATE__"],
      scriptIds: []
    },
    douyin: {
      hosts: /(^|\.)douyin\.com$/,
      isProfileFeed: (url) => /\/aweme\/post\//i.test(url),
      windowKeys: [],
      // 抖音把首屏数据塞进 <script id="RENDER_DATA">，URL-encode 过的 JSON
      scriptIds: [{ id: "RENDER_DATA", decode: true }]
    },
    tiktok: {
      hosts: /(^|\.)tiktok\.com$/,
      isProfileFeed: (url) => /\/api\/post\/item_list/i.test(url),
      windowKeys: [],
      scriptIds: [{ id: "__UNIVERSAL_DATA_FOR_REHYDRATION__" }, { id: "SIGI_STATE" }]
    }
  };

  let platform = null;
  for (const [k, c] of Object.entries(CONFIGS)) if (c.hosts.test(location.hostname)) { platform = k; break; }
  if (!platform) return;
  const C = CONFIGS[platform];

  const BUFFER_LIMIT = 200;
  const buffer = [];
  let contentReady = false;

  const log = (...a) => { try { console.debug("[短视频归档][inject]", ...a); } catch (_) {} };

  // ---------- 上报 ----------

  function post(payload) {
    payload.source = TAG;
    payload.platform = platform;
    if (contentReady) {
      window.postMessage(payload, location.origin);
    } else {
      buffer.push(payload);
      if (buffer.length > BUFFER_LIMIT) buffer.shift();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.source === TAG && d.kind === "content-ready") {
      contentReady = true;
      while (buffer.length) window.postMessage(buffer.shift(), location.origin);
      dumpState();
    }
  });

  function emit(meta, json) {
    if (!json || typeof json !== "object") return;
    post({ kind: "api", entry: { url: meta.url, reqBody: meta.reqBody, json, at: Date.now() } });
  }

  function emitText(meta, text) {
    if (typeof text !== "string" || text.length < 2) return;
    try { emit(meta, JSON.parse(text)); } catch (_) {}
  }

  // ---------- fetch ----------

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || String(input || "");
      const reqBody = init && typeof init.body === "string" ? init.body : "";
      const p = nativeFetch.apply(this, arguments);
      if (C.isProfileFeed(url, reqBody)) {
        p.then((res) => res.clone().text())
          .then((t) => emitText({ url, reqBody }, t))
          .catch(() => {});
      }
      return p;
    };
    log(platform, "fetch 已挂钩");
  }

  // ---------- XHR ----------

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__svaUrl = typeof url === "string" ? url : String(url);
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const url = this.__svaUrl || "";
      const reqBody = typeof body === "string" ? body : "";
      if (C.isProfileFeed(url, reqBody)) {
        this.addEventListener("load", () => {
          try {
            const type = this.responseType;
            if (type === "json") emit({ url, reqBody }, this.response);
            else if (type === "" || type === "text") emitText({ url, reqBody }, this.responseText);
          } catch (_) {}
        });
      }
      return send.apply(this, arguments);
    };
    log(platform, "XHR 已挂钩");
  }

  // ---------- 初始状态对象 ----------
  //
  // 按内容去重：轮询期间大多数 tick 什么都没变，没变就不再 parse + postMessage。

  const lastDumpText = {};

  function dumpState() {
    for (const k of C.windowKeys) {
      let v;
      try { v = window[k]; } catch { continue; }
      if (!v || typeof v !== "object") continue;
      try {
        const text = JSON.stringify(v);
        if (text === lastDumpText[k]) continue;
        lastDumpText[k] = text;
        post({ kind: "state", key: k, json: JSON.parse(text), at: Date.now() });
      } catch (_) {}
    }
    for (const s of C.scriptIds) {
      try {
        const el = document.getElementById(s.id);
        const raw = el && el.textContent;
        const cacheKey = s.id + "#script";
        if (!raw || raw === lastDumpText[cacheKey]) continue;
        lastDumpText[cacheKey] = raw;
        const json = JSON.parse(s.decode ? decodeURIComponent(raw) : raw);
        post({ kind: "state", key: cacheKey, json, at: Date.now() });
      } catch (_) {}
    }
  }

  // 页面 complete 后再等 2 个 tick 收尾就停，最多 10 个 tick
  let stateTicks = 0;
  let ticksAfterLoad = 0;
  const stateTimer = setInterval(() => {
    stateTicks++;
    dumpState();
    if (document.readyState === "complete" && ++ticksAfterLoad >= 2) { clearInterval(stateTimer); return; }
    if (stateTicks >= 10) clearInterval(stateTimer);
  }, 2000);
  window.addEventListener("load", dumpState);
})();
