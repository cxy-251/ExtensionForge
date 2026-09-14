/*
 * 后台 service worker：下载队列。
 *
 * content.js 把「作品」结构丢过来，这里展开成一个个下载项，按并发上限交给
 * chrome.downloads，失败重试一次，进度写入 chrome.storage 供 popup 展示。
 *
 * service worker 可能随时被回收：队列每次变动都落盘，onChanged 事件会把它唤醒，
 * 启动时自动续跑。已交给浏览器的下载即使 worker 睡着也会继续。
 */
"use strict";

const DEFAULTS = Object.freeze({
  saveRoot: "快手",
  concurrency: 2,     // 3 个并发同时打 CDN 太密集，降到 2
  betweenMs: 1500,     // 每条起始间隔（下面 pump() 里还会加随机抖动，别卡死点）
  maxTries: 2
});

let queue = [];                 // 待下载项 {id, url, path, workId, kind, tries}
let paused = false;
let active = 0;
const inflight = new Map();     // downloadId -> item

// ---------- 存储 ----------

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULTS, settings || {});
}

async function persist() {
  await chrome.storage.local.set({ queue, paused });
}

async function bumpStats(patch) {
  const { stats } = await chrome.storage.local.get("stats");
  const next = Object.assign({ done: 0, failed: 0, enqueued: 0 }, stats || {});
  for (const k of Object.keys(patch)) next[k] = (next[k] || 0) + patch[k];
  await chrome.storage.local.set({ stats: next });
  broadcast({ cmd: "stats", stats: next, queued: queue.length, active });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---------- 文件名 ----------

function safeSeg(s) {
  return String(s == null ? "" : s)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "_";
}

function joinPath(parts) {
  return parts.filter(Boolean).map(safeSeg).join("/");
}

// ---------- 展开作品 -> 下载项 ----------

let seq = 0;

function expand(work, root) {
  const items = [];
  const author = work.author || "未知作者";
  // 很多创作者一堆视频共用同一句文案当标题（同一天发好几条也常见），光靠"日期+标题"
  // 拼文件名会撞车——Chrome 那时候会默默加 (1)(2)(3) 后缀，看着像重复下载了同一个视频，
  // 其实是不同视频被撞了名。把 videoId 也编进去，从根上保证不同视频不会同名。
  const stem = work.title
    ? [work.dateStr, work.title, work.videoId].filter(Boolean).join("_")
    : [work.dateStr, work.videoId].filter(Boolean).join("_");
  const authorDir = joinPath([root, author]);
  const meta = { workId: work.videoId, author, authorDir, title: work.title || "", dateStr: work.dateStr || "" };

  const vurls = (work.videoUrls && work.videoUrls.length ? work.videoUrls : (work.videoUrl ? [work.videoUrl] : []))
    .filter(Boolean);
  if (work.kind === "video" && vurls.length) {
    items.push({
      id: ++seq,
      url: vurls[0],
      urls: vurls,          // 多个直链，前一个失败就换下一个
      urlIdx: 0,
      path: authorDir + "/" + safeSeg(stem) + ".mp4",
      kind: "video",
      tries: 0,
      ...meta
    });
  }

  if (work.imageUrls && work.imageUrls.length) {
    const folder = joinPath([root, author, stem || work.videoId]);
    work.imageUrls.forEach((url, i) => {
      items.push({
        id: ++seq,
        url,
        path: folder + "/" + String(i + 1).padStart(2, "0") + ".jpg",
        kind: "image",
        tries: 0,
        ...meta
      });
    });
  }

  return items;
}

// ---------- 已下载归档 ----------
//
// 记两处，互为镜像：
//   dl:<videoId>       chrome.storage —— 快查索引，SW / content 都能读，无需控制台页
//   arc:<author>       chrome.storage —— 该作者已下的 videoId 数组
// 控制台页（app.html，有 File System Access）监听 arc:* 变化，把对应作者的
// downloaded.txt 直接写进 <下载根>/<前缀>/<作者>/ —— 不走 chrome.downloads，下载栏不闪。

const arcMem = new Map();   // author -> Set<videoId>（SW 生命周期内的副本，减少读盘）

async function arcAdd(item) {
  const author = item.author || "未知作者";
  await chrome.storage.local.set({ ["dl:" + item.workId]: Date.now() });

  let set = arcMem.get(author);
  if (!set) {
    const k = "arc:" + author;
    const got = await chrome.storage.local.get(k);
    set = new Set(Array.isArray(got[k]) ? got[k] : []);
    arcMem.set(author, set);
  }
  if (set.has(item.workId)) return;
  set.add(item.workId);
  await chrome.storage.local.set({ ["arc:" + author]: [...set] });
  scheduleTxt(author);
}

// ---------- downloaded.txt 兜底写入 ----------
//
// 首选路径：控制台页(app.html) 持有 File System Access 句柄时由它安静写回，下载栏不闪。
// 它每 30s 打一次心跳 kca:fsActive。这里检测到心跳新鲜(<90s)就让路；否则说明控制台页
// 没开 / 没授权 —— 用 chrome.downloads 覆盖写 <前缀>/<作者>/downloaded.txt。会闪一下
// 下载栏，但保证「每个作者文件夹里有一份已下记录」这件事在任何情况下都成立。
//
// txt:<author> 记下最后写盘时的 id 数，SW 重启后只补那些跟 arc: 对不上的作者，避免每次
// 唤醒都重写一遍。bg 只掌握 arc:（storage）这一份集合，syncFromDisk 会把磁盘上的历史
// id 并进 arc:，所以这里 overwrite 不会丢历史——除非用户在扩展之外手动改了 downloaded.txt。

const txtTimers = new Map();

async function fsConsoleActive() {
  try {
    const { "kca:fsActive": ts } = await chrome.storage.local.get("kca:fsActive");
    return typeof ts === "number" && Date.now() - ts < 90_000;
  } catch (_) { return false; }
}

function scheduleTxt(author) {
  clearTimeout(txtTimers.get(author));
  txtTimers.set(author, setTimeout(() => writeTxtViaDownload(author).catch(() => {}), 4000));
}

async function writeTxtViaDownload(author) {
  txtTimers.delete(author);
  if (await fsConsoleActive()) return;             // 控制台页在管，别抢
  const { saveRoot } = await loadSettings();
  const k = "arc:" + author;
  const got = await chrome.storage.local.get(k);
  const ids = Array.isArray(got[k]) ? [...new Set(got[k])] : [];
  if (!ids.length) return;
  const body = ids.sort().map((id) => "kuaishou " + id).join("\n") + "\n";
  const path = joinPath([saveRoot, author]) + "/downloaded.txt";
  try {
    await chrome.downloads.download({
      url: "data:text/plain;charset=utf-8," + encodeURIComponent(body),
      filename: path,
      conflictAction: "overwrite",
      saveAs: false
    });
    await chrome.storage.local.set({ ["txt:" + author]: ids.length });
  } catch (err) {
    console.warn("[快手归档] 写 downloaded.txt(兜底) 失败", author, err);
  }
}

async function reconcileTxtOnBoot() {
  if (await fsConsoleActive()) return;
  let all;
  try { all = await chrome.storage.local.get(null); } catch (_) { return; }
  for (const key of Object.keys(all)) {
    if (!key.startsWith("arc:")) continue;
    const author = key.slice(4);
    const have = Array.isArray(all[key]) ? all[key].length : 0;
    const wrote = all["txt:" + author] || 0;
    if (have && have !== wrote) scheduleTxt(author);
  }
}

// ---------- 队列泵 ----------

async function pump() {
  if (paused) return;
  const { concurrency, betweenMs } = await loadSettings();

  while (!paused && active < concurrency && queue.length) {
    const item = queue.shift();
    active++;
    persist();

    try {
      const downloadId = await chrome.downloads.download({
        url: item.url,
        filename: item.path,
        conflictAction: "uniquify",
        saveAs: false
      });
      inflight.set(downloadId, item);
    } catch (err) {
      active--;
      await onItemFailed(item, String(err && err.message || err));
    }

    // 固定间隔本身就是个机器特征，加点随机抖动
    if (betweenMs) await new Promise((r) => setTimeout(r, betweenMs + Math.random() * 1200));
  }
}

async function onItemDone(item) {
  active = Math.max(0, active - 1);
  // 按 videoId 记「已下载」——与文件是否被移动/改名/删除无关；并排期写 downloaded.txt
  if (item && item.workId) {
    try { await arcAdd(item); } catch (_) {}
  }
  await bumpStats({ done: 1 });
  pump();
}

async function onItemFailed(item, reason) {
  if (item.urls && item.urlIdx + 1 < item.urls.length) {
    // 换下一个直链重试
    item.urlIdx++;
    item.url = item.urls[item.urlIdx];
    item.tries = 0;
    queue.push(item);
    persist();
  } else if (item.tries + 1 < DEFAULTS.maxTries) {
    item.tries++;
    queue.push(item);
    persist();
  } else {
    await bumpStats({ failed: 1 });
    console.warn("[快手归档] 放弃下载", item.path, reason);
  }
  pump();
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const item = inflight.get(delta.id);
  if (!item) return;

  if (delta.state && delta.state.current === "complete") {
    inflight.delete(delta.id);
    await onItemDone(item);
  } else if (delta.state && delta.state.current === "interrupted") {
    inflight.delete(delta.id);
    active = Math.max(0, active - 1);
    await onItemFailed(item, delta.error ? delta.error.current : "interrupted");
  }
});

// ---------- 消息 ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.cmd === "enqueue") {
    (async () => {
      const { saveRoot } = await loadSettings();
      let n = 0;
      for (const w of msg.works || []) {
        const items = expand(w, saveRoot);
        queue.push(...items);
        n += items.length;
      }
      await persist();
      await bumpStats({ enqueued: n });
      pump();
      sendResponse({ ok: true, added: n, queued: queue.length });
    })();
    return true;
  }

  if (msg.cmd === "getState") {
    (async () => {
      const { stats } = await chrome.storage.local.get("stats");
      const settings = await loadSettings();
      sendResponse({
        queued: queue.length,
        active,
        paused,
        stats: stats || { done: 0, failed: 0, enqueued: 0 },
        settings
      });
    })();
    return true;
  }

  if (msg.cmd === "pauseQueue") { paused = true; persist(); sendResponse({ paused }); return; }
  if (msg.cmd === "resumeQueue") { paused = false; persist(); pump(); sendResponse({ paused }); return; }
  if (msg.cmd === "clearQueue") { queue = []; persist(); sendResponse({ queued: 0 }); return; }

  if (msg.cmd === "saveSettings") {
    chrome.storage.local.set({ settings: msg.settings }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------- 续跑 ----------

async function resume() {
  const { queue: q, paused: p } = await chrome.storage.local.get(["queue", "paused"]);
  queue = Array.isArray(q) ? q : [];
  paused = Boolean(p);
  if (queue.length) pump();
  reconcileTxtOnBoot().catch(() => {});
}

chrome.runtime.onStartup.addListener(resume);
chrome.runtime.onInstalled.addListener(resume);
resume();
