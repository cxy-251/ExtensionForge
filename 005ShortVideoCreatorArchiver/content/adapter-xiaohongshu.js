/*
 * 小红书解析器。
 *
 * 和抖音/TikTok 最大的不同：主页列表（首屏状态 __INITIAL_STATE__.user.notes[0]，滑动时
 * 由页面自己往里追加）只有笔记 id、标题、类型、作者、xsecToken，没有图片/视频地址。所以这里
 * 产出两种 Work：
 *   - 列表项：needsDetail: true，没有地址，进「待取详情」；
 *   - 详情：有地址，可以下载。
 *
 * 取详情：详情接口 /api/sns/web/v1/feed 要签名，不碰。改成请求笔记网页
 * /explore/<id>?xsec_token=…——服务端渲染的 HTML 里内嵌了这篇笔记的完整状态
 * （__INITIAL_STATE__.note.noteDetailMap），普通网页请求、带的是用户自己的 Cookie，
 * 和在新标签页打开这篇笔记一样。实测每篇 0.4~0.6 秒。panel.js 控制节奏（见 detail.fetchNote）。
 * 用户自己在主页点开笔记时，页面请求的 /feed 回包也照样旁路收下。
 *
 * 图片用 sns-img-bd.xhscdn.com/<fileId>：原图（实测 3072×4096，接口给的 urlDefault 只有
 * 1080×1440 的 webp），不带签名、不会过期、没有水印。视频取分辨率最高的一档，其余档和
 * 不带签名的 sns-bak-* 备用地址都当候选。
 */
(() => {
  "use strict";
  const { util } = globalThis.SVA;
  const { findNodes, isHttp } = util;

  const pick = (o, ...keys) => {
    if (!o) return undefined;
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
    return undefined;
  };

  // xhscdn 的地址接口里给的是 http://，换成 https 优先，http 留作备用
  const withHttps = (u) => (/^http:\/\//.test(u) ? [u.replace(/^http:/, "https:"), u] : [u]);

  // http://sns-webpic-qc.xhscdn.com/<时间>/<签名>/<fileId>!nd_dft_wlteh_webp_3 → <fileId>
  function fileIdFromUrl(u) {
    if (!isHttp(u)) return "";
    return u.split("/").slice(5).join("/").split("!")[0];
  }

  function imageCandidates(im) {
    const fileId = pick(im, "fileId", "file_id") || fileIdFromUrl(pick(im, "urlDefault", "url_default") || "");
    const urls = [];
    if (fileId) urls.push(`https://sns-img-bd.xhscdn.com/${fileId}`, `https://sns-img-qc.xhscdn.com/${fileId}`);
    const dft = pick(im, "urlDefault", "url_default");
    if (isHttp(dft)) urls.push(...withHttps(dft));
    return [...new Set(urls)];
  }

  function videoCandidates(note) {
    const stream = (((note.video || {}).media || {}).stream) || {};
    const all = Object.values(stream).flat().filter((s) => s && typeof s === "object");
    all.sort((a, b) =>
      ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)) ||
      (pick(b, "avgBitrate", "avg_bitrate") || 0) - (pick(a, "avgBitrate", "avg_bitrate") || 0));
    const urls = [];
    for (const s of all) {
      const master = pick(s, "masterUrl", "master_url");
      if (isHttp(master)) urls.push(...withHttps(master));
      for (const b of pick(s, "backupUrls", "backup_urls") || []) if (isHttp(b)) urls.push(...withHttps(b));
    }
    return [...new Set(urls)];
  }

  const kindOf = (w) => (w.videoUrls.length ? "video" : "images");

  function base(id, n, user) {
    return {
      platform: "xiaohongshu",
      videoId: String(id),
      author: pick(user, "nickname", "nickName") || "未知作者",
      title: pick(n, "title", "displayTitle", "display_title") || String(pick(n, "desc") || "").split("\n")[0].slice(0, 60),
      likeCount: 0,
      timestampMs: Number(pick(n, "time") || 0),
      cover: "",
      videoUrl: "",
      videoUrls: [],
      imageUrls: [],
      pageUrl: `https://www.xiaohongshu.com/explore/${id}`,
      ownerId: String(pick(user, "userId", "user_id") || "")
    };
  }

  // 主页列表项 → 待取详情
  function fromListItem(item) {
    const nc = (item && item.noteCard) || {};
    const id = pick(item, "id") || pick(nc, "noteId");
    if (!id) return null;
    const w = base(id, nc, nc.user);
    w.needsDetail = true;
    w.xsecToken = pick(nc, "xsecToken") || pick(item, "xsecToken") || "";
    w.kind = pick(nc, "type") === "video" ? "video" : "images";
    return w;
  }

  // 笔记详情（接口 note_card 是下划线命名，首屏状态 noteDetailMap 是驼峰命名，两种都认）
  function fromNote(n) {
    const id = pick(n, "noteId", "note_id");
    if (!id) return null;
    const w = base(id, n, n.user);
    if (pick(n, "type") === "video") {
      w.videoUrls = videoCandidates(n);
      w.videoUrl = w.videoUrls[0] || "";
    } else {
      w.imageUrls = (pick(n, "imageList", "image_list") || []).map(imageCandidates).filter((c) => c.length);
    }
    if (!w.videoUrls.length && !w.imageUrls.length) return null;
    w.kind = kindOf(w);
    return w;
  }

  function parsePayload(entry) {
    const json = entry && entry.json;
    if (!json || typeof json !== "object") return [];
    const out = [];
    // inject.js 的 stateFn 抄出来的首屏状态
    if (Array.isArray(json.xhsList)) json.xhsList.forEach((it) => { const w = fromListItem(it); if (w) out.push(w); });
    if (Array.isArray(json.xhsDetails)) json.xhsDetails.forEach((n) => { const w = fromNote(n); if (w) out.push(w); });
    // /api/sns/web/v1/feed 回包
    findNodes(json, (n) => n.note_card && typeof n.note_card === "object")
      .forEach((n) => { const w = fromNote(n.note_card); if (w) out.push(w); });
    return out;
  }

  // 主页里点开笔记，网址会变成 /explore/<笔记id>（或者卡片链接那种 /user/profile/<作者>/<笔记id>）。
  // /explore 网址里没有作者，靠 panel 传进来的 ownerOfNote 查这篇是不是已知作者的。
  function contextOwner(ownerOfNote) {
    const p = location.pathname;
    let m = p.match(/^\/user\/profile\/([0-9a-f]{24})(?:\/([0-9a-f]{24}))?\/?$/i);
    if (m) return m[1].toLowerCase();
    m = p.match(/^\/(?:explore|discovery\/item)\/([0-9a-f]{24})\/?$/i);
    return m && ownerOfNote ? ownerOfNote(m[1].toLowerCase()) : "";
  }

  // HTML 里的 __INITIAL_STATE__ 是 JS 字面量不是 JSON：值里会出现 undefined、new Map([])
  function parseInitialState(html) {
    const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (!m) return null;
    const text = m[1]
      .replace(/([:\[,])undefined(?=[,\]}])/g, "$1null")
      .replace(/new Map\(\[\]\)/g, "null");
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  async function fetchNote(item) {
    const url = `/explore/${item.videoId}?xsec_token=${encodeURIComponent(item.xsecToken || "")}&xsec_source=pc_user`;
    let r, html;
    try {
      r = await fetch(url, { credentials: "include" });
      html = await r.text();
    } catch (_) { return { blocked: "网络请求失败" }; }
    if (!r.ok) return { blocked: "HTTP " + r.status };
    if (!new URL(r.url).pathname.startsWith("/explore/")) return { blocked: "被跳转到 " + new URL(r.url).pathname };
    const st = parseInitialState(html);
    if (!st) return { blocked: "页面里没有笔记数据" };
    const entry = ((st.note && st.note.noteDetailMap) || {})[item.videoId];
    const w = entry && entry.note ? fromNote(entry.note) : null;
    return w ? { work: w } : { missing: true };
  }

  globalThis.SVA.adapter = {
    platform: "xiaohongshu",
    label: "小红书",
    theme: {
      head: "linear-gradient(90deg, #ff2442, #ff6680)",
      accent: "#ff2442",
      on: "#8c1023",
      images: "#ffd166",
      imagesInk: "#3a2500"
    },
    parsePayload,
    kindOf,
    // 只认 www.xiaohongshu.com/user/profile/<24 位 id>；作品列表只读「笔记」那一栏（notes[0]）
    profileOwner() {
      const m = location.pathname.match(/^\/user\/profile\/([0-9a-f]{24})\/?$/i);
      return m ? m[1].toLowerCase() : "";
    },
    contextOwner,
    authorFromPage: () => util.titleAuthor(),
    captchaText: /(安全验证|请完成验证|滑块验证|拖动滑块|向右滑动)/,
    captchaSelector: 'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]',

    // 取详情：请求笔记网页，从 HTML 内嵌的状态里取。返回 { work } / { missing }（这篇没数据，
    // 比如已删除）/ { blocked }（被跳去登录页、验证页，或者整页都没有状态——多半触发了风控，该停）
    detail: { fetchNote }
  };
})();
