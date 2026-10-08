/*
 * 采集面板 + 采集流程，三个平台共用。平台相关的部分全部走 SVA.adapter。
 *
 * 只在创作者主页「作品」页工作（adapter.profileOwner() 非空）：自动下滑采集作品、
 * 一键入队下载。打开这个作者自己的视频（adapter.contextOwner()）面板照常显示；去了别的
 * 页面面板收起但采集结果留着，回到同一个作者的主页原样恢复；进了另一个作者的主页才清空。
 *
 *  - 小红书这类列表里没有地址的平台（adapter.detail）：列表项先进 S.pending，自动采集时
 *    后台逐篇调 adapter.detail.fetchNote 取详情（每篇间隔 0.8~1.5 秒，被拦截就停），下滑等取
 *    详情跟上了再滑下一屏——页面滚动和采集进度同步，不会列表早滑到底、详情还拖一大串；
 *  - 面板挂在 Shadow DOM 里，样式用 constructable stylesheet 注入——宿主页面的 reset
 *    样式进不来，也不受页面 CSP 的 style-src 限制；
 *  - 面板上只显示一行队列数字；暂停/继续出队、清空排队都在工具栏气泡（popup）里，不重复放。
 *    数字靠轮询 getState（页面可见时每 2 秒一次）：background 的
 *    chrome.runtime.sendMessage 只发给扩展自己的页面，到不了 content 脚本。
 *    pausedBy 另外监听 storage.onChanged，在气泡里点了暂停这里立刻跟上。
 */
(() => {
  "use strict";
  const SVA = globalThis.SVA;
  const A = SVA && SVA.adapter;
  if (!A || SVA.panelBooted) return;
  SVA.panelBooted = true;

  const { sleep, rand, sanitize, dateStr } = SVA.util;

  const TAG = "sva";
  const LOG = (...a) => { try { console.log(`[短视频归档·${A.label}]`, ...a); } catch (_) {} };

  const CFG = Object.freeze({
    hostId: "sva-panel-host",
    // 节奏放慢、加随机抖动，接近人翻页
    scrollMinGap: 2800,
    scrollMaxGap: 5500,
    idleRoundsStop: 4,        // 连续这么多轮没有新作品 = 到底了；不设总轮数上限
    detailBacklog: 6,         // 取详情的平台：加载出来还没取到地址的超过这么多篇，先不往下滑
    queuePollMs: 2000
  });

  const S = {
    owner: A.profileOwner(),   // 正在采集的作者（主页主人）；"" = 还没进过创作者主页
    visible: false,            // 当前页面属于 owner（主页或其视频页）才显示面板、才收回包
    status: "",                // 面板收起再出现时要能还原
    works: new Map(),          // videoId -> work（有地址，能下载）
    pending: new Map(),        // videoId -> 列表项（还没地址，等点开取详情；只有 adapter.detail 的平台用）
    tries: new Map(),          // videoId -> 已经取过几次详情（取不到的别无限重试）
    downloaded: new Set(),     // 已下载过的 videoId（来自 dl:<platform>:<id>）
    collapsed: false,
    autoRunning: false,
    queue: null                // 最近一次 getState 的结果
  };

  const dlKey = (id) => "dl:" + A.platform + ":" + id;

  // ---------- 和 background 通信 ----------
  //
  // 扩展被重新加载、页面没刷新时，chrome.runtime.sendMessage 会同步抛
  // "Extension context invalidated"（不是 reject，.catch() 接不住）。
  let contextDead = false;
  function send(msg) {
    if (contextDead) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (_) {
      contextDead = true;
      setStatus("⚠️ 扩展刚被重新加载过，刷新一下这个页面才能继续用");
      return Promise.resolve(null);
    }
  }

  // ---------- 页面切换 ----------
  //
  // 站内跳转不刷新页面。只有进了「另一个作者」的主页才清空重来；在主页里点开自己的视频
  // （TikTok 网址会变成 /@作者/video/<id>）不算离开。去了别的页面只把面板收起，采集结果
  // 留着——旁路采集拿不回已经加载过的列表（滑到底后再滑不会重新请求），丢了只能刷新页面重来。
  // 混进别人作品的风险由 ingest 里的作者 id 比对兜着，不靠清空。

  // 小红书点开笔记后网址是 /explore/<笔记id>，没有作者；已知的笔记就算 owner 的
  const ownerOfNote = (id) => (S.works.has(id) || S.pending.has(id) ? S.owner : "");

  function pageOwner() {
    return A.contextOwner ? A.contextOwner(ownerOfNote) : A.profileOwner();
  }

  function syncPage() {
    const profile = A.profileOwner();
    if (profile && profile !== S.owner) {
      S.owner = profile;
      S.works.clear();
      S.pending.clear();
      S.tries.clear();
      S.downloaded.clear();
      S.autoRunning = false;
      S.visible = true;
      S.status = "";
      renderPanel();
      return;
    }
    const visible = !!S.owner && pageOwner() === S.owner;
    if (visible === S.visible) return;
    S.visible = visible;
    if (visible) renderPanel(); else removePanel();
  }
  S.visible = !!S.owner;
  setInterval(syncPage, 1000);

  // ---------- 入库 ----------
  //
  // 接口回包本来就只转发了主页作品列表接口；这里再按作者比对一次：作品作者 id 和主页
  // 主人对不上的不收。首屏状态对象里可能混着别的推荐内容，拿不到作者 id 的也不收。

  function ingest(kind, entry) {
    syncPage();
    if (!S.visible) return;

    let parsed = [];
    try { parsed = A.parsePayload(entry); } catch (err) { LOG("解析异常", err); }
    const { added, listed, blocked } = absorb(parsed, kind);
    LOG(kind === "api" ? entry.url : `[state:${entry.key}]`, "→ 解析", parsed.length, "新增", added,
      listed ? `待取详情+${listed}` : "", blocked ? `丢弃${blocked}(不是本主页作者)` : "");
    if (added || listed) { renderPanel(); refreshDownloaded(); }
  }

  // 把解析出的 Work 收进 works / pending。kind 为 "state" 的（首屏状态）拿不到作者 id 就不收
  function absorb(parsed, kind) {
    let added = 0, blocked = 0, listed = 0;
    for (const w of parsed) {
      if (!w.videoId || (!w.needsDetail && !w.videoUrl && !w.imageUrls.length)) continue;
      const verifiable = w.ownerId && S.owner !== "self";
      if ((verifiable && w.ownerId !== S.owner) || (kind === "state" && !w.ownerId)) { blocked++; continue; }
      if (w.needsDetail) {
        if (!S.works.has(w.videoId) && !S.pending.has(w.videoId)) { S.pending.set(w.videoId, w); listed++; }
        continue;
      }
      S.pending.delete(w.videoId);
      const prev = S.works.get(w.videoId);
      if (!prev) { S.works.set(w.videoId, w); added++; continue; }
      if (!prev.videoUrl && w.videoUrl) { prev.videoUrl = w.videoUrl; prev.videoUrls = w.videoUrls; }
      if (!prev.imageUrls.length && w.imageUrls.length) prev.imageUrls = w.imageUrls;
      if (!prev.title && w.title) prev.title = w.title;
      if ((!prev.author || prev.author === "未知作者") && w.author && w.author !== "未知作者") prev.author = w.author;
      // 先到的回包可能还没带图片，kind 先被判成 video；后到的补全了就得跟着重算，
      // 不然图集会被当视频下成一段音频
      prev.kind = A.kindOf(prev);
    }
    return { added, listed, blocked };
  }

  // ---------- 已下载去重 ----------

  let dedupTimer = 0;
  function refreshDownloaded() {
    clearTimeout(dedupTimer);
    dedupTimer = setTimeout(async () => {
      const ids = [...S.works.keys()].filter((id) => !S.downloaded.has(id));
      if (!ids.length) return;
      try {
        const got = await chrome.storage.local.get(ids.map(dlKey));
        let changed = false;
        for (const id of ids) if (dlKey(id) in got) { S.downloaded.add(id); changed = true; }
        if (changed) renderPanel();
      } catch (_) {}
    }, 400);
  }

  const dlPrefix = dlKey("");
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let changed = false;
    for (const k of Object.keys(changes)) {
      if (!k.startsWith(dlPrefix)) continue;
      const id = k.slice(dlPrefix.length);
      if (S.works.has(id) && !S.downloaded.has(id)) { S.downloaded.add(id); changed = true; }
    }
    if (changes.pausedBy && S.queue) {
      S.queue.pausedBy = changes.pausedBy.newValue || {};
      renderQueue();
    }
    if (changed) renderPanel();
  });

  // ---------- inject.js 桥 ----------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== TAG || d.platform !== A.platform) return;
    if (d.kind === "api") ingest("api", d.entry);
    else if (d.kind === "state") ingest("state", d);
  });

  function announce() { window.postMessage({ source: TAG, kind: "content-ready" }, location.origin); }
  announce();
  [500, 1500, 3500, 6000].forEach((t) => setTimeout(announce, t));

  // ---------- 面板 ----------

  function currentAuthor() {
    for (const w of S.works.values()) if (w.author && w.author !== "未知作者") return w.author;
    return A.authorFromPage() || A.label + "创作者";
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      width: 340px; max-height: 70vh;
      display: flex; flex-direction: column;
      font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1a1a1a; background: #fff;
      border: 1px solid #e3e3e6; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
      overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; background: var(--head); color: #fff;
      user-select: none;
    }
    .title { font-weight: 600; letter-spacing: .3px; }
    .head-q { font-size: 11px; opacity: .85; white-space: nowrap; }
    .spacer { flex: 1 1 auto; }
    .mini {
      width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px;
      background: rgba(255, 255, 255, 0.18); color: #fff;
      font-family: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
    }
    .mini:hover { background: rgba(255, 255, 255, 0.32); }
    .body {
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px; overflow-y: auto; overflow-x: hidden;
    }
    .collapsed .body { display: none; }
    .stat { font-size: 12px; font-weight: 600; }
    .status { min-height: 16px; font-size: 12px; color: var(--accent); }
    .row { display: flex; gap: 8px; }
    .btn {
      flex: 1 1 0; padding: 7px 10px; border: 0; border-radius: 8px;
      background: var(--accent); color: #fff;
      font-family: inherit; font-size: 12.5px; font-weight: 600; line-height: 1.3; cursor: pointer;
    }
    .btn:hover { filter: brightness(1.06); }
    .btn.ghost { background: #f2f2f4; color: #333; }
    .btn.on { background: var(--on); }
    .qline {
      padding: 6px 8px; border: 1px solid #eee; border-radius: 8px; background: #fafafa;
      font-size: 12px; color: #333;
    }
    .qline b { color: var(--accent); }
    .list { overflow-y: auto; max-height: 120px; border-top: 1px solid #eee; }
    .item { display: flex; align-items: center; gap: 6px; padding: 5px 2px; border-bottom: 1px solid #f2f2f2; font-size: 12px; }
    .idx { width: 24px; color: #999; text-align: right; flex: 0 0 auto; }
    .badge { flex: 0 0 auto; padding: 1px 6px; border-radius: 999px; font-size: 11px; color: #fff; }
    .badge.video { background: var(--accent); }
    .badge.images { background: var(--images); color: var(--images-ink); }
    .badge.done { background: #999; }
    .item-done { opacity: 0.5; }
    .name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1f1f22; color: #eee; border-color: #333; }
      .btn.ghost { background: #34343a; color: #ddd; }
      .qline { background: #171719; border-color: #333; color: #ddd; }
      .list { border-top-color: #333; }
      .item { border-bottom-color: #2c2c30; }
    }
  `;

  let host = null;
  let root = null;
  const $ = (sel) => (root ? root.querySelector(sel) : null);

  function ensurePanel() {
    if (host && host.isConnected) return;

    host = document.createElement("div");
    host.id = CFG.hostId;
    // 定位放在宿主元素的内联 !important 上：页面 CSS 进不了 shadow，但能选中宿主本身
    const hs = host.style;
    hs.setProperty("position", "fixed", "important");
    hs.setProperty("right", "16px", "important");
    hs.setProperty("bottom", "16px", "important");
    hs.setProperty("z-index", "2147483000", "important");
    hs.setProperty("display", "block", "important");

    root = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    const t = A.theme;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.style.cssText =
      `--head:${t.head};--accent:${t.accent};--on:${t.on};--images:${t.images};--images-ink:${t.imagesInk};`;
    panel.innerHTML = `
      <div class="head">
        <span class="title">${A.label} 归档助手</span>
        <span class="spacer"></span>
        <span class="head-q"></span>
        <button class="mini" data-act="collapse" title="折叠/展开">—</button>
      </div>
      <div class="body">
        <div class="stat"></div>
        <div class="row">
          <button class="btn" data-act="auto">自动采集</button>
          <button class="btn" data-act="download">下载全部</button>
        </div>
        <div class="qline">下载队列：—</div>
        <div class="status"></div>
        <div class="list"></div>
      </div>`;
    root.appendChild(panel);
    root.addEventListener("click", onPanelClick);
    (document.body || document.documentElement).appendChild(host);
    pollQueue();
  }

  function removePanel() {
    if (host) host.remove();
  }

  function renderPanel() {
    if (!S.visible) return;
    ensurePanel();
    $(".panel").classList.toggle("collapsed", S.collapsed);
    $(".status").textContent = S.status;

    const items = [...S.works.values()];
    const doneN = items.filter((w) => S.downloaded.has(w.videoId)).length;
    $(".stat").textContent = `${currentAuthor()} ｜ 已采集 ${items.length} 条` +
      (doneN ? `（新 ${items.length - doneN} · 已存 ${doneN}）` : "");

    const autoBtn = $('[data-act="auto"]');
    autoBtn.textContent = S.autoRunning ? "停止采集" : "自动采集";
    autoBtn.classList.toggle("on", S.autoRunning);

    const list = $(".list");
    list.textContent = "";
    items.sort((a, b) => b.timestampMs - a.timestampMs).forEach((w, i) => {
      const row = document.createElement("div");
      row.className = "item";
      const idx = document.createElement("span"); idx.className = "idx"; idx.textContent = String(i + 1);
      const badge = document.createElement("span"); badge.className = `badge ${w.kind}`;
      badge.textContent = w.kind === "video" ? "视频" : "图集";
      const name = document.createElement("span"); name.className = "name";
      name.textContent = name.title = w.title || w.videoId;
      row.append(idx, badge);
      if (S.downloaded.has(w.videoId)) {
        row.classList.add("item-done");
        const done = document.createElement("span"); done.className = "badge done"; done.textContent = "已存";
        row.append(done);
      }
      row.append(name);
      list.appendChild(row);
    });
    renderQueue();
  }

  function setStatus(text) {
    S.status = text || "";
    const el = $(".status");
    if (el) el.textContent = S.status;
  }

  function onPanelClick(event) {
    const btn = event.target.closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "collapse") { S.collapsed = !S.collapsed; renderPanel(); }
    else if (act === "auto") { S.autoRunning ? stopAuto("已手动停止") : startAuto(); }
    else if (act === "download") { downloadAll(); }
  }

  // ---------- 下载队列数字 ----------

  function renderQueue() {
    const line = $(".qline");
    if (!line) return;
    const q = S.queue;
    const headQ = $(".head-q");
    if (!q) { line.textContent = "下载队列：—"; headQ.textContent = ""; return; }

    // 每个平台各一条下载通道，面板只显示本平台的数；别的平台还有在排/在下的，补一句
    const by = q.byPlatform || {};
    const mine = by[A.platform] || { queued: 0, active: 0, done: 0, failed: 0 };
    line.textContent = "下载队列：";
    [["排队", mine.queued], ["下载中", mine.active], ["完成", mine.done], ["失败", mine.failed]].forEach(([k, v], i) => {
      const b = document.createElement("b");
      b.textContent = String(v || 0);
      line.append(i ? " · " + k + " " : k + " ", b);
    });
    const others = Object.entries(by).filter(([p, v]) => p !== A.platform && (v.queued || v.active));
    if (others.length) {
      const oq = others.reduce((n, [, v]) => n + v.queued + v.active, 0);
      line.append(`（其它平台还有 ${oq} 个在排队/下载，各走各的，不影响这里）`);
    }
    const paused = !!(q.pausedBy && q.pausedBy[A.platform]);
    if (paused) line.append(` ｜ ⏸ ${A.label}已暂停出队（点扩展图标继续）`);

    // 折叠时标题栏上留一个最小的数字，不用展开也能看到还剩多少
    headQ.textContent = S.collapsed && (mine.queued || mine.active)
      ? `${paused ? "⏸ " : ""}排队 ${mine.queued} · 下载中 ${mine.active}`
      : "";
  }

  async function refreshQueue() {
    const st = await send({ cmd: "getState" });
    if (st) { S.queue = st; renderQueue(); }
  }

  let pollTimer = 0;
  function pollQueue() {
    clearTimeout(pollTimer);
    if (contextDead || !host || !host.isConnected) return;
    // 标签页在后台时不轮询，免得一直把 service worker 叫醒
    if (!document.hidden) refreshQueue();
    pollTimer = setTimeout(pollQueue, CFG.queuePollMs);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollQueue(); });

  // ---------- 入队下载 ----------

  async function downloadAll() {
    const all = [...S.works.values()];
    if (!all.length) { setStatus("还没有采集到作品，先点「自动采集」"); return; }
    const items = all.filter((w) => !S.downloaded.has(w.videoId));
    if (!items.length) { setStatus(`已采集的 ${all.length} 条都下载过了`); return; }

    const works = items.map((w) => ({
      platform: A.platform,
      videoId: w.videoId, kind: w.kind, author: sanitize(w.author),
      title: sanitize(w.title || w.videoId), dateStr: dateStr(w.timestampMs),
      videoUrl: w.videoUrl, videoUrls: w.videoUrls || (w.videoUrl ? [w.videoUrl] : []),
      imageUrls: w.imageUrls, pageUrl: w.pageUrl || ""
    }));
    const r = await send({ cmd: "enqueue", works });
    if (!r) return;
    refreshQueue();
    const skipped = all.length - items.length;
    setStatus(`已把 ${items.length} 条作品（${r.added} 个文件）加入队列` +
      (skipped ? `，跳过 ${skipped} 条已存` : "") +
      (r.skipped ? `，${r.skipped} 个文件本来就在队列里` : "") +
      (S.queue && S.queue.pausedBy && S.queue.pausedBy[A.platform]
        ? ` —— ${A.label}现在是暂停出队状态，点扩展图标里${A.label}那一行的「▶」才会开始下` : ""));
  }

  // ---------- 自动下滑 ----------

  function captchaVisible() {
    const el = document.querySelector(A.captchaSelector);
    if (el && el.offsetParent !== null) return true;
    return A.captchaText.test((document.body && document.body.innerText || "").slice(0, 6000));
  }

  // 很多布局是「整页不滚，作品流是里面一个自己 overflow:auto 的容器」——只滚 window 不会动，
  // 单猜一个容器又容易猜错。收集前 3 名候选连同 window 一起滚。
  let cachedScrollEls = null;
  function findScrollEls() {
    if (cachedScrollEls && cachedScrollEls.length &&
        cachedScrollEls.every((el) => document.documentElement.contains(el))) {
      return cachedScrollEls;
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
    cachedScrollEls = candidates.slice(0, 3).map((c) => c.el);
    return cachedScrollEls;
  }

  // 有些虚拟列表直接读 wheel 的 deltaY 自己算偏移，补一发 wheel 事件
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

  // 只在作品列表页滑：打开了视频（播放层里往下滑会切到下一个视频）或去了别的页面就暂停
  const onListPage = (owner) => A.profileOwner() === owner;

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (test()) return true; await sleep(250); }
    return test();
  }

  function requestState() {
    window.postMessage({ source: TAG, kind: "dump-state" }, location.origin);
  }

  // 后台取详情：逐篇调 adapter.detail.fetchNote，每篇间隔 1~2 秒。和下滑采集同时跑，
  // 列表里新出来的待取详情会被它陆续取掉。stopWhenEmpty 为真时取完就收工，否则等下滑那边
  // 喂新的进来。被拦截（风控、跳登录页）立即停，返回原因；正常结束返回 ""。
  const detailRun = { active: false, blocked: "", missing: 0 };

  async function runDetails(owner, until) {
    detailRun.active = true;
    detailRun.blocked = "";
    try {
      while (S.autoRunning && S.owner === owner) {
        // 先把没试过的取一遍，失败过一次的放到最后再试
        const pend = [...S.pending.values()];
        const item = pend.find((w) => !S.tries.get(w.videoId)) || pend.find((w) => S.tries.get(w.videoId) < 2);
        if (!item) {
          if (until()) return "";
          await sleep(500);
          continue;
        }
        S.tries.set(item.videoId, (S.tries.get(item.videoId) || 0) + 1);
        const r = await A.detail.fetchNote(item);
        if (S.owner !== owner) return "";
        if (r.blocked) { detailRun.blocked = r.blocked; return r.blocked; }
        if (r.work) {
          absorb([r.work], "detail");
          refreshDownloaded();
        } else if (S.tries.get(item.videoId) >= 2) {
          detailRun.missing++;
        }
        setStatus(`自动采集中… 已采集 ${S.works.size} 条，列表已加载 ${S.works.size + S.pending.size} 条` +
          (detailRun.missing ? `（${detailRun.missing} 条取不到，可能已删除）` : ""));
        renderPanel();
        await sleep(rand(800, 1500));
      }
      return "";
    } finally {
      detailRun.active = false;
    }
  }

  async function startAuto() {
    if (S.autoRunning || !S.owner) return;
    if (!onListPage(S.owner)) { setStatus("先回到作者的作品列表页，再点「自动采集」"); return; }
    S.autoRunning = true;
    S.tries.clear();               // 上一轮没取到详情的，这一轮再给两次机会
    const owner = S.owner;
    renderPanel();

    let idle = 0, round = 0, listDone = false;
    const start = S.works.size;
    detailRun.missing = 0;
    if (A.detail) requestState();
    // 取详情和下滑同时跑；下滑到底以后，取详情把剩下的取完才算结束
    const details = A.detail ? runDetails(owner, () => listDone) : Promise.resolve("");

    while (S.autoRunning && onListPage(owner)) {
      if (captchaVisible()) {
        stopAuto("检测到安全验证，已暂停 —— 在页面完成验证后再点「自动采集」");
        return;
      }
      if (detailRun.blocked) break;
      // 取详情的平台：等取详情跟上了再滑，页面滚动和采集进度保持一致
      if (A.detail) {
        const backlog = () => [...S.pending.keys()].filter((id) => !S.tries.get(id)).length;
        while (S.autoRunning && !detailRun.blocked && backlog() > CFG.detailBacklog) await sleep(500);
        if (!S.autoRunning || detailRun.blocked) break;
      }
      const before = S.works.size + S.pending.size;
      scrollFeedDown();
      await sleep(rand(CFG.scrollMinGap, CFG.scrollMaxGap));
      if (!onListPage(owner)) break;
      if (Math.random() < 0.3) { scrollFeedBy(-Math.round(rand(200, 500))); await sleep(rand(300, 700)); }
      if (A.detail) { requestState(); await sleep(400); }

      round++;
      // 标签页在后台时 Chrome 会限速页面的懒加载，采不到新内容不代表到底了，不计空转
      if (S.works.size + S.pending.size === before) { if (!document.hidden) idle++; } else { idle = 0; }
      if (!A.detail) {
        setStatus(`自动采集中… 第 ${round} 轮，累计 ${S.works.size} 条` +
          (document.hidden ? "（标签页在后台，可能被浏览器限速，建议切回前台）" : ""));
      }
      renderPanel();
      if (idle >= CFG.idleRoundsStop) break;
    }
    // 列表滑到底了；取详情的把剩下的取完（它自己会在被拦截、用户停止、换作者时退出）
    listDone = true;
    const blockedWhy = await details;
    if (S.owner !== owner) return;   // 中途进了别的作者主页，syncPage 已经清场
    if (captchaVisible()) {
      stopAuto(`检测到安全验证，已暂停 —— 已采集 ${S.works.size} 条，在页面完成验证后再点「自动采集」接着来`);
      return;
    }
    if (!S.autoRunning) return;      // 用户点了「停止采集」，stopAuto 已经提示过
    if (blockedWhy) {
      stopAuto(`${A.label}拦下了请求（${blockedWhy}），可能触发了风控，已停止。` +
        `已采集 ${S.works.size} 条；歇一会儿、刷新页面确认能正常浏览后，再点「自动采集」接着来`);
      return;
    }
    if (!onListPage(owner) && !A.detail) {
      stopAuto(`自动采集已暂停（打开了作品或离开了作品页），已采集 ${S.works.size} 条，回到作品页再点「自动采集」接着来`);
      return;
    }

    stopAuto(`自动采集结束：新增 ${S.works.size - start} 条，共 ${S.works.size} 条` +
      (S.pending.size ? `；另有 ${S.pending.size} 条取不到内容（可能已删除），再点一次「自动采集」会再试` : "") +
      (S.works.size === 0 && !S.pending.size ? "（0 条：确认已登录，刷新页面再试；F12 Console 里有每次接口回包的记录）" : ""));
  }

  function stopAuto(msg) {
    S.autoRunning = false;
    renderPanel();
    if (msg) setStatus(msg);
  }

  // ---------- 启动 ----------

  const boot = () => { if (S.visible) renderPanel(); };
  boot();
  setTimeout(boot, 1200);

  LOG("content 已就绪", location.href, S.owner ? "（创作者主页）" : "（不是创作者主页，不采集）");
})();
