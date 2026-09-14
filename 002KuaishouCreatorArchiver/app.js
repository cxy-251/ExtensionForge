/*
 * 控制台页（作为独立标签页打开）。职责：
 *  - 创作者列表管理（导入 kuaiChannels.txt）
 *  - 连续采集调度：逐个开创作者主页 → 通知 content.js 自动滚动采集+下载 → 等回报 → 关页 → 等 → 下一个
 *  - File System Access 磁盘层：授权一次「下载根目录」后
 *      · 开跑前把每个 <前缀>/<作者>/downloaded.txt 读进 chrome.storage 的 dl: 索引（去重依据）
 *      · background 每记一条已下（arc:<作者> 变化）→ 本页把该作者的 downloaded.txt 写回（不走下载栏）
 *  - 下载队列监控
 *
 * service worker 不能用 File System Access，也不适合跑长循环，所以这些都在本页。
 */
"use strict";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function safeSeg(s) {
  return String(s == null ? "" : s)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_").replace(/\.+$/, "").replace(/\s+/g, " ").trim()
    .slice(0, 80) || "_";
}
function parseIds(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((l) => {
    const m = l.trim().match(/(?:kuaishou\s+)?([A-Za-z0-9_-]{8,})/);
    if (m) out.push(m[1]);
  });
  return out;
}
function archiveBody(ids) {
  return [...new Set(ids)].sort().map((id) => "kuaishou " + id).join("\n") + "\n";
}

// ================= File System Access =================

const IDB_DB = "kca-fs";
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("h");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const t = d.transaction("h", "readonly").objectStore("h").get(k);
    t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
  });
}
async function idbSet(k, v) {
  const d = await idbOpen();
  return new Promise((res, rej) => {
    const t = d.transaction("h", "readwrite").objectStore("h").put(v, k);
    t.onsuccess = () => res(); t.onerror = () => rej(t.error);
  });
}

let rootHandle = null;

async function perm() {
  if (!rootHandle) return "none";
  try { return await rootHandle.queryPermission({ mode: "readwrite" }); }
  catch { return "prompt"; }
}

// 心跳：本页持有已授权句柄时，每 30s 写一次 kca:fsActive。background.js 看到心跳新鲜
// 就把 downloaded.txt 的写盘让给本页（不闪下载栏）；心跳过期则由它用下载 API 兜底。
async function fsHeartbeat() {
  try {
    if (rootHandle && (await perm()) === "granted") {
      await chrome.storage.local.set({ "kca:fsActive": Date.now() });
    }
  } catch (_) {}
}
setInterval(fsHeartbeat, 30_000);
window.addEventListener("beforeunload", () => {
  try { chrome.storage.local.remove("kca:fsActive"); } catch (_) {}
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushAllTxt().catch(() => {});
});

async function fsStatus() {
  const p = await perm();
  if (p === "granted") {
    $("fsStat").textContent = `已授权：${rootHandle.name}/  →  读写 <前缀>/<作者>/downloaded.txt`;
    $("fsGrant").textContent = "重新选择目录";
  } else if (p === "prompt") {
    $("fsStat").textContent = `需要重新确认对「${rootHandle.name}」的访问`;
    $("fsGrant").textContent = "重新授权";
  } else {
    $("fsStat").textContent = "未授权 —— 只用浏览器索引去重，不写 downloaded.txt";
    $("fsGrant").textContent = "授权下载根目录";
  }
  return p;
}

async function ensureGranted() {
  const p = await perm();
  if (p === "granted") return true;
  if (p === "prompt") {
    try {
      const r = await rootHandle.requestPermission({ mode: "readwrite" });
      if (r === "granted") { await fsStatus(); return true; }
    } catch (_) {}
  }
  return false;
}

async function prefixDir(create) {
  const pref = ($("saveRoot").value || "快手").trim();
  let h = rootHandle;
  for (const seg of pref.split(/[\\/]+/).filter(Boolean)) {
    h = await h.getDirectoryHandle(safeSeg(seg), { create: !!create });
  }
  return h;
}

async function readArchive(author) {
  try {
    const dir = await (await prefixDir(false)).getDirectoryHandle(safeSeg(author), { create: false });
    const fh = await dir.getFileHandle("downloaded.txt", { create: false });
    return new Set(parseIds(await (await fh.getFile()).text()));
  } catch (_) { return new Set(); }
}

async function writeArchive(author, ids) {
  const dir = await (await prefixDir(true)).getDirectoryHandle(safeSeg(author), { create: true });
  const fh = await dir.getFileHandle("downloaded.txt", { create: true });
  const w = await fh.createWritable();
  await w.write(archiveBody([...ids]));
  await w.close();
}

// 磁盘 → chrome.storage：把所有 downloaded.txt 读进 dl:/arc: 索引
async function syncFromDisk(silent) {
  if (!(await ensureGranted())) return;
  if (!silent) loopStat("从磁盘同步 downloaded.txt …");
  let pre;
  try { pre = await prefixDir(false); }
  catch { if (!silent) loopStat("授权目录下还没有「前缀」文件夹，跳过同步"); return; }

  const existing = await chrome.storage.local.get(null);
  const patch = {};
  let authors = 0, total = 0;
  try {
    for await (const [name, h] of pre.entries()) {
      if (h.kind !== "directory") continue;
      try {
        const fh = await h.getFileHandle("downloaded.txt", { create: false });
        const ids = parseIds(await (await fh.getFile()).text());
        if (!ids.length) continue;
        authors++;
        // 并集：磁盘上的 id + storage 里已有的 arc:（可能有本页还没写盘的新下载）——
        // 绝不能用磁盘内容直接覆盖 arc:，否则会把「刚下完、txt 还没写」的记录冲掉。
        const merged = new Set(ids);
        const prev = existing["arc:" + name];
        if (Array.isArray(prev)) prev.forEach((id) => merged.add(id));
        merged.forEach((id) => { if (!existing["dl:" + id]) patch["dl:" + id] = Date.now(); });
        patch["arc:" + name] = [...merged];
        total += merged.size;
      } catch (_) {}
    }
  } catch (e) { console.warn("[快手归档] 同步磁盘失败", e); }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  refreshDedup();
  flushAllTxt().catch(() => {});   // 反向补写各 downloaded.txt —— 后台跑，不挡采集
  if (!silent) loopStat(`已从磁盘同步 ${authors} 个作者、${total} 条已下 id`);
}

// storage(arc:*) → 磁盘：遍历所有作者，把 downloaded.txt 补成「磁盘 ∪ storage」。
// 幂等，syncFromDisk 尾部和「立即同步磁盘」都会调。
let flushAllRunning = false;
async function flushAllTxt() {
  if (flushAllRunning) return;
  if (!(await ensureGranted())) return;
  flushAllRunning = true;
  try {
    const all = await chrome.storage.local.get(null);
    const authors = Object.keys(all).filter((k) => k.startsWith("arc:")).map((k) => k.slice(4));
    for (const a of authors) {
      try { await flushTxt(a); } catch (_) {}
      await sleep(120);
    }
  } catch (_) {
  } finally {
    flushAllRunning = false;
  }
}

// chrome.storage(arc:*) → 磁盘：某作者已下集合变了就写回其 downloaded.txt（每作者防抖）
const txtTimers = new Map();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !rootHandle) return;
  for (const k of Object.keys(changes)) {
    if (!k.startsWith("arc:")) continue;
    const author = k.slice(4);
    clearTimeout(txtTimers.get(author));
    txtTimers.set(author, setTimeout(() => flushTxt(author), 5000));
  }
  if (Object.keys(changes).some((k) => k.startsWith("dl:"))) refreshDedup();
});
async function flushTxt(author) {
  txtTimers.delete(author);
  if (!(await ensureGranted())) return;
  try {
    const got = await chrome.storage.local.get("arc:" + author);
    const ids = new Set(Array.isArray(got["arc:" + author]) ? got["arc:" + author] : []);
    if (!ids.size) return;
    (await readArchive(author)).forEach((x) => ids.add(x));
    await writeArchive(author, ids);
    // 若并集比 storage 里的 arc: 大（磁盘上有历史 id），把 arc: 也补齐，
    // 并记下已写盘数量，让 background.js 的兜底写盘不再重复触发。
    if (ids.size !== (got["arc:" + author] || []).length) {
      await chrome.storage.local.set({ ["arc:" + author]: [...ids] });
    }
    await chrome.storage.local.set({ ["txt:" + author]: ids.size });
  } catch (e) { console.warn("[快手归档] 写 downloaded.txt 失败", author, e); }
}

$("fsGrant").addEventListener("click", async () => {
  try {
    if (rootHandle && (await perm()) === "prompt" && await ensureGranted()) { syncFromDisk(); return; }
    rootHandle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "downloads" });
    await idbSet("root", rootHandle);
    await fsStatus();
    syncFromDisk();
  } catch (_) { /* 用户取消 */ }
});
$("fsSync").addEventListener("click", () => syncFromDisk());

// ================= 创作者列表 =================

async function getCreators() {
  const { creators } = await chrome.storage.local.get("creators");
  return Array.isArray(creators) ? creators : [];
}
async function setCreators(list) {
  await chrome.storage.local.set({ creators: list });
  renderListStat(list);
}
async function importList(text) {
  const byId = new Map((await getCreators()).map((c) => [c.id, c]));
  let added = 0;
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(/profile\/([A-Za-z0-9_-]+)/);
    if (!m) return;
    if (byId.has(m[1])) return;
    byId.set(m[1], { id: m[1], url: `https://www.kuaishou.com/profile/${m[1]}`, status: "pending", works: 0, lastRunAt: 0, attempts: 0 });
    added++;
  });
  const merged = [...byId.values()];
  await setCreators(merged);
  return { added, total: merged.length };
}
async function markCreator(id, patch) {
  const list = await getCreators();
  const c = list.find((x) => x.id === id);
  if (c) Object.assign(c, patch);
  await setCreators(list);
}
function renderListStat(list) {
  const total = list.length;
  const done = list.filter((c) => c.status === "done").length;
  const err = list.filter((c) => c.status === "error").length;
  // "0 作品(已完成)"——账号真被对方清空了，还是我们自己滚动/采集失败漏采了，单看这个数字
  // 分不清，只统计给你自己判断，不自动清（滚动 bug 没修好之前，这个数字不完全可信）
  const emptyDone = list.filter((c) => c.status === "done" && !(c.works > 0)).length;
  $("listStat").textContent = total
    ? `共 ${total} 位 ｜ 待处理 ${total - done - err} · 已完成 ${done} · 失败 ${err}` +
      (emptyDone ? ` · ⚠️ 已完成但 0 作品 ${emptyDone}` : "")
    : "尚未导入";
  $("progressBar").style.width = (total ? Math.round(((done + err) / total) * 100) : 0) + "%";
  const reviewBtn = $("reviewEmptyBtn");
  if (reviewBtn) reviewBtn.style.display = emptyDone ? "inline-block" : "none";
}

// 只列出来给你自己看、自己决定删不删——不自动清空，原因见上面注释
async function reviewEmptyAccounts() {
  const list = await getCreators();
  const empties = list.filter((c) => c.status === "done" && !(c.works > 0));
  if (!empties.length) { loopStat("没有「已完成但 0 作品」的账号"); return; }
  const lines = empties.map((c) => `${c.id}\t${c.url}`).join("\n");
  try {
    await navigator.clipboard.writeText(lines);
    loopStat(`${empties.length} 个「已完成但 0 作品」账号的链接已复制到剪贴板，自己核实/取舍`);
  } catch (_) {
    console.log("[快手归档] 0 作品账号列表：\n" + lines);
    loopStat(`${empties.length} 个「已完成但 0 作品」账号——剪贴板权限被拒，已打印到 Console(F12)`);
  }
}

// 确认要清了再点——把「已完成且 0 作品」的账号从列表里移除，不影响已经下载好的文件
async function removeEmptyAccounts() {
  const list = await getCreators();
  const empties = list.filter((c) => c.status === "done" && !(c.works > 0));
  if (!empties.length) { loopStat("没有「已完成但 0 作品」的账号"); return; }
  if (!confirm(`确定要从列表里移除这 ${empties.length} 个「已完成但 0 作品」的账号吗？\n（不会删除已经下载好的视频，只是不再帮你追这些账号的更新）`)) return;
  const kept = list.filter((c) => !(c.status === "done" && !(c.works > 0)));
  await setCreators(kept);
  loopStat(`已移除 ${empties.length} 个 0 作品账号，列表还剩 ${kept.length} 位`);
}

// ================= 连续采集 =================

// loop.resume：上一个创作者没跑完（撞验证码 / 一直没响应）时挂在这里
// {creatorId, tabId, maxRounds, reason: "captcha"|"retry"}——
// 「打开下一个」按钮据此变成「继续」，不会绕过它直接开一个新的。
const loop = { running: false, currentTabId: null, resume: null };
function loopStat(t) { $("loopStat").textContent = t; }
function updateLoopUI() {
  const b = $("toggleLoop");
  b.textContent = loop.running ? "停止连续模式" : "开始连续模式";
  b.classList.toggle("on", loop.running);
}
function updateOpenNextButton() {
  const b = $("openNext");
  if (loop.resume) {
    b.textContent = (loop.resume.reason === "captcha" ? "继续（验证码）" : "继续采集") + ` ${loop.resume.creatorId}`;
    b.classList.add("on");
  } else {
    b.textContent = "打开下一个";
    b.classList.remove("on");
  }
}
function readGaps() {
  const min = Math.max(3, Number($("gapMin").value) || 20);
  const max = Math.max(min, Number($("gapMax").value) || 45);
  return [min * 1000, max * 1000];
}

async function sendAutoCollect(tabId, token, maxRounds) {
  // 多给点耐心：45 次 × 750ms ≈ 34s，覆盖首次打开加载慢的情况
  for (let i = 0; i < 45; i++) {
    try {
      // 标签页被关掉/跳转到别处了就别再傻等，直接判失败
      await chrome.tabs.get(tabId);
      const r = await chrome.tabs.sendMessage(tabId, { cmd: "autoCollect", token, maxRounds, autoDownload: true });
      if (r && r.started) return true;
    } catch (e) {
      if (String(e && e.message || e).includes("No tab with id")) return false;
    }
    await sleep(750);
  }
  return false;
}
function waitForResult(token, maxRounds) {
  // maxRounds 默认已经提到 600（配合更高的滚动轮数上限），按 3000ms/轮算会比 startAuto
  // 自己的滚动间隔(最长 5.5s+回滚)更早超时，误判成"没响应"——按 8s/轮留够余量
  const timeoutMs = maxRounds * 8000 + 60000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; chrome.runtime.onMessage.removeListener(onMsg); clearTimeout(timer); resolve(r); };
    const onMsg = (m) => {
      if (!m || m.token !== token) return;
      if (m.cmd === "collectResult") finish({ ok: !!m.ok, count: m.count || 0, captcha: !!m.captcha });
      else if (m.cmd === "captcha") finish({ ok: false, count: 0, captcha: true });
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer = setTimeout(() => finish({ ok: false, count: 0, timeout: true }), timeoutMs);
  });
}

// 后台标签页开创作者主页。撞验证码时用 bringTabForward() 把它拉到前台方便手动划。
async function bringTabForward(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
}

async function processOne(creator, maxRounds) {
  loop.resume = null;
  updateOpenNextButton();
  loopStat(`打开 ${creator.id} …`);
  const tab = await chrome.tabs.create({ url: creator.url, active: false });
  loop.currentTabId = tab.id;
  await markCreator(creator.id, { status: "running" });

  const token = Date.now().toString(36) + Math.random().toString(16).slice(2);
  const resultP = waitForResult(token, maxRounds);
  const nextAttempts = (creator.attempts || 0) + 1;
  if (!await sendAutoCollect(tab.id, token, maxRounds)) {
    await markCreator(creator.id, { status: "error", lastRunAt: Date.now(), attempts: nextAttempts });
    // 一直没收到响应——先别关，留给你看看标签页里卡在哪；「继续」按钮会变成重试这一个
    loop.resume = { creatorId: creator.id, tabId: tab.id, maxRounds, reason: "retry" };
    loop.currentTabId = null;
    updateOpenNextButton();
    return { ok: false, needResume: true };
  }
  const res = await resultP;
  if (res.captcha) {
    await markCreator(creator.id, { status: "pending" });
    loop.resume = { creatorId: creator.id, tabId: tab.id, maxRounds, reason: "captcha" };
    bringTabForward(tab.id);
    updateOpenNextButton();
    return { captcha: true };
  }
  await markCreator(creator.id, {
    status: res.ok ? "done" : "error",
    works: res.count,
    lastRunAt: Date.now(),
    attempts: res.ok ? (creator.attempts || 0) : nextAttempts
  });
  if (!$("keepTabs").checked) chrome.tabs.remove(tab.id).catch(() => {});
  loop.currentTabId = null;
  return { ok: res.ok, count: res.count };
}

async function runLoop() {
  if (loop.running) return;
  loop.running = true;
  updateLoopUI();

  if (rootHandle) await syncFromDisk(true);   // 开跑前用磁盘上的 downloaded.txt 刷新去重索引

  const maxRounds = Math.max(5, Number($("maxRounds").value) || 600);
  const [gapMin, gapMax] = readGaps();

  const MAX_ATTEMPTS = 2;
  while (loop.running) {
    let next = (await getCreators()).find((c) => c.status === "pending");
    if (!next) {
      // 待处理清空后，自动把「失败但尝试次数 < 2」的提回 pending 再跑一轮
      const list = await getCreators();
      const retriables = list.filter((c) => c.status === "error" && (c.attempts || 0) < MAX_ATTEMPTS);
      if (retriables.length) {
        retriables.forEach((c) => { c.status = "pending"; });
        await setCreators(list);
        loopStat(`自动重试 ${retriables.length} 个失败项…`);
        continue;
      }
      loopStat("列表已全部处理完 🎉");
      break;
    }

    const r = await processOne(next, maxRounds);
    if (r.captcha || r.needResume) {
      loop.running = false;
      loopStat(r.captcha
        ? "⚠️ 遇到安全验证：在弹出的标签页完成验证，然后点「继续」"
        : `⚠️ ${next.id} 一直没响应，看看标签页卡在哪，处理完点「继续」`);
      updateLoopUI();
      return;
    }
    const remain = (await getCreators()).filter((c) => c.status === "pending").length;
    loopStat(`${next.id} 采集 ${r.count || 0} 条，剩余 ${remain} 位，等待中…`);
    if (!loop.running) break;
    await sleep(rand(gapMin, gapMax));
  }
  loop.running = false;
  updateLoopUI();
}

// 统一处理「继续」：撞验证码 / 一直没响应 都走这条，对同一个标签页重发一次采集指令，
// 不会绕过它去开一个新的创作者。标签页已经不在了（你手动关掉了）就当跳过，接着往下走。
async function resumeCollect() {
  const wc = loop.resume;
  loop.resume = null;
  updateOpenNextButton();
  if (!wc) { await openNextOnce(); return; }

  let alive = true;
  try { await chrome.tabs.get(wc.tabId); } catch { alive = false; }
  if (!alive) {
    loopStat(`${wc.creatorId} 的标签页已经不在了，跳过`);
    if (loop.running) runLoop(); else await openNextOnce();
    return;
  }

  const token = Date.now().toString(36) + Math.random().toString(16).slice(2);
  const resultP = waitForResult(token, wc.maxRounds);
  const started = await sendAutoCollect(wc.tabId, token, wc.maxRounds);
  if (!started) {
    loop.resume = { ...wc, reason: "retry" };
    updateOpenNextButton();
    loopStat(`${wc.creatorId} 还是没响应——标签页留着，你可以看看，或手动关掉它后再点「继续」跳过`);
    return;
  }
  const res = await resultP;
  if (res.captcha) {
    loop.resume = { ...wc, reason: "captcha" };
    bringTabForward(wc.tabId);
    updateOpenNextButton();
    loopStat("⚠️ 仍在验证，完成后再点「继续」");
    return;
  }
  const cur = (await getCreators()).find((c) => c.id === wc.creatorId) || {};
  await markCreator(wc.creatorId, {
    status: res.ok ? "done" : "error",
    works: res.count,
    lastRunAt: Date.now(),
    attempts: res.ok ? (cur.attempts || 0) : (cur.attempts || 0) + 1
  });
  if (!$("keepTabs").checked) chrome.tabs.remove(wc.tabId).catch(() => {});
  loopStat(`${wc.creatorId} 采集 ${res.count || 0} 条`);
  if (loop.running) runLoop();
}

async function openNextOnce() {
  const maxRounds = Math.max(5, Number($("maxRounds").value) || 600);
  if (rootHandle) await syncFromDisk(true);
  const next = (await getCreators()).find((c) => c.status === "pending");
  if (!next) { loopStat("没有待处理的创作者"); return; }
  const r = await processOne(next, maxRounds);
  loopStat(r.captcha ? "⚠️ 遇到安全验证，完成后点「继续」"
    : r.needResume ? `⚠️ ${next.id} 一直没响应，看看标签页卡在哪，处理完点「继续」`
    : `${next.id} 采集 ${r.count || 0} 条`);
}

// ================= 下载队列 / 去重记录 =================

async function refreshQueue() {
  const st = await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null);
  if (!st) return;
  const s = st.stats || { done: 0, failed: 0 };
  $("dlStat").textContent = `完成 ${s.done || 0} · 失败 ${s.failed || 0} · 排队 ${st.queued || 0}（进行中 ${st.active || 0}）`;
  $("toggleQueue").textContent = st.paused ? "继续队列" : "暂停队列";
  if (st.settings) {
    if (!$("concurrency").matches(":focus")) $("concurrency").value = st.settings.concurrency;
    if (!$("saveRoot").matches(":focus")) $("saveRoot").value = st.settings.saveRoot;
  }
}
async function refreshDedup() {
  try {
    const all = await chrome.storage.local.get(null);
    $("dedupStat").textContent = `已下记录 ${Object.keys(all).filter((k) => k.startsWith("dl:")).length} 条`;
  } catch (_) {}
}
async function saveSettings() {
  // betweenMs 不在界面上给改，沿用 background.js 里的默认值，别在这儿写死覆盖掉
  const st = await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null);
  await chrome.runtime.sendMessage({
    cmd: "saveSettings",
    settings: {
      saveRoot: $("saveRoot").value.trim() || "快手",
      concurrency: Math.min(8, Math.max(1, Number($("concurrency").value) || 2)),
      betweenMs: (st && st.settings && st.settings.betweenMs) || 1500
    }
  }).catch(() => {});
}

// ================= 事件绑定 =================

$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const { added, total } = await importList(await f.text());
  loopStat(`已导入 ${added} 位新创作者，列表共 ${total} 位`);
});
$("clearList").addEventListener("click", async () => { await setCreators([]); loopStat("列表已清空"); });

$("retryErrors").addEventListener("click", async () => {
  const list = await getCreators();
  let n = 0;
  for (const c of list) if (c.status === "error") { c.status = "pending"; c.attempts = 0; n++; }
  if (n) await setCreators(list);
  loopStat(n ? `已把 ${n} 个失败项重置为待处理，可点「开始连续模式」` : "没有失败项");
});

$("toggleLoop").addEventListener("click", () => {
  if (loop.running) { loop.running = false; updateLoopUI(); loopStat("已停止（当前作者完成后收尾）"); }
  else if (loop.resume) resumeCollect();
  else runLoop();
});
$("openNext").addEventListener("click", () => resumeCollect());
$("keepTabs").addEventListener("change", () => chrome.storage.local.set({ keepTabs: $("keepTabs").checked }));

$("toggleQueue").addEventListener("click", async () => {
  const st = await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null);
  await chrome.runtime.sendMessage({ cmd: st && st.paused ? "resumeQueue" : "pauseQueue" }).catch(() => {});
  refreshQueue();
});
$("clearQueue").addEventListener("click", async () => { await chrome.runtime.sendMessage({ cmd: "clearQueue" }).catch(() => {}); refreshQueue(); });
["concurrency", "saveRoot"].forEach((id) => $(id).addEventListener("change", saveSettings));

$("resetDedup").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("dl:") || k.startsWith("arc:"));
  if (keys.length) await chrome.storage.local.remove(keys);
  $("dedupStat").textContent = "已下记录 0 条（已清空索引；磁盘上的 downloaded.txt 未动，可「立即同步磁盘」找回）";
});
$("importArchive").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (!files.length) return;
  const ids = new Set();
  for (const f of files) parseIds(await f.text()).forEach((id) => ids.add(id));
  if (!ids.size) { $("dedupStat").textContent = "导入：没解析出 id"; return; }
  const patch = {};
  [...ids].forEach((id) => { patch["dl:" + id] = Date.now(); });
  await chrome.storage.local.set(patch);
  refreshDedup();
  $("dedupStat").textContent = `导入 ${ids.size} 条 id`;
});

chrome.runtime.onMessage.addListener((m) => {
  if (m && m.cmd === "stats") refreshQueue();
  if (m && m.cmd === "captcha" && loop.running) loopStat("⚠️ 检测到安全验证，请到标签页完成");
});

// ================= 初始化 =================

(async () => {
  try { rootHandle = await idbGet("root"); } catch (_) {}
  await fsStatus();

  const list = await getCreators();
  let dirty = false;
  for (const c of list) if (c.status === "running") { c.status = "pending"; dirty = true; }
  if (dirty) await setCreators(list);
  renderListStat(await getCreators());

  const { keepTabs } = await chrome.storage.local.get("keepTabs");
  $("keepTabs").checked = Boolean(keepTabs);
  updateLoopUI();
  updateOpenNextButton();
  refreshQueue();
  refreshDedup();
  setInterval(refreshQueue, 2000);
  await fsHeartbeat();
  if (rootHandle && (await perm()) === "granted") syncFromDisk(true);
})();
