/*
 * 快手创作者作品归档助手 —— 隔离世界（ISOLATED world）脚本。
 *
 * 数据来源：inject.js 旁路读到的页面接口响应 / 初始状态对象，经 window.postMessage
 * 送到这里。本脚本负责：
 *  1. 解析成「作品」对象（视频直链 / 图集直链 + 元信息），字段多名兜底 + 全 JSON 扫描；
 *  2. 在创作者主页 / 单作品页挂一个采集面板；
 *  3. 自动向下滚动触发翻页；
 *  4. 识别安全验证并暂停；
 *  5. 把下载任务交给 background.js；
 *  6. 响应 popup 的「连续模式」指令并回报结果；
 *  7. 「统计检测」「调试信息」两个按钮用于排查为什么采集不到。
 */
(() => {
  "use strict";

  const TAG = "kca";
  const LOG = (...a) => { try { console.log("[快手归档]", ...a); } catch (_) {} };

  // 兜底：万一 manifest 的 MAIN-world 脚本没生效（策略/旧版 Chrome），
  // 再以 <script> 方式把 inject.js 注入页面。inject.js 内有 __kcaPatched 去重。
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { LOG("注入 inject.js 兜底失败", e); }

  const CFG = Object.freeze({
    panelId: "kca-panel",
    // 之前 1.2~2.6s 一次太规律、太快了，像机器——放慢到接近人翻页的节奏
    scrollMinGap: 2800,
    scrollMaxGap: 5500,
    idleRoundsStop: 4,
    // 高产账号一个滚动轮次都跟不上更新量——之前 60 轮对好几百条的账号明显不够，
    // 经常是轮数耗尽提前收工（不是卡住了），有 idleRoundsStop 兜底真到底了会提前停
    defaultMaxRounds: 600,
    captchaText: /(请完成|安全验证|滑动验证|拖动滑块|向右滑动|完成拼图)/,
    debugKeep: 80
  });

  const S = {
    works: new Map(),          // videoId -> work
    downloaded: new Set(),     // 已下载过的 videoId（来自 chrome.storage 的 dl: 记录）
    debug: [],                 // {url, len, parsed, added, at}
    rawDump: [],               // 最近几条接口原始响应（截断），排错导出用
    panelCollapsed: false,
    showDebug: false,
    includeDone: false,        // 下载时是否包含已下载过的作品
    auto: { running: false, token: null, autoDownload: false }
  };

  // ---------- 基础工具 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  function deepGet(obj, path) {
    let cur = obj;
    for (const k of path) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[k];
    }
    return cur;
  }

  const isHttp = (u) => typeof u === "string" && /^https?:\/\//.test(u);

  function pickUrl(...cands) {
    for (const c of cands) {
      if (isHttp(c)) return c;
      if (Array.isArray(c)) {
        for (const x of c) {
          const u = typeof x === "string" ? x : x && (x.url || x.cdnUrl || x.photoUrl);
          if (isHttp(u)) return u;
        }
      }
    }
    return "";
  }

  function collectUrls(...cands) {
    const seen = new Set();
    for (const c of cands) {
      const arr = Array.isArray(c) ? c : [c];
      for (const x of arr) {
        const u = typeof x === "string" ? x : x && (x.url || x.cdnUrl || x.photoUrl);
        if (isHttp(u)) seen.add(u);
      }
    }
    return [...seen];
  }

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

  function sanitize(name) {
    return String(name == null ? "" : name)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "untitled";
  }

  function dateStr(ms) {
    const n = Number(ms) || 0;
    const d = new Date(n < 1e12 && n > 0 ? n * 1000 : n || Date.now());
    if (Number.isNaN(d.getTime())) return "";
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

  // 在任意结构里递归找满足条件的节点
  function findNodes(root, test, cap) {
    const out = [];
    const budget = { n: cap || 8000 };
    (function walk(node) {
      if (!node || typeof node !== "object" || budget.n-- <= 0) return;
      try { if (test(node)) out.push(node); } catch (_) {}
      const vals = Array.isArray(node) ? node : Object.keys(node).map((k) => node[k]);
      for (const v of vals) if (v && typeof v === "object") walk(v);
    })(root);
    return out;
  }

  // ---------- 作品归一化 ----------

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

  function fromPhoto(photo, author) {
    if (!photo || typeof photo !== "object") return null;
    const videoId = photo.photoId || photo.id || photo.photoIdStr || photo.photo_id;
    if (!videoId) return null;

    const atlas = deepGet(photo, ["ext_params", "atlas"]) || photo.atlas;
    let imageUrls = [];
    if (Array.isArray(photo.imgUrls) && photo.imgUrls.length) imageUrls = collectUrls(photo.imgUrls);
    else if (atlas) imageUrls = buildAtlas(atlas);

    // 快手 web /rest/v/profile/feed 的实际字段：photoUrls / photoH265Urls 都是 [{cdn,url}]。
    // 老字段 photoUrl / photoH265Url（单数、GraphQL）也保留兜底。
    let videoUrls = collectUrls(
      photo.photoUrls,          // H264，通用兼容，首选
      photo.photoH265Urls,      // H265，体积更小
      photo.photoUrl, photo.photoH265Url, photo.photoH264Url, photo.mp4Url,
      photo.mainMvUrls, photo.mainMvUrl, photo.srcNoMark, photo.playUrl,
      deepGet(photo, ["manifest", "adaptationSet", 0, "representation", 0, "url"]),
      deepGet(photo, ["manifestH265", "adaptationSet", 0, "representation", 0, "url"])
    );
    // 已知字段都没命中（快手改了接口）——在 photo 子树里兜底捞 .mp4
    if (!videoUrls.length && !imageUrls.length) videoUrls = deepFindMp4(photo).slice(0, 4);

    // 带 pkey= 的是 CDN 通用签名链，异地也能下；provider=self 的 ndcimgs 链可能锁会话，排后面
    videoUrls = videoUrls.sort((a, b) => (/[?&]pkey=/.test(b) ? 1 : 0) - (/[?&]pkey=/.test(a) ? 1 : 0));

    return {
      videoId: String(videoId).replace(/^\w+:/, ""),  // Apollo 里可能是 "VisionPhoto:3xxx"
      kind: imageUrls.length && !videoUrls.length ? "images" : "video",
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
      pageUrl: `https://www.kuaishou.com/short-video/${String(videoId).replace(/^\w+:/, "")}`,
      source: "photo"
    };
  }

  function fromMobile(it) {
    if (!it || typeof it !== "object") return null;
    const videoId = it.photoId || it.id || it.photo_id;
    if (!videoId) return null;
    const imageUrls = Array.isArray(it.imgUrls) ? collectUrls(it.imgUrls) : buildAtlas(it.atlas);
    const videoUrls = collectUrls(it.playUrl, it.mainMvUrls, it.photoUrl, it.mp4Url, it.srcNoMark);
    return {
      videoId: String(videoId),
      kind: imageUrls.length && !videoUrls.length ? "images" : "video",
      author: it.userName || deepGet(it, ["author", "name"]) || it.user_name || "未知作者",
      title: it.caption || it.title || "",
      likeCount: deepGet(it, ["counts", "displayLike"]) || it.likeCount || 0,
      timestampMs: Number(it.timestamp || it.createTime || 0),
      cover: pickUrl(it.coverUrl, it.coverUrls, it.webpCoverUrls),
      videoUrl: videoUrls[0] || "",
      videoUrls,
      imageUrls,
      pageUrl: `https://www.kuaishou.com/short-video/${videoId}`,
      source: "mobile"
    };
  }

  function parsePayload(entry) {
    const json = entry && entry.json;
    const url = (entry && entry.url) || "";
    if (!json || typeof json !== "object") return [];
    const out = [];

    // feeds 数组（visionProfilePhotoList / mix / 任意位置）
    findNodes(json, (n) => Array.isArray(n.feeds) && n.feeds.length && n.feeds.some((f) => f && (f.photo || f.photoId || f.id)))
      .forEach((n) => n.feeds.forEach((f) => {
        const w = fromPhoto(f.photo || f, f.author || (f.photo && f.photo.author));
        if (w) out.push(w);
      }));

    // 单作品详情
    findNodes(json, (n) =>
      (n.__typename && /VisionVideoDetailPhoto|VisionPhoto/i.test(n.__typename)) ||
      (n.photo && isPhotoLike(n.photo) && (n.author || n.photo.author))
    ).forEach((n) => {
      const p = n.photo || n;
      const w = fromPhoto(p, n.author || p.author);
      if (w) out.push(w);
    });

    // 移动端 list / currentWork
    findNodes(json, (n) => Array.isArray(n.list) && n.list.some((x) => x && (x.photoId || x.id)))
      .forEach((n) => n.list.forEach((it) => { const w = fromMobile(it); if (w) out.push(w); }));
    const cw = deepGet(json, ["data", "data", "currentWork"]) || deepGet(json, ["data", "currentWork"]);
    if (cw) { const w = fromMobile(cw); if (w) out.push(w); }

    // chenzhongtech 图集
    if (/chenzhongtech|photo\/info/i.test(url) && json.atlas) {
      const imgs = buildAtlas(json.atlas);
      const pid = deepGet(json, ["photo", "photoId"]) || deepGet(json, ["photo", "id"]);
      if (imgs.length && pid) {
        out.push({
          videoId: String(pid), kind: "images",
          author: deepGet(json, ["photo", "userName"]) || "未知作者",
          title: deepGet(json, ["shareInfo", "shareTitle"]) || "",
          likeCount: 0, timestampMs: Number(deepGet(json, ["photo", "timestamp"]) || 0),
          cover: "", videoUrl: "", videoUrls: [], imageUrls: imgs,
          pageUrl: `https://www.kuaishou.com/short-video/${pid}`, source: "atlas"
        });
      }
    }

    // 兜底：任意 photo-like 对象
    if (!out.length) {
      findNodes(json, isPhotoLike, 12000).forEach((o) => {
        const w = fromPhoto(o, o.author);
        if (w) out.push(w);
      });
    }

    return out;
  }

  // ---------- 入库 ----------

  function ingest(kind, entry) {
    let parsed = [];
    try { parsed = parsePayload(entry); } catch (err) { LOG("解析异常", err); }

    let added = 0;
    for (const w of parsed) {
      if (!w.videoId) continue;
      if (!w.videoUrl && !w.imageUrls.length) continue;
      const prev = S.works.get(w.videoId);
      if (!prev) { S.works.set(w.videoId, w); added++; }
      else {
        if (!prev.videoUrl && w.videoUrl) { prev.videoUrl = w.videoUrl; prev.videoUrls = w.videoUrls; }
        if (!prev.imageUrls.length && w.imageUrls.length) prev.imageUrls = w.imageUrls;
        if (!prev.cover && w.cover) prev.cover = w.cover;
        if (!prev.title && w.title) prev.title = w.title;
        if ((!prev.author || prev.author === "未知作者") && w.author && w.author !== "未知作者") prev.author = w.author;
      }
    }

    if (kind === "api") {
      let rawLen = 0;
      try {
        const raw = JSON.stringify(entry.json);
        rawLen = raw.length;
        // 只留「像作品接口但没解析出东西」的样本 —— 那才是需要我排错的
        if (parsed.length === 0 && /photo|feed|caption|mvUrl|atlas/i.test(raw.slice(0, 4000))) {
          S.rawDump.unshift({ url: entry.url || "", at: Date.now(), added, sample: raw.slice(0, 60000) });
          if (S.rawDump.length > 6) S.rawDump.length = 6;
        }
      } catch (_) {}
      S.debug.unshift({ url: entry.url || "(无 url)", len: rawLen, parsed: parsed.length, added, at: Date.now() });
      if (S.debug.length > CFG.debugKeep) S.debug.length = CFG.debugKeep;
      LOG("收到", entry.url, "→ 解析", parsed.length, "新增", added);
    } else if (kind === "state" && parsed.length) {
      S.debug.unshift({ url: `[state:${entry.key}]`, len: 0, parsed: parsed.length, added, at: Date.now() });
      if (S.debug.length > CFG.debugKeep) S.debug.length = CFG.debugKeep;
    }

    if (added || S.showDebug) renderPanel();
    if (added) refreshDownloaded();
  }

  // ---------- 已下载去重（按 videoId，与文件是否移动无关） ----------

  let dedupTimer = 0;
  function refreshDownloaded() {
    clearTimeout(dedupTimer);
    dedupTimer = setTimeout(async () => {
      const ids = [...S.works.keys()].filter((id) => !S.downloaded.has(id));
      if (!ids.length) return;
      try {
        const got = await chrome.storage.local.get(ids.map((id) => "dl:" + id));
        let changed = false;
        for (const id of ids) if (("dl:" + id) in got) { S.downloaded.add(id); changed = true; }
        if (changed) renderPanel();
      } catch (_) {}
    }, 400);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let changed = false;
    for (const k of Object.keys(changes)) {
      if (k.startsWith("dl:")) {
        const id = k.slice(3);
        if (S.works.has(id) && !S.downloaded.has(id)) { S.downloaded.add(id); changed = true; }
      }
    }
    if (changed) renderPanel();
  });

  // ---------- 消息（inject.js 桥） ----------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== TAG) return;
    if (d.kind === "api") ingest("api", d.entry);
    else if (d.kind === "state") ingest("state", d);
    else if (d.kind === "debug") {
      // inject 侧对「收到但没解析」的响应也报一条，便于排查
      if (!d.parsed) {
        S.debug.unshift({ url: d.url || "(无 url)", len: d.len || 0, parsed: 0, added: 0, at: Date.now() });
        if (S.debug.length > CFG.debugKeep) S.debug.length = CFG.debugKeep;
        if (S.showDebug) renderPanel();
      }
    }
  });

  function announce() { window.postMessage({ source: TAG, kind: "content-ready" }, location.origin); }
  announce();
  [500, 1500, 3500, 6000].forEach((t) => setTimeout(announce, t));

  // ---------- 面板 ----------

  function pageAllowsPanel() {
    return /\/profile\/|\/short-video\/|\/photo\/|\/f\/|\/u\//.test(location.pathname) ||
      S.works.size > 0 || S.debug.length > 0;
  }

  function currentAuthorGuess() {
    for (const w of S.works.values()) if (w.author && w.author !== "未知作者") return w.author;
    const t = document.title.replace(/[-_|（(].*$/, "").trim();
    return t || "快手创作者";
  }

  function ensurePanel() {
    let panel = document.getElementById(CFG.panelId);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = CFG.panelId;
    panel.innerHTML = `
      <div class="kca-head">
        <span class="kca-title">快手归档助手</span>
        <span class="kca-spacer"></span>
        <button class="kca-mini" data-act="collapse" title="折叠/展开">—</button>
        <button class="kca-mini" data-act="close" title="关闭">×</button>
      </div>
      <div class="kca-body">
        <div class="kca-line kca-stat"></div>
        <div class="kca-row">
          <button class="kca-btn" data-act="auto">自动采集</button>
          <button class="kca-btn" data-act="download">下载全部</button>
        </div>
        <div class="kca-row">
          <button class="kca-btn kca-ghost" data-act="detect">统计检测</button>
          <button class="kca-btn kca-ghost" data-act="copy">复制直链</button>
          <button class="kca-btn kca-ghost" data-act="clear">清空</button>
        </div>
        <div class="kca-line kca-status"></div>
        <button class="kca-toggle" data-act="incdone">☐ 下载时包含「已存」作品</button>
        <button class="kca-toggle" data-act="debug">调试信息 ▸</button>
        <button class="kca-toggle" data-act="dump">导出接口回包样本（采集不到时排错）</button>
        <div class="kca-debug" hidden></div>
        <div class="kca-list"></div>
      </div>`;

    panel.addEventListener("click", onPanelClick);
    (document.body || document.documentElement).appendChild(panel);
    LOG("面板已挂载");
    return panel;
  }

  function renderPanel() {
    if (!pageAllowsPanel()) return;
    const panel = ensurePanel();
    panel.classList.toggle("kca-collapsed", S.panelCollapsed);

    const items = [...S.works.values()];
    const doneN = items.filter((w) => S.downloaded.has(w.videoId)).length;

    const stat = panel.querySelector(".kca-stat");
    if (stat) {
      stat.textContent =
        `创作者：${currentAuthorGuess()} ｜ 已采集 ${items.length} 条` +
        (doneN ? `（新 ${items.length - doneN} · 已存 ${doneN}）` : "");
    }

    const autoBtn = panel.querySelector('[data-act="auto"]');
    if (autoBtn) {
      autoBtn.textContent = S.auto.running ? "停止采集" : "自动采集";
      autoBtn.classList.toggle("kca-on", S.auto.running);
    }

    const incBtn = panel.querySelector('[data-act="incdone"]');
    if (incBtn) incBtn.textContent = (S.includeDone ? "☑" : "☐") + " 下载时包含「已存」作品";

    const toggle = panel.querySelector('[data-act="debug"]');
    if (toggle) toggle.textContent = (S.showDebug ? "调试信息 ▾" : "调试信息 ▸");
    const dbg = panel.querySelector(".kca-debug");
    if (dbg) {
      dbg.hidden = !S.showDebug;
      if (S.showDebug) {
        const okN = S.debug.filter((d) => d.added > 0).length;
        const rows = S.debug.slice(0, 30).map((d) => {
          const mark = d.added > 0 ? "✓" : d.parsed > 0 ? "·" : "✗";
          const u = d.url.length > 66 ? d.url.slice(0, 63) + "…" : d.url;
          return `<div class="kca-dbg-row"><b>${mark}</b> +${d.added}/${d.parsed} <span>${u}</span></div>`;
        }).join("");
        dbg.innerHTML =
          `<div class="kca-dbg-sum">收到接口/状态回包 ${S.debug.length} 次，其中 ${okN} 次解析出新作品。` +
          `${S.debug.length === 0 ? "<br>一条都没有 → inject.js 没抓到请求：确认已「重新加载扩展」并刷新本页；再看 Console 有没有 <code>[快手归档][inject] fetch 已挂钩</code>。" : ""}</div>` +
          rows;
      }
    }

    const list = panel.querySelector(".kca-list");
    if (list) {
      list.innerHTML = "";
      items.slice().sort((a, b) => b.timestampMs - a.timestampMs).forEach((w, i) => {
        const label = w.title || w.videoId;
        const row = document.createElement("div");
        row.className = "kca-item";
        const idx = document.createElement("span"); idx.className = "kca-idx"; idx.textContent = String(i + 1);
        const badge = document.createElement("span"); badge.className = `kca-badge kca-${w.kind}`;
        badge.textContent = w.kind === "video" ? "视频" : "图集";
        const name = document.createElement("span"); name.className = "kca-name"; name.textContent = label; name.title = label;
        const like = document.createElement("span"); like.className = "kca-like"; like.textContent = `♥ ${w.likeCount || 0}`;
        const dl = document.createElement("button"); dl.className = "kca-dl"; dl.dataset.id = w.videoId; dl.title = "下载这条"; dl.textContent = "⬇";
        if (S.downloaded.has(w.videoId)) {
          row.classList.add("kca-item-done");
          const done = document.createElement("span"); done.className = "kca-badge kca-doneb"; done.textContent = "已存";
          row.append(idx, badge, done, name, like, dl);
        } else {
          row.append(idx, badge, name, like, dl);
        }
        list.appendChild(row);
      });
    }
  }

  function setStatus(text) {
    const el = document.querySelector(`#${CFG.panelId} .kca-status`);
    if (el) el.textContent = text || "";
  }

  function onPanelClick(event) {
    const btn = event.target.closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    LOG("点击按钮", act || (btn.classList.contains("kca-dl") ? "dl:" + btn.dataset.id : "?"));

    if (btn.classList.contains("kca-dl")) {
      const w = S.works.get(btn.dataset.id);
      if (w) { enqueue([w]); setStatus(`已加入下载：${w.title || w.videoId}`); }
      return;
    }
    if (act === "collapse") { S.panelCollapsed = !S.panelCollapsed; renderPanel(); }
    else if (act === "close") { document.getElementById(CFG.panelId)?.remove(); }
    else if (act === "auto") {
      // 只负责采集，不自动下载——下载交给旁边「下载全部」按钮，两个按钮各司其职
      if (S.auto.running) { stopAuto("已手动停止"); }
      else { startAuto(CFG.defaultMaxRounds, false); }
    }
    else if (act === "download") { downloadAll(); }
    else if (act === "detect") { runDetect(); }
    else if (act === "clear") { S.works.clear(); S.debug.length = 0; renderPanel(); setStatus("已清空"); }
    else if (act === "copy") { copyLinks(); }
    else if (act === "incdone") { S.includeDone = !S.includeDone; renderPanel(); }
    else if (act === "debug") { S.showDebug = !S.showDebug; renderPanel(); }
    else if (act === "dump") { exportDump(); }
  }

  // ---------- 排错：导出接口回包 ----------

  function exportDump() {
    const payload = {
      page: location.href,
      when: new Date().toISOString(),
      collected: S.works.size,
      debug: S.debug.slice(0, 40),
      unparsedSamples: S.rawDump
    };
    const text = JSON.stringify(payload, null, 2);
    const kb = (text.length / 1024).toFixed(0);
    navigator.clipboard.writeText(text).then(
      () => setStatus(`已复制排错数据 ${kb}KB 到剪贴板 —— 直接发给开发者定位字段变化`),
      () => { try { console.log("[快手归档] === DUMP START ===\n" + text + "\n=== DUMP END ==="); } catch (_) {}
        setStatus("剪贴板被拒，已打印到 Console（F12），整段复制发给开发者"); }
    );
  }

  // ---------- 统计检测 ----------

  function runDetect() {
    const captured = S.works.size;
    const domIds = new Set();
    document.querySelectorAll('a[href*="/short-video/"], a[href*="/photo/"], a[href*="/f/"]').forEach((a) => {
      const m = (a.href || "").match(/(?:short-video|photo|f)\/([A-Za-z0-9_-]{6,})/);
      if (m) domIds.add(m[1]);
    });
    const okN = S.debug.filter((d) => d.added > 0).length;
    const scrollEls = findScrollEls();
    const describe = (el) => `<${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(/\s+/)[0] : ""}>(可滚${el.scrollHeight - el.clientHeight}px)`;
    const scrollInfo = scrollEls.length
      ? `滚动容器候选(全部一起滚)：${scrollEls.map(describe).join("、")} + window(整页可滚${document.documentElement.scrollHeight - document.documentElement.clientHeight}px)`
      : `滚动容器：只有 window（整页可滚 ${document.documentElement.scrollHeight - document.documentElement.clientHeight}px）`;
    LOG("检测：采集", captured, "DOM可见", domIds.size, "回包", S.debug.length, "出作品", okN, scrollInfo);

    if (S.debug.length === 0) {
      setStatus("⚠️ 没收到任何接口回包：① chrome://extensions 里点本扩展「重新加载」 ② 刷新本页 ③ F12 Console 看有没有「[快手归档][inject] fetch 已挂钩」");
    } else {
      setStatus(`已采集直链 ${captured} 条 ｜ 页面可见作品约 ${domIds.size} 个 ｜ 接口回包 ${S.debug.length} 次（出作品 ${okN} 次）｜ ${scrollInfo}。点「调试信息」看每条回包`);
      S.showDebug = true;
    }
    renderPanel();
  }

  // ---------- 下载 ----------

  function enqueue(list) {
    const payload = list.map((w) => ({
      videoId: w.videoId, kind: w.kind, author: sanitize(w.author),
      title: sanitize(w.title || w.videoId), dateStr: dateStr(w.timestampMs),
      videoUrl: w.videoUrl, videoUrls: w.videoUrls || (w.videoUrl ? [w.videoUrl] : []),
      imageUrls: w.imageUrls, cover: w.cover, pageUrl: w.pageUrl
    }));
    // chrome.runtime.sendMessage 在扩展被重新加载/更新后，如果这个页面本身没刷新，会
    // 直接同步抛出"Extension context invalidated"（不是 promise reject，.catch() 接不住）
    // ——003/004 那边遇到过这个坑，这里一并补上 try/catch。
    try {
      chrome.runtime.sendMessage({ cmd: "enqueue", works: payload }).catch((e) => LOG("下发失败", e));
    } catch (e) {
      LOG("下发失败（扩展可能被重新加载了，刷新一下本页）", e);
      setStatus("⚠️ 下载没发出去——扩展刚被重新加载过，刷新一下这个页面再试");
    }
  }

  function downloadAll() {
    const all = [...S.works.values()];
    if (!all.length) { setStatus("还没有采集到作品，先点「统计检测」看看问题在哪"); return; }
    const items = S.includeDone ? all : all.filter((w) => !S.downloaded.has(w.videoId));
    const skipped = all.length - items.length;
    if (!items.length) {
      setStatus(`本页 ${all.length} 条都已下载过（勾「包含已存」可强制重下）`);
      return;
    }
    enqueue(items);
    setStatus(`已把 ${items.length} 条加入队列` + (skipped ? `（跳过 ${skipped} 条已存）` : ""));
  }

  function copyLinks() {
    const lines = [];
    for (const w of S.works.values()) {
      if (w.kind === "video" && w.videoUrl) lines.push(w.videoUrl);
      else w.imageUrls.forEach((u) => lines.push(u));
    }
    if (!lines.length) { setStatus("没有可复制的直链"); return; }
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => setStatus(`已复制 ${lines.length} 条直链`),
      () => setStatus("复制失败（剪贴板权限被拒）")
    );
  }

  // ---------- 自动滚动 ----------

  function captchaVisible() {
    const el = document.querySelector(
      'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [class*="slider-verify" i], [class*="verify-slider" i]'
    );
    if (el && el.offsetParent !== null) return true;
    return CFG.captchaText.test((document.body && document.body.innerText || "").slice(0, 6000));
  }

  // ---------- 找真正在滚的容器 ----------
  //
  // 快手主页很多布局是「整页不滚，作品流是里面一个固定高度、自己 overflow:auto 的
  // 容器」——只滚 window 完全不会动。这里找页面里最大的、真的可滚动的容器，
  // 连同 window 一起滚，两边都滚总不会错。缓存一份，容器没了（页面重排）再重找。

  let cachedScrollEl = null;
  // 猜错真正的可视滚动容器会出现"数据在涨、页面看着却没动"——单选一个风险太高，
  // 改成收集前几名候选全部一起滚，命中率高很多，代价只是多几次无意义的 scrollTop 赋值。
  function findScrollEls() {
    if (cachedScrollEl && cachedScrollEl.length &&
        cachedScrollEl.every((el) => document.documentElement.contains(el))) {
      return cachedScrollEl;
    }
    const candidates = [];
    const nodes = document.querySelectorAll("div, main, section, ul, ol");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable < 80) continue;
      let cs;
      try { cs = getComputedStyle(el); } catch (_) { continue; }
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;
      candidates.push({ el, score: rect.width * rect.height + scrollable });
    }
    candidates.sort((a, b) => b.score - a.score);
    cachedScrollEl = candidates.slice(0, 3).map((c) => c.el);   // 前 3 名一起滚，不赌一个
    return cachedScrollEl;
  }

  // 万一容器都不对、也没人监听 scrollTop——补一发真实感的 wheel 事件，有些虚拟列表
  // 是直接读 wheel 的 deltaY 自己算偏移的，不走原生 overflow 滚动那一套
  function dispatchWheelNudge(deltaY) {
    try {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const target = document.elementFromPoint(cx, cy) || document.body;
      target.dispatchEvent(new WheelEvent("wheel", {
        deltaY, deltaMode: 0, bubbles: true, cancelable: true, clientX: cx, clientY: cy
      }));
    } catch (_) {}
  }

  function scrollFeedDown() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    if (document.scrollingElement) document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    findScrollEls().forEach((el) => { el.scrollTop = el.scrollHeight; });
    dispatchWheelNudge(900);
  }
  function scrollFeedBy(delta) {
    window.scrollBy(0, delta);
    if (document.scrollingElement) document.scrollingElement.scrollTop += delta;
    findScrollEls().forEach((el) => { el.scrollTop = Math.max(0, el.scrollTop + delta); });
    dispatchWheelNudge(delta);
  }

  async function startAuto(maxRounds, fromPopup) {
    if (S.auto.running) return;
    S.auto.running = true;
    renderPanel();

    let idle = 0, round = 0;
    const start = S.works.size;

    while (S.auto.running && round < maxRounds) {
      if (captchaVisible()) {
        stopAuto("检测到安全验证，已暂停 —— 请在页面完成验证后重新点「自动采集」");
        try { chrome.runtime.sendMessage({ cmd: "captcha", token: S.auto.token }).catch(() => {}); } catch (_) {}
        return finishAuto(fromPopup, false, true);
      }
      const before = S.works.size;
      scrollFeedDown();
      await sleep(rand(CFG.scrollMinGap, CFG.scrollMaxGap));
      if (Math.random() < 0.3) { scrollFeedBy(-Math.round(rand(200, 500))); await sleep(rand(300, 700)); }

      round++;
      idle = S.works.size === before ? idle + 1 : 0;
      setStatus(`自动采集中… 第 ${round} 轮，累计 ${S.works.size} 条`);
      renderPanel();
      if (idle >= CFG.idleRoundsStop) break;
    }

    const gained = S.works.size - start;
    stopAuto(`自动采集结束：新增 ${gained} 条，当前共 ${S.works.size} 条` + (S.works.size === 0 ? "（0 条 → 点「调试信息」看回包情况）" : ""));
    finishAuto(fromPopup, true, false);
  }

  function finishAuto(fromPopup, ok, captcha) {
    // 不管是控制台连续模式发起的，还是手动点面板按钮，只要标了 autoDownload 就下载
    if (S.auto.autoDownload && !captcha) downloadAll();
    if (fromPopup) {
      try {
        chrome.runtime.sendMessage({
          cmd: "collectResult", token: S.auto.token, ok, captcha,
          count: S.works.size, author: currentAuthorGuess()
        }).catch(() => {});
      } catch (_) {}
    }
    S.auto.token = null;
    S.auto.autoDownload = false;
  }

  function stopAuto(msg) {
    S.auto.running = false;
    renderPanel();
    if (msg) setStatus(msg);
  }

  // ---------- popup 指令 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.cmd === "ping") { sendResponse({ pong: true, count: S.works.size, url: location.href }); return; }
    if (msg.cmd === "autoCollect") {
      S.auto.token = msg.token || null;
      S.auto.autoDownload = msg.autoDownload !== false;
      renderPanel();
      setStatus("连续模式：开始自动采集…");
      startAuto(msg.maxRounds || CFG.defaultMaxRounds, true);
      sendResponse({ started: true });
      return;
    }
    if (msg.cmd === "stopAuto") { stopAuto("连续模式已停止"); sendResponse({ stopped: true }); return; }
  });

  // ---------- 启动 ----------

  const boot = () => { if (pageAllowsPanel()) renderPanel(); };
  boot();
  setTimeout(boot, 1200);
  setTimeout(boot, 3000);

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; setTimeout(boot, 800); }
  }, 1000);

  LOG("content 已就绪", location.href);
})();
