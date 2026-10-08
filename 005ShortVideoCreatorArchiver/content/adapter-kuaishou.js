/*
 * 快手解析器，移植自 002KuaishouCreatorArchiver/content.js（已移除，见 git 历史；其快手分支
 * 最初又移植自 dyd/src-deobfuscated/service/ks.annotated.js）。只保留创作者主页作品列表用得到的分支：
 * visionProfilePhotoList 的 feeds[]、profile/public 的 list[]，字段多名兜底。
 * 单作品详情、图集分享页那些分支不要了——005 只采主页。
 */
(() => {
  "use strict";
  const { util } = globalThis.SVA;
  const { deepGet, pickUrl, collectUrls, findNodes, isHttp } = util;

  function buildAtlas(atlas) {
    if (typeof atlas === "string") { try { atlas = JSON.parse(atlas); } catch { return []; } }
    if (!atlas || typeof atlas !== "object") return [];
    const hosts = []
      .concat(atlas.cdn || [])
      .concat((atlas.cdnList || []).map((c) => c && c.cdn))
      .filter(Boolean);
    const host = hosts[0];
    const list = atlas.list || atlas.images || [];
    return list
      .map((item) => {
        const p = typeof item === "string" ? item : item && (item.url || item.path || "");
        if (!p) return "";
        if (isHttp(p)) return p;
        if (!host) return "";
        return "https://" + host + (p.startsWith("/") ? p : "/" + p);
      })
      .filter(Boolean);
  }

  // 兜底：快手改了字段名时，直接在对象子树里捞任何 .mp4 直链
  function deepFindMp4(root) {
    const out = new Set();
    (function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 6) return;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === "string") {
          if (/^https?:\/\/[^\s"']+\.mp4(\?[^\s"']*)?$/i.test(v)) out.add(v);
        } else if (v && typeof v === "object") {
          walk(v, depth + 1);
        }
      }
    })(root, 0);
    return [...out];
  }

  function isPhotoLike(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (!(o.photoId || o.id || o.photo_id)) return false;
    return !!(
      o.photoUrl || o.photoH265Url || o.photoH264Url || o.mp4Url ||
      o.mainMvUrls || o.mainMvUrl || o.srcNoMark || o.playUrl ||
      o.caption !== undefined || o.coverUrl || o.coverUrls ||
      Array.isArray(o.imgUrls) || o.ext_params || o.atlas ||
      o.duration !== undefined
    );
  }

  const kindOf = (w) => (w.imageUrls.length && !w.videoUrl ? "images" : "video");

  function fromPhoto(photo, author) {
    if (!photo || typeof photo !== "object") return null;
    const rawId = photo.photoId || photo.id || photo.photoIdStr || photo.photo_id;
    if (!rawId) return null;
    const videoId = String(rawId).replace(/^\w+:/, "");   // Apollo 里可能是 "VisionPhoto:3xxx"

    const atlas = deepGet(photo, ["ext_params", "atlas"]) || photo.atlas;
    let imageUrls = [];
    if (Array.isArray(photo.imgUrls) && photo.imgUrls.length) imageUrls = collectUrls(photo.imgUrls);
    else if (atlas) imageUrls = buildAtlas(atlas);

    // /rest/v/profile/feed 实际字段是 photoUrls / photoH265Urls（[{cdn,url}]），老字段单数兜底
    let videoUrls = collectUrls(
      photo.photoUrls,
      photo.photoH265Urls,
      photo.photoUrl, photo.photoH265Url, photo.photoH264Url, photo.mp4Url,
      photo.mainMvUrls, photo.mainMvUrl, photo.srcNoMark, photo.playUrl,
      deepGet(photo, ["manifest", "adaptationSet", 0, "representation", 0, "url"]),
      deepGet(photo, ["manifestH265", "adaptationSet", 0, "representation", 0, "url"])
    );
    if (!videoUrls.length && !imageUrls.length) videoUrls = deepFindMp4(photo).slice(0, 4);

    // 带 pkey= 的是 CDN 通用签名链，异地也能下；provider=self 的 ndcimgs 链可能锁会话，排后面
    videoUrls = videoUrls.sort((a, b) => (/[?&]pkey=/.test(b) ? 1 : 0) - (/[?&]pkey=/.test(a) ? 1 : 0));

    const w = {
      platform: "kuaishou",
      videoId,
      author:
        (author && (author.name || author.userName || author.user_name || author.userId)) ||
        photo.userName || photo.author_name || "未知作者",
      title: photo.caption || photo.title || photo.name || "",
      likeCount:
        photo.realLikeCount || photo.likeCount || photo.like_count ||
        deepGet(photo, ["counts", "displayLike"]) || 0,
      timestampMs: Number(photo.timestamp || photo.createTime || photo.time || 0),
      cover: pickUrl(photo.coverUrl, photo.coverUrls, photo.webpCoverUrls, photo.coverThumbnailUrls),
      videoUrl: videoUrls[0] || "",
      videoUrls,
      imageUrls,
      pageUrl: `https://www.kuaishou.com/short-video/${videoId}`,
      ownerId: String((author && author.id) || "")
    };
    w.kind = kindOf(w);
    return w;
  }

  function fromMobile(it) {
    if (!it || typeof it !== "object") return null;
    const videoId = it.photoId || it.id || it.photo_id;
    if (!videoId) return null;
    const imageUrls = Array.isArray(it.imgUrls) ? collectUrls(it.imgUrls) : buildAtlas(it.atlas);
    const videoUrls = collectUrls(it.playUrl, it.mainMvUrls, it.photoUrl, it.mp4Url, it.srcNoMark);
    const w = {
      platform: "kuaishou",
      videoId: String(videoId),
      author: it.userName || deepGet(it, ["author", "name"]) || it.user_name || "未知作者",
      title: it.caption || it.title || "",
      likeCount: deepGet(it, ["counts", "displayLike"]) || it.likeCount || 0,
      timestampMs: Number(it.timestamp || it.createTime || 0),
      cover: pickUrl(it.coverUrl, it.coverUrls, it.webpCoverUrls),
      videoUrl: videoUrls[0] || "",
      videoUrls,
      imageUrls,
      pageUrl: `https://www.kuaishou.com/short-video/${videoId}`,
      ownerId: ""
    };
    w.kind = kindOf(w);
    return w;
  }

  function parsePayload(entry) {
    const json = entry && entry.json;
    if (!json || typeof json !== "object") return [];
    const out = [];

    // feeds 数组（visionProfilePhotoList / mix / 任意位置）
    findNodes(json, (n) => Array.isArray(n.feeds) && n.feeds.length && n.feeds.some((f) => f && (f.photo || f.photoId || f.id)))
      .forEach((n) => n.feeds.forEach((f) => {
        const w = fromPhoto(f.photo || f, f.author || (f.photo && f.photo.author));
        if (w) out.push(w);
      }));

    // 移动端 profile/public 的 list
    findNodes(json, (n) => Array.isArray(n.list) && n.list.some((x) => x && (x.photoId || x.id)))
      .forEach((n) => n.list.forEach((it) => { const w = fromMobile(it); if (w) out.push(w); }));

    // 兜底：任意 photo-like 对象
    if (!out.length) {
      findNodes(json, isPhotoLike, 12000).forEach((o) => {
        const w = fromPhoto(o, o.author);
        if (w) out.push(w);
      });
    }

    return out;
  }

  globalThis.SVA.adapter = {
    platform: "kuaishou",
    label: "快手",
    theme: {
      head: "linear-gradient(90deg, #ff5c00, #ff2d55)",
      accent: "#ff5c00",
      on: "#d92b2b",
      images: "#ffb300",
      imagesInk: "#3a2500"
    },
    parsePayload,
    kindOf,
    // 只认 www.kuaishou.com/profile/<id>
    profileOwner() {
      const m = location.pathname.match(/^\/profile\/([^/?#]+)\/?$/);
      return m ? decodeURIComponent(m[1]) : "";
    },
    authorFromPage: () => util.titleAuthor(),
    captchaText: /(请完成|安全验证|滑动验证|拖动滑块|向右滑动|完成拼图)/,
    captchaSelector: 'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [class*="slider-verify" i], [class*="verify-slider" i]'
  };
})();
