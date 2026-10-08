/*
 * 抖音解析器，移植自 003DouyinCreatorArchiver/content.js（已移除，见 git 历史；
 * 接口最初参考 DyD 的 service/dy.js）。
 * 只采创作者主页「作品」标签：aweme/post 回包的 aweme_list[]，以及首屏 RENDER_DATA。
 */
(() => {
  "use strict";
  const { util } = globalThis.SVA;
  const { deepGet, pickUrl, collectUrls, findNodes } = util;

  function isAwemeLike(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (!o.aweme_id) return false;
    return !!(o.video || o.images || o.desc !== undefined || o.author);
  }

  // 图集（多图+BGM）接口里也常附带一个"兼容合成视频"字段，取到手很多时候是纯音轨——
  // 只要有真实 images 就按图集处理，别让那个字段抢走（003 上线后踩过的坑）
  const kindOf = (w) => (w.imageUrls.length ? "images" : "video");

  function fromAweme(aweme) {
    if (!aweme || typeof aweme !== "object") return null;
    const videoId = aweme.aweme_id;
    if (!videoId) return null;

    const video = aweme.video || {};
    // bit_rate[] 是官方给的多档画质数组，一般第一档最高
    const bitRates = Array.isArray(video.bit_rate) ? video.bit_rate : [];
    let videoUrls = [];
    bitRates.forEach((br) => {
      const urls = deepGet(br, ["play_addr", "url_list"]);
      if (Array.isArray(urls)) videoUrls.push(...urls);
    });
    if (!videoUrls.length) videoUrls = collectUrls(deepGet(video, ["play_addr", "url_list"]));
    // 兜底：uri 拼 1080p 播放直链，dyd 里验证过的公式
    if (!videoUrls.length) {
      const uri = deepGet(video, ["play_addr", "uri"]) || deepGet(bitRates, [0, "play_addr", "uri"]);
      if (uri) videoUrls.push(`https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`);
    }
    videoUrls = [...new Set(videoUrls)];

    const imageUrls = Array.isArray(aweme.images)
      ? aweme.images.map((im) => pickUrl(deepGet(im, ["url_list"]))).filter(Boolean)
      : [];

    const w = {
      platform: "douyin",
      videoId: String(videoId),
      author: deepGet(aweme, ["author", "nickname"]) || "未知作者",
      title: aweme.desc || aweme.preview_title || "",
      likeCount: deepGet(aweme, ["statistics", "digg_count"]) || 0,
      timestampMs: Number(aweme.create_time || 0) * 1000,   // 秒级
      cover: pickUrl(deepGet(video, ["cover", "url_list"]), deepGet(video, ["origin_cover", "url_list"])),
      videoUrl: videoUrls[0] || "",
      videoUrls,
      imageUrls,
      pageUrl: `https://www.douyin.com/video/${videoId}`,
      ownerId: String(deepGet(aweme, ["author", "sec_uid"]) || "")
    };
    w.kind = kindOf(w);
    return w;
  }

  function parsePayload(entry) {
    const json = entry && entry.json;
    if (!json || typeof json !== "object") return [];
    const out = [];

    findNodes(json, (n) => Array.isArray(n.aweme_list) && n.aweme_list.some((a) => a && a.aweme_id))
      .forEach((n) => n.aweme_list.forEach((a) => { const w = fromAweme(a); if (w) out.push(w); }));

    if (!out.length) {
      findNodes(json, isAwemeLike, 12000).forEach((a) => { const w = fromAweme(a); if (w) out.push(w); });
    }
    return out;
  }

  globalThis.SVA.adapter = {
    platform: "douyin",
    label: "抖音",
    theme: {
      head: "linear-gradient(90deg, #010101, #fe2c55)",
      accent: "#fe2c55",
      on: "#010101",
      images: "#25f4ee",
      imagesInk: "#013"
    },
    parsePayload,
    kindOf,
    // 只认 www.douyin.com/user/<sec_uid> 的「作品」标签（没有 showTab 或 showTab=post）；
    // 点赞、收藏、合集标签都不算。自己的主页是 /user/self，拿不到 sec_uid，返回 "self" 不比对作者
    profileOwner() {
      const m = location.pathname.match(/^\/user\/([^/?#]+)\/?$/);
      if (!m) return "";
      const tab = new URLSearchParams(location.search).get("showTab");
      if (tab && tab !== "post") return "";
      return decodeURIComponent(m[1]);
    },
    authorFromPage: () => util.titleAuthor(),
    // 抖音比快手多一种"按顺序点字/图"的验证
    captchaText: /(请完成|安全验证|滑动验证|拖动滑块|向右滑动|完成拼图|点击验证|请依次点击|旋转图片|验证不通过)/,
    captchaSelector: 'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [class*="slider-verify" i], [class*="verify-slider" i], [class*="secsdk" i]'
  };
})();
