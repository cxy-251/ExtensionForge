/*
 * 隔离世界里三个平台共用的小工具。manifest 里每个平台的 content_scripts 都是
 * common.js → adapter-<平台>.js → panel.js 的顺序，同一个隔离世界共享全局，
 * adapter 往 SVA.adapter 上挂自己，panel.js 只认这个接口。
 *
 * adapter 接口（每个平台各自实现）：
 *   platform        "kuaishou" | "douyin" | "tiktok"（和 background.js 的 PLATFORMS 对应）
 *   label           面板标题里显示的平台名
 *   theme           { head, accent, on, images, imagesInk }
 *   profileOwner()  当前页面是创作者主页「作品」页时返回主页主人的 id，否则返回 ""；
 *                   返回 "" 的页面一律不出面板、不采集
 *   parsePayload(entry)   作品列表回包 / 首屏状态 → Work 数组
 *   kindOf(work)          合并多次回包后重新判定 "video" / "images"
 *   authorFromPage()      还没采到作者名时，从页面上猜一个
 *   captchaText / captchaSelector   自动下滑时识别安全验证
 *
 * Work 对象：
 *   { platform, videoId, kind, author, title, likeCount, timestampMs, cover,
 *     videoUrl, videoUrls[], imageUrls[], pageUrl, ownerId }
 *   ownerId 是作品作者的 id，用来和 profileOwner() 比对，不是这个主页主人的作品不收
 */
(() => {
  "use strict";
  if (globalThis.SVA) return;

  const isHttp = (u) => typeof u === "string" && /^https?:\/\//.test(u);

  function urlOf(x) {
    return typeof x === "string" ? x : x && (x.url || x.cdnUrl || x.photoUrl);
  }

  const util = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rand: (a, b) => a + Math.random() * (b - a),
    isHttp,

    deepGet(obj, path) {
      let cur = obj;
      for (const k of path) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = cur[k];
      }
      return cur;
    },

    pickUrl(...cands) {
      for (const c of cands) {
        if (isHttp(c)) return c;
        if (Array.isArray(c)) {
          for (const x of c) {
            const u = urlOf(x);
            if (isHttp(u)) return u;
          }
        }
      }
      return "";
    },

    collectUrls(...cands) {
      const seen = new Set();
      for (const c of cands) {
        const arr = Array.isArray(c) ? c : [c];
        for (const x of arr) {
          const u = urlOf(x);
          if (isHttp(u)) seen.add(u);
        }
      }
      return [...seen];
    },

    // 在任意结构里递归找满足条件的节点
    findNodes(root, test, cap) {
      const out = [];
      const budget = { n: cap || 8000 };
      (function walk(node) {
        if (!node || typeof node !== "object" || budget.n-- <= 0) return;
        try { if (test(node)) out.push(node); } catch (_) {}
        const vals = Array.isArray(node) ? node : Object.keys(node).map((k) => node[k]);
        for (const v of vals) if (v && typeof v === "object") walk(v);
      })(root);
      return out;
    },

    sanitize(name) {
      return String(name == null ? "" : name)
        .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "untitled";
    },

    // 秒级、毫秒级时间戳都认（快手两种都有）
    dateStr(ms) {
      const n = Number(ms) || 0;
      const d = new Date(n < 1e12 && n > 0 ? n * 1000 : n || Date.now());
      if (Number.isNaN(d.getTime())) return "";
      const p = (x) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },

    titleAuthor() {
      return document.title.replace(/[-_|（(].*$/, "").trim();
    }
  };

  globalThis.SVA = { util, adapter: null };
})();
