/*
 * TikTok 解析器，移植自 004TikTokCreatorArchiver/content.js。
 * 只采创作者主页作品：/api/post/item_list 回包的 itemList[]，以及首屏
 * __UNIVERSAL_DATA_FOR_REHYDRATION__ 里内嵌的那一页。
 */
(() => {
  "use strict";
  const { util } = globalThis.SVA;
  const { deepGet, pickUrl, collectUrls, findNodes } = util;

  function isItemLike(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (!o.id) return false;
    return !!(o.video || o.imagePost || o.desc !== undefined || o.author);
  }

  // Photo Mode 作品也带一个兼容视频/音轨字段，有真实图片就一律按图集处理
  const kindOf = (w) => (w.imageUrls.length ? "images" : "video");

  function fromItem(item) {
    if (!item || typeof item !== "object") return null;
    const videoId = item.id;
    if (!videoId) return null;

    const video = item.video || {};
    const bitrates = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
    let videoUrls = [];
    bitrates.forEach((br) => {
      const urls = deepGet(br, ["PlayAddr", "UrlList"]) || deepGet(br, ["playAddr", "urlList"]);
      if (Array.isArray(urls)) videoUrls.push(...urls);
    });
    if (!videoUrls.length) {
      videoUrls = collectUrls(
        deepGet(video, ["playAddr", "urlList"]), video.playAddr,
        deepGet(video, ["downloadAddr", "urlList"]), video.downloadAddr
      );
    }
    videoUrls = [...new Set(videoUrls)];

    const images = item.imagePost && Array.isArray(item.imagePost.images) ? item.imagePost.images : [];
    const imageUrls = images
      .map((im) => pickUrl(deepGet(im, ["imageURL", "urlList"]), deepGet(im, ["imageUrl", "urlList"])))
      .filter(Boolean);

    const uniqueId = deepGet(item, ["author", "uniqueId"]) || "";
    const author = uniqueId || deepGet(item, ["author", "nickname"]) || "未知作者";

    const w = {
      platform: "tiktok",
      videoId: String(videoId),
      author,
      title: item.desc || "",
      likeCount: deepGet(item, ["stats", "diggCount"]) || deepGet(item, ["statsV2", "diggCount"]) || 0,
      timestampMs: Number(item.createTime || 0) * 1000,
      cover: pickUrl(deepGet(video, ["cover"]), deepGet(video, ["originCover"]), deepGet(video, ["dynamicCover"])),
      videoUrl: videoUrls[0] || "",
      videoUrls,
      imageUrls,
      pageUrl: `https://www.tiktok.com/@${author}/video/${videoId}`,
      ownerId: String(uniqueId).toLowerCase()
    };
    w.kind = kindOf(w);
    return w;
  }

  function parsePayload(entry) {
    const json = entry && entry.json;
    if (!json || typeof json !== "object") return [];
    const out = [];

    findNodes(json, (n) => Array.isArray(n.itemList) && n.itemList.some((a) => a && a.id))
      .forEach((n) => n.itemList.forEach((a) => { const w = fromItem(a); if (w) out.push(w); }));

    if (!out.length) {
      findNodes(json, isItemLike, 12000).forEach((a) => { const w = fromItem(a); if (w) out.push(w); });
    }
    return out;
  }

  globalThis.SVA.adapter = {
    platform: "tiktok",
    label: "TikTok",
    theme: {
      head: "linear-gradient(90deg, #010101, #00f2ea, #ff0050)",
      accent: "#ff0050",
      on: "#010101",
      images: "#00f2ea",
      imagesInk: "#013"
    },
    parsePayload,
    kindOf,
    // 只认 www.tiktok.com/@<uniqueId>（作品页）；/video/、/liked、/playlist 等都不算
    profileOwner() {
      const m = location.pathname.match(/^\/@([^/?#]+)\/?$/);
      if (!m) return "";
      const tab = (new URLSearchParams(location.search).get("tab") || "").toLowerCase();
      if (tab && tab !== "videos") return "";
      return decodeURIComponent(m[1]).toLowerCase();
    },
    // 主页里点开作品，网址变成 /@作者/video/<id>（图文是 /photo/<id>），仍算这个作者
    contextOwner() {
      const m = location.pathname.match(/^\/@([^/?#]+)(?:\/(?:video|photo)\/\d+)?\/?$/);
      if (!m) return "";
      const tab = (new URLSearchParams(location.search).get("tab") || "").toLowerCase();
      if (tab && tab !== "videos") return "";
      return decodeURIComponent(m[1]).toLowerCase();
    },
    authorFromPage() {
      const m = location.pathname.match(/^\/@([^/?#]+)/);
      return m ? decodeURIComponent(m[1]) : "";
    },
    captchaText: /(Verify to continue|Security check|Please verify|滑动验证|请完成安全验证|拖动滑块)/i,
    captchaSelector: 'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [class*="verify" i], [class*="secsdk" i]'
  };
})();
