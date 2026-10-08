/*
 * 采集面板 + 采集流程，三个平台共用。平台相关的部分全部走 SVA.adapter。
 *
 * 只在创作者主页「作品」页工作（adapter.profileOwner() 非空）：自动下滑采集作品、
 * 一键入队下载。离开主页面板就收起，回来重新出现。
 *
 *  - 面板挂在 Shadow DOM 里，样式用 constructable stylesheet 注入——宿主页面的 reset
 *    样式进不来，也不受页面 CSP 的 style-src 限制；
 *  - 面板上只显示一行队列数字；暂停/继续出队、清空排队都在工具栏气泡（popup）里，不重复放。
 *    数字靠轮询 getState（页面可见时每 2 秒一次）：background 的
 *    chrome.runtime.sendMessage 只发给扩展自己的页面，到不了 content 脚本。
 *    paused 另外监听 storage.onChanged，在气泡里点了暂停这里立刻跟上。
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
    queuePollMs: 2000
  });

  const S = {
    owner: A.profileOwner(),   // 当前主页主人；"" = 不是创作者主页作品页
    works: new Map(),          // videoId -> work
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
  // 站内跳转不刷新页面：换了主页、切到点赞/合集标签、点进单个视频，采集列表都清空，
  // 不是主页作品页就把面板收起来。不能把这个标签页之前看过的别的页面的作品算进来。

  function syncPage() {
    const owner = A.profileOwner();
    if (owner === S.owner) return;
    S.owner = owner;
    S.works.clear();
    S.downloaded.clear();
    if (S.autoRunning) S.autoRunning = false;
    if (!owner) { removePanel(); return; }
    renderPanel();
    setStatus("");
  }
  setInterval(syncPage, 1000);

  // ---------- 入库 ----------
  //
  // 接口回包本来就只转发了主页作品列表接口；这里再按作者比对一次：作品作者 id 和主页
  // 主人对不上的不收。首屏状态对象里可能混着别的推荐内容，拿不到作者 id 的也不收。

  function ingest(kind, entry) {
    syncPage();
    if (!S.owner) return;

    let parsed = [];
    try { parsed = A.parsePayload(entry); } catch (err) { LOG("解析异常", err); }

    let added = 0, blocked = 0;
    for (const w of parsed) {
      if (!w.videoId || (!w.videoUrl && !w.imageUrls.length)) continue;
      const verifiable = w.ownerId && S.owner !== "self";
      if ((verifiable && w.ownerId !== S.owner) || (kind === "state" && !w.ownerId)) { blocked++; continue; }
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
    LOG(kind === "api" ? entry.url : `[state:${entry.key}]`, "→ 解析", parsed.length, "新增", added,
      blocked ? `丢弃${blocked}(不是本主页作者)` : "");

    if (added) { renderPanel(); refreshDownloaded(); }
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
    if (changes.paused && S.queue) {
      S.queue.paused = Boolean(changes.paused.newValue);
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
    if (!S.owner) return;
    ensurePanel();
    $(".panel").classList.toggle("collapsed", S.collapsed);

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
    const el = $(".status");
    if (el) el.textContent = text || "";
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

    const s = q.stats || {};
    const mine = (q.byPlatform && q.byPlatform[A.platform]) || { queued: 0 };
    line.textContent = "下载队列：";
    [["排队", q.queued], ["下载中", q.active], ["完成", s.done], ["失败", s.failed]].forEach(([k, v], i) => {
      const b = document.createElement("b");
      b.textContent = String(v || 0);
      line.append(i ? " · " + k + " " : k + " ", b);
    });
    // 队列是三个平台共用的，别的平台也有排队时标一下本平台占多少
    if (q.queued !== mine.queued) line.append(`（${A.label} ${mine.queued}）`);
    if (q.paused) line.append(" ｜ ⏸ 已暂停出队（点扩展图标继续）");

    // 折叠时标题栏上留一个最小的数字，不用展开也能看到还剩多少
    headQ.textContent = S.collapsed && (q.queued || q.active)
      ? `${q.paused ? "⏸ " : ""}排队 ${q.queued} · 下载中 ${q.active}`
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
      imageUrls: w.imageUrls
    }));
    const r = await send({ cmd: "enqueue", works });
    if (!r) return;
    refreshQueue();
    const skipped = all.length - items.length;
    setStatus(`已把 ${items.length} 条作品（${r.added} 个文件）加入队列` +
      (skipped ? `，跳过 ${skipped} 条已存` : "") +
      (r.skipped ? `，${r.skipped} 个文件本来就在队列里` : "") +
      (S.queue && S.queue.paused ? " —— 队列现在是暂停状态，点扩展图标里的「▶ 继续出队」才会开始下" : ""));
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

  async function startAuto() {
    if (S.autoRunning || !S.owner) return;
    S.autoRunning = true;
    const owner = S.owner;
    renderPanel();

    let idle = 0, round = 0;
    const start = S.works.size;

    while (S.autoRunning && S.owner === owner) {
      if (captchaVisible()) {
        stopAuto("检测到安全验证，已暂停 —— 在页面完成验证后再点「自动采集」");
        return;
      }
      const before = S.works.size;
      scrollFeedDown();
      await sleep(rand(CFG.scrollMinGap, CFG.scrollMaxGap));
      if (Math.random() < 0.3) { scrollFeedBy(-Math.round(rand(200, 500))); await sleep(rand(300, 700)); }

      round++;
      // 标签页在后台时 Chrome 会限速页面的懒加载，采不到新内容不代表到底了，不计空转
      if (S.works.size === before) { if (!document.hidden) idle++; } else { idle = 0; }
      setStatus(`自动采集中… 第 ${round} 轮，累计 ${S.works.size} 条` +
        (document.hidden ? "（标签页在后台，可能被浏览器限速，建议切回前台）" : ""));
      renderPanel();
      if (idle >= CFG.idleRoundsStop) break;
    }
    if (S.owner !== owner) return;   // 中途离开了这个主页，syncPage 已经清场

    stopAuto(`自动采集结束：新增 ${S.works.size - start} 条，共 ${S.works.size} 条` +
      (S.works.size === 0 ? "（0 条：确认已登录，刷新页面再试；F12 Console 里有每次接口回包的记录）" : ""));
  }

  function stopAuto(msg) {
    S.autoRunning = false;
    renderPanel();
    if (msg) setStatus(msg);
  }

  // ---------- 启动 ----------

  const boot = () => { if (S.owner) renderPanel(); };
  boot();
  setTimeout(boot, 1200);

  LOG("content 已就绪", location.href, S.owner ? "（创作者主页）" : "（不是创作者主页，不采集）");
})();
