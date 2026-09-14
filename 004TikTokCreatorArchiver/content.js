/*
 * TikTok 创作者作品归档助手 —— 隔离世界（ISOLATED world）脚本。
 *
 * 跟 002（快手）/003（抖音）是同一套架构，字段/接口换成 TikTok 的 item 结构。
 * 数据来源：inject.js 旁路读到的页面接口响应，经 window.postMessage 送到这里。
 * 本脚本负责：
 *  1. 解析成「作品」对象（视频直链 / 图集直链 + 元信息）；
 *  2. 在创作者主页 / 单视频 / 点赞 / 合集页挂一个采集面板；
 *  3. 自动向下滚动触发翻页；
 *  4. 识别安全验证并暂停；
 *  5. 把下载任务交给 background.js；
 *  6. 「统计检测」「调试信息」「导出回包样本」三个按钮用于排查为什么采集不到。
 *
 * v1 范围：主页作品 / 单视频 / 点赞 / 合集，只做单页手动采集，没有 002 那种批量创作者
 * 列表 + 连续模式 + 控制台页，后面要加再照抄 002 的 app.html/app.js。
 *
 * 这一版直接把 002/003 踩过的坑提前避开了：
 *  - 图集/图片作品即使接口里也带了个兼容视频字段，一律优先按图集处理（003 上线后才
 *    发现"图集混入音频"这个 bug，这次直接从一开始就按 imageUrls 优先判断）。
 *  - 只采集"当前页面显示的标签"，来源接口类型跟当前页面对不上就丢弃、页面身份一变
 *    就清空重来（003 上线后才发现"点赞视频混入采集"这个 bug，这次直接内置）。
 */
(() => {
  "use strict";

  const TAG = "tta";
  const LOG = (...a) => { try { console.log("[TikTok归档]", ...a); } catch (_) {} };

  // 兜底：万一 manifest 的 MAIN-world 脚本没生效，再以 <script> 方式注入页面
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { LOG("注入 inject.js 兜底失败", e); }

  const CFG = Object.freeze({
    panelId: "tta-panel",
    // 跟快手/抖音一路踩坑得出的结论一致：节奏慢一点、加随机抖动，别让平台风控当成机器人
    scrollMinGap: 2800,
    scrollMaxGap: 5500,
    idleRoundsStop: 4,
    defaultMaxRounds: 600,
    captchaText: /(Verify to continue|Security check|Please verify|滑动验证|请完成安全验证|拖动滑块)/i,
    debugKeep: 80
  });

  const S = {
    works: new Map(),          // videoId(item.id) -> work
    downloaded: new Set(),     // 已下载过的 videoId
    debug: [],                 // {url, len, parsed, added, blocked, at}
    rawDump: [],                // 排错导出用
    sampledUrls: new Set(),    // 已经存过"解析成功"样本的接口类型，避免重复存
    panelCollapsed: false,
    showDebug: false,
    includeDone: false,
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
          const u = typeof x === "string" ? x : x && x.url;
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
        const u = typeof x === "string" ? x : x && x.url;
        if (isHttp(u)) seen.add(u);
      }
    }
    return [...seen];
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
    const d = new Date(n || Date.now());
    if (Number.isNaN(d.getTime())) return "";
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

  // ---------- 作品归一化（TikTok item 结构） ----------

  function isItemLike(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (!o.id) return false;
    return !!(o.video || o.imagePost || o.desc !== undefined || o.author);
  }

  function fromItem(item, srcType) {
    if (!item || typeof item !== "object") return null;
    const videoId = item.id;
    if (!videoId) return null;

    const video = item.video || {};
    // bitrateInfo[] 是 TikTok 自己给的多档画质数组（跟抖音 bit_rate[] 是同一个概念）
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

    // 图集/图片作品（TikTok 的 Photo Mode）：真实图片在 imagePost.images[]。即使接口里
    // 同时也带了个兼容视频字段（给不支持图集的老客户端播放用的合成视频/音轨），只要有
    // 真实图片就一律按图集处理——不能让那个兼容视频字段抢走（003 上线后才踩过这个坑，
    // 图集混入一段音频，这里直接从一开始就按这个顺序判断）。
    const images = item.imagePost && Array.isArray(item.imagePost.images) ? item.imagePost.images : [];
    const imageUrls = images
      .map((im) => pickUrl(deepGet(im, ["imageURL", "urlList"]), deepGet(im, ["imageUrl", "urlList"])))
      .filter(Boolean);

    const author = deepGet(item, ["author", "uniqueId"]) || deepGet(item, ["author", "nickname"]) || "未知作者";

    return {
      videoId: String(videoId),
      kind: imageUrls.length ? "images" : "video",
      author,
      title: item.desc || "",
      likeCount: deepGet(item, ["stats", "diggCount"]) || deepGet(item, ["statsV2", "diggCount"]) || 0,
      timestampMs: Number(item.createTime || 0) * 1000,
      cover: pickUrl(deepGet(video, ["cover"]), deepGet(video, ["originCover"]), deepGet(video, ["dynamicCover"])),
      videoUrl: videoUrls[0] || "",
      videoUrls,
      imageUrls,
      pageUrl: `https://www.tiktok.com/@${author}/video/${videoId}`,
      source: "item",
      sourceType: srcType || "other"
    };
  }

  function parsePayload(entry) {
    const json = entry && entry.json;
    if (!json || typeof json !== "object") return [];
    const srcType = (entry && entry.srcType) || "other";
    const out = [];

    // 主页作品 / 点赞 / 合集列表——响应体都是 { itemList: [...] }
    findNodes(json, (n) => Array.isArray(n.itemList) && n.itemList.some((a) => a && a.id))
      .forEach((n) => n.itemList.forEach((a) => { const w = fromItem(a, srcType); if (w) out.push(w); }));

    // 单视频详情页——初始状态里 itemStruct 是核心作品对象
    findNodes(json, (n) => n.itemStruct && n.itemStruct.id)
      .forEach((n) => { const w = fromItem(n.itemStruct, srcType); if (w) out.push(w); });

    // 有的响应没包外层 key，本身就是 item 对象
    if (isItemLike(json)) { const w = fromItem(json, srcType); if (w) out.push(w); }

    // 兜底：全 JSON 扫任意 item-like 对象（初始状态对象很深很杂，findNodes 上面几条
    // 常规路径覆盖不到的，靠这条兜底）
    if (!out.length) {
      findNodes(json, isItemLike, 12000).forEach((a) => { const w = fromItem(a, srcType); if (w) out.push(w); });
    }
    return out;
  }

  // 当前页面看起来是"作品/点赞/合集/详情"里的哪一种标签——只在 content.js（能看到真实
  // location）这边判断，不依赖 inject.js 对页面状态的猜测。
  function currentPageType() {
    try {
      const u = new URL(location.href);
      if (/\/video\/\d+/.test(u.pathname)) return "detail";
      if (/\/(likes?|liked)\/?$/i.test(u.pathname)) return "like";
      if (/\/playlist\//i.test(u.pathname)) return "collection";
      const tab = (u.searchParams.get("tab") || "").toLowerCase();
      if (tab.includes("like")) return "like";
      if (tab.includes("playlist") || tab.includes("mix")) return "collection";
      return "post";
    } catch (_) { return "post"; }
  }

  // "页面身份"：路径 + 当前标签。只要有一个变了（换了创作者主页，或者切了"作品/点赞/
  // 合集"标签），就认为进入了一个新的采集场景，之前采集到的内容清空重来——不能把这个
  // 标签页历史上打开过的其它页面的作品也算进当前这次采集（003 上线后才踩过的坑，这次
  // 直接内置）。
  function computePageKey() {
    return location.pathname + "::" + currentPageType();
  }

  function resetForNewPage() {
    if (!S.works.size && !S.debug.length) return;
    S.works.clear();
    S.debug.length = 0;
    S.rawDump.length = 0;
    S.sampledUrls.clear();
    S.downloaded.clear();
    renderPanel();
    setStatus("检测到页面/标签已切换，采集列表已清空 —— 只采集当前这个页面的内容");
  }

  // ---------- 入库 ----------

  function ingest(kind, entry) {
    syncPageContext();

    let parsed = [];
    try { parsed = parsePayload(entry); } catch (err) { LOG("解析异常", err); }

    const curType = currentPageType();
    let added = 0, blocked = 0;
    for (const w of parsed) {
      if (!w.videoId) continue;
      if (!w.videoUrl && !w.imageUrls.length) continue;
      // 只有接口回包（kind === "api"）才做这层过滤——页面自带的初始状态对象（state）
      // 天生就是"当前这个页面"的数据，不用比对。之前"sourceType === 'other' 就直接放行"
      // 这条例外是漏洞本身：TikTok 首页"For You"推荐流接口（/api/recommend/item_list）
      // 被分类成了 other，只要这个标签页哪怕在后台悄悄刷过一次首页推荐流（TikTok 本身
      // 就是个不停自动加载推荐视频的信息流，比抖音的点赞页更容易在后台默默触发），这条
      // "other 例外"就会把一堆完全不相关的陌生人视频放进来——这才是"下载到不知道是谁的
      // 视频"的真正原因。现在改成：接口来源类型必须严格等于当前页面类型才收，任何分类不到
      // 或者分类到了但对不上当前页面的接口回包，一律不算数，宁可少采集也不能采错。
      if (kind === "api" && w.sourceType !== curType) { blocked++; continue; }
      const prev = S.works.get(w.videoId);
      if (!prev) { S.works.set(w.videoId, w); added++; }
      else {
        if (!prev.videoUrl && w.videoUrl) { prev.videoUrl = w.videoUrl; prev.videoUrls = w.videoUrls; }
        if (!prev.imageUrls.length && w.imageUrls.length) prev.imageUrls = w.imageUrls;
        if (!prev.cover && w.cover) prev.cover = w.cover;
        if (!prev.title && w.title) prev.title = w.title;
        if ((!prev.author || prev.author === "未知作者") && w.author && w.author !== "未知作者") prev.author = w.author;
        // kind 要跟着 imageUrls 重新算一遍：先到的回包如果还没带图片信息，kind 会先判成
        // "video"；不在这里跟着重算，后到的回包补全了图片，kind 也会一直锁死在 "video"。
        prev.kind = prev.imageUrls.length ? "images" : "video";
      }
    }

    if (kind === "api") {
      let rawLen = 0;
      try {
        const raw = JSON.stringify(entry.json);
        rawLen = raw.length;
        // 排错样本：解析不出任何东西时存一份（原有逻辑，看字段是不是整个变了）；
        // 解析"成功"（added>0）也存一份——下载出来是 html 这个 bug 就是"解析成功了，
        // 但抓到的 videoUrl 字段本身不对"，只有 0 条那种情况才存样本的话，这种"看似
        // 成功、其实抓错字段"的场景永远抓不到原始结构，没法排查。用 sampledUrls 记一下
        // 哪些接口路径已经存过样本，同一条接口不用重复存。
        const looksEmpty = parsed.length === 0 && /item|author|video|desc/i.test(raw.slice(0, 4000));
        const looksSuccessSample = added > 0 && !S.sampledUrls.has(entry.srcType || "?");
        if (looksEmpty || looksSuccessSample) {
          if (looksSuccessSample) S.sampledUrls.add(entry.srcType || "?");
          S.rawDump.unshift({ url: entry.url || "", at: Date.now(), added, ok: added > 0, sample: raw.slice(0, 60000) });
          if (S.rawDump.length > 6) S.rawDump.length = 6;
        }
      } catch (_) {}
      S.debug.unshift({ url: entry.url || "(无 url)", len: rawLen, parsed: parsed.length, added, blocked, at: Date.now() });
      if (S.debug.length > CFG.debugKeep) S.debug.length = CFG.debugKeep;
      LOG("收到", entry.url, "→ 解析", parsed.length, "新增", added, blocked ? `过滤${blocked}(非当前标签)` : "");
    } else if (kind === "state" && parsed.length) {
      S.debug.unshift({ url: `[state:${entry.key}]`, len: 0, parsed: parsed.length, added, blocked, at: Date.now() });
      if (S.debug.length > CFG.debugKeep) S.debug.length = CFG.debugKeep;
    }

    if (added || blocked || S.showDebug) renderPanel();
    if (added) refreshDownloaded();
  }

  // ---------- 已下载去重 ----------

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
    return /\/@[^/]+|\/video\/\d+/.test(location.pathname) || S.works.size > 0 || S.debug.length > 0;
  }

  function currentAuthorGuess() {
    for (const w of S.works.values()) if (w.author && w.author !== "未知作者") return w.author;
    const m = location.pathname.match(/\/@([^/]+)/);
    if (m) return m[1];
    return "TikTok创作者";
  }

  function ensurePanel() {
    let panel = document.getElementById(CFG.panelId);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = CFG.panelId;
    panel.innerHTML = `
      <div class="tta-head">
        <span class="tta-title">TikTok 归档助手</span>
        <span class="tta-spacer"></span>
        <button class="tta-mini" data-act="collapse" title="折叠/展开">—</button>
        <button class="tta-mini" data-act="close" title="关闭">×</button>
      </div>
      <div class="tta-body">
        <div class="tta-line tta-stat"></div>
        <div class="tta-row">
          <button class="tta-btn" data-act="auto">自动采集</button>
          <button class="tta-btn" data-act="download">下载全部</button>
        </div>
        <div class="tta-row">
          <button class="tta-btn tta-ghost" data-act="detect">统计检测</button>
          <button class="tta-btn tta-ghost" data-act="copy">复制直链</button>
          <button class="tta-btn tta-ghost" data-act="clear">清空</button>
        </div>
        <div class="tta-line tta-status"></div>
        <button class="tta-toggle" data-act="incdone">☐ 下载时包含「已存」作品</button>
        <button class="tta-toggle" data-act="debug">调试信息 ▸</button>
        <button class="tta-toggle" data-act="dump">导出接口回包样本（采集不到时排错）</button>
        <div class="tta-debug" hidden></div>
        <div class="tta-list"></div>
      </div>`;

    panel.addEventListener("click", onPanelClick);
    (document.body || document.documentElement).appendChild(panel);
    LOG("面板已挂载");
    return panel;
  }

  function renderPanel() {
    if (!pageAllowsPanel()) return;
    const panel = ensurePanel();
    panel.classList.toggle("tta-collapsed", S.panelCollapsed);

    const items = [...S.works.values()];
    const doneN = items.filter((w) => S.downloaded.has(w.videoId)).length;

    const TAB_LABEL = { post: "作品", collection: "合集", like: "点赞", detail: "详情" };
    const stat = panel.querySelector(".tta-stat");
    if (stat) {
      stat.textContent =
        `创作者：${currentAuthorGuess()} ｜ 当前标签：${TAB_LABEL[currentPageType()] || "作品"} ｜ 已采集 ${items.length} 条` +
        (doneN ? `（新 ${items.length - doneN} · 已存 ${doneN}）` : "");
    }

    const autoBtn = panel.querySelector('[data-act="auto"]');
    if (autoBtn) {
      autoBtn.textContent = S.auto.running ? "停止采集" : "自动采集";
      autoBtn.classList.toggle("tta-on", S.auto.running);
    }

    const incBtn = panel.querySelector('[data-act="incdone"]');
    if (incBtn) incBtn.textContent = (S.includeDone ? "☑" : "☐") + " 下载时包含「已存」作品";

    const toggle = panel.querySelector('[data-act="debug"]');
    if (toggle) toggle.textContent = (S.showDebug ? "调试信息 ▾" : "调试信息 ▸");
    const dbg = panel.querySelector(".tta-debug");
    if (dbg) {
      dbg.hidden = !S.showDebug;
      if (S.showDebug) {
        const okN = S.debug.filter((d) => d.added > 0).length;
        const rows = S.debug.slice(0, 30).map((d) => {
          const mark = d.added > 0 ? "✓" : d.blocked > 0 ? "⊘" : d.parsed > 0 ? "·" : "✗";
          const u = d.url.length > 66 ? d.url.slice(0, 63) + "…" : d.url;
          const blockedTxt = d.blocked ? ` 过滤${d.blocked}(非当前标签)` : "";
          return `<div class="tta-dbg-row"><b>${mark}</b> +${d.added}/${d.parsed}${blockedTxt} <span>${u}</span></div>`;
        }).join("");
        dbg.innerHTML =
          `<div class="tta-dbg-sum">收到接口/状态回包 ${S.debug.length} 次，其中 ${okN} 次解析出新作品。` +
          `${S.debug.length === 0 ? "<br>一条都没有 → inject.js 没抓到请求：确认已「重新加载扩展」并刷新本页；再看 Console 有没有 <code>[TikTok归档][inject] fetch 已挂钩</code>。" : ""}</div>` +
          rows;
      }
    }

    const list = panel.querySelector(".tta-list");
    if (list) {
      list.innerHTML = "";
      items.slice().sort((a, b) => b.timestampMs - a.timestampMs).forEach((w, i) => {
        const label = w.title || w.videoId;
        const row = document.createElement("div");
        row.className = "tta-item";
        const idx = document.createElement("span"); idx.className = "tta-idx"; idx.textContent = String(i + 1);
        const badge = document.createElement("span"); badge.className = `tta-badge tta-${w.kind}`;
        badge.textContent = w.kind === "video" ? "视频" : "图集";
        const name = document.createElement("span"); name.className = "tta-name"; name.textContent = label; name.title = label;
        const like = document.createElement("span"); like.className = "tta-like"; like.textContent = `♥ ${w.likeCount || 0}`;
        const dl = document.createElement("button"); dl.className = "tta-dl"; dl.dataset.id = w.videoId; dl.title = "下载这条"; dl.textContent = "⬇";
        if (S.downloaded.has(w.videoId)) {
          row.classList.add("tta-item-done");
          const done = document.createElement("span"); done.className = "tta-badge tta-doneb"; done.textContent = "已存";
          row.append(idx, badge, done, name, like, dl);
        } else {
          row.append(idx, badge, name, like, dl);
        }
        list.appendChild(row);
      });
    }
  }

  function setStatus(text) {
    const el = document.querySelector(`#${CFG.panelId} .tta-status`);
    if (el) el.textContent = text || "";
  }

  function onPanelClick(event) {
    const btn = event.target.closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    LOG("点击按钮", act || (btn.classList.contains("tta-dl") ? "dl:" + btn.dataset.id : "?"));

    if (btn.classList.contains("tta-dl")) {
      const w = S.works.get(btn.dataset.id);
      if (w) { enqueue([w]); setStatus(`已加入下载：${w.title || w.videoId}`); }
      return;
    }
    if (act === "collapse") { S.panelCollapsed = !S.panelCollapsed; renderPanel(); }
    else if (act === "close") { document.getElementById(CFG.panelId)?.remove(); }
    else if (act === "auto") { S.auto.running ? stopAuto("已手动停止") : startAuto(CFG.defaultMaxRounds, false); }
    else if (act === "download") { downloadAll(); }
    else if (act === "detect") { runDetect(); }
    else if (act === "clear") { S.works.clear(); S.debug.length = 0; S.rawDump.length = 0; S.sampledUrls.clear(); renderPanel(); setStatus("已清空"); }
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
      () => { try { console.log("[TikTok归档] === DUMP START ===\n" + text + "\n=== DUMP END ==="); } catch (_) {}
        setStatus("剪贴板被拒，已打印到 Console（F12），整段复制发给开发者"); }
    );
  }

  // ---------- 统计检测 ----------

  function runDetect() {
    const captured = S.works.size;
    const domIds = new Set();
    document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
      const m = (a.href || "").match(/\/video\/(\d+)/);
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
      setStatus("⚠️ 没收到任何接口回包：① chrome://extensions 里点本扩展「重新加载」 ② 刷新本页 ③ F12 Console 看有没有「[TikTok归档][inject] fetch 已挂钩」");
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
    // ——003 上线后才踩过这个坑，这里直接内置 try/catch。
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
      'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [class*="verify" i], [class*="secsdk" i]'
    );
    if (el && el.offsetParent !== null) return true;
    return CFG.captchaText.test((document.body && document.body.innerText || "").slice(0, 6000));
  }

  // 猜错真正的可视滚动容器会出现"数据在涨、页面看着却没动"——单选一个风险太高，
  // 收集前几名候选全部一起滚，命中率高很多（快手/抖音那边踩过这个坑）
  let cachedScrollEl = null;
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
    cachedScrollEl = candidates.slice(0, 3).map((c) => c.el);
    return cachedScrollEl;
  }

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
      // 标签页切到后台时，Chrome 会限速页面自己的懒加载/定时器，采集不到新内容很正常，
      // 不是真的到底了——这段时间不计入"停止采集"的空转计数，免得后台挂着反而提前收工。
      if (S.works.size === before) { if (!document.hidden) idle++; } else { idle = 0; }
      setStatus(`自动采集中… 第 ${round} 轮，累计 ${S.works.size} 条` + (document.hidden ? "（标签页在后台，可能被浏览器限速，建议切回前台）" : ""));
      renderPanel();
      if (idle >= CFG.idleRoundsStop) break;
    }

    const gained = S.works.size - start;
    stopAuto(`自动采集结束：新增 ${gained} 条，当前共 ${S.works.size} 条` + (S.works.size === 0 ? "（0 条 → 点「调试信息」看回包情况）" : ""));
    finishAuto(fromPopup, true, false);
  }

  function finishAuto(fromPopup, ok, captcha) {
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

  // ---------- popup 指令（预留：以后要做批量列表可以复用） ----------

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

  // 页面身份（路径+标签）发生变化就清空重来——见 computePageKey/resetForNewPage。
  // ingest() 每次收到回包也会顺带检查一次，这里的定时器是兜底（没有回包也能感知到
  // 用户切换了标签/主页）。
  let lastPageKey = computePageKey();
  function syncPageContext() {
    const key = computePageKey();
    if (key !== lastPageKey) {
      lastPageKey = key;
      resetForNewPage();
      setTimeout(boot, 800);
    }
  }
  setInterval(syncPageContext, 1000);

  LOG("content 已就绪", location.href);
})();
