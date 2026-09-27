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

// ---------- 持久化队列：一个任务一个键 ----------
//
// 以前整条队列是一个 queue 数组存在同一个键下，1500 条带备用直链的任务就有 21MB，
// 每下完一条就整块重写一遍（节流成 30 条一写也一样），LevelDB 被逼着不停 compaction，
// Chrome 主进程常年 25~50MB/s 写盘。
//
// 现在每个任务单独存成 q:<序号>：
//   入队          写它自己那个键（几百字节）
//   开始下载      把 downloadId 记进它的键里
//   下完/彻底放弃  删它的键
//   失败重试      改写它的键
// 任务在"真正下完"之前一直在盘上——service worker 半路被回收、浏览器崩溃都不丢；
// 重新拉起时靠记下的 downloadId 去问 Chrome 那一条到底下完没有，下完了就直接收尾，
// 不会再下一遍（conflictAction 是 uniquify，重下会多出一个"xxx (1).mp4"）。

const QKEY = "q:";
let qseq = 0;

function qkey(n) {
  return QKEY + String(n).padStart(10, "0");   // 补零让键按字典序 = 入队顺序
}

function saveItem(item) {
  if (item.finished) return Promise.resolve();   // 已经收尾删键的，别再写回去
  return chrome.storage.local.set({ [item.qk]: item })
    .catch((err) => console.warn("[快手归档] 写队列项失败", item.qk, err));
}

function dropItem(item) {
  item.finished = true;
  return chrome.storage.local.remove(item.qk)
    .catch((err) => console.warn("[快手归档] 删队列项失败", item.qk, err));
}

function savePaused() {
  return chrome.storage.local.set({ paused }).catch(() => {});
}

// 旧格式（整条 queue 数组）一次性拆成 q:<序号>。序号按旧数组下标定死，分批写——
// 中途被打断，下次启动重拆一遍写的还是同一批键，覆盖而不是多出一份；全部写完才删旧键。
// 同一个文件在旧队列里出现多次的（旧版任务一出队就从盘上消失、没下完被重新入队）只留第一条。
async function migrateLegacyQueue() {
  const { queue: legacy } = await chrome.storage.local.get("queue");
  if (legacy === undefined) return;
  if (Array.isArray(legacy)) {
    const seen = new Set();
    let patch = {}, n = 0, dup = 0;
    for (let i = 0; i < legacy.length; i++) {
      const it = legacy[i];
      if (!it || !it.url || seen.has(it.path)) { dup++; continue; }
      seen.add(it.path);
      it.id = i + 1;           // 旧 seq 每次 service worker 重启都从 0 数，id 有重复，重新编号
      it.qk = qkey(it.id);
      delete it.dlId;
      patch[it.qk] = it;
      if (++n % 500 === 0) { await chrome.storage.local.set(patch); patch = {}; }
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    console.log("[快手归档] 旧队列已拆分为独立任务", n, "条，去掉重复", dup, "条");
  }
  await chrome.storage.local.remove("queue");
}

// 盘上还挂着 downloadId 的任务：上次下到一半 service worker 没了，完成事件没人接。
// 问 Chrome 那一条现在什么状态，再决定收尾、接着盯、还是重新排队。
async function reconcile(item) {
  let d = null;
  try { [d] = await chrome.downloads.search({ id: item.dlId }); } catch (_) {}
  if (d && d.url !== item.url) d = null;          // downloadId 对不上这条任务（历史被清过等）
  if (d && d.state === "complete") {
    active++;
    await onItemDone(item);
    return;
  }
  if (d && d.state === "in_progress") {
    active++;
    inflight.set(d.id, item);
    return;
  }
  delete item.dlId;                               // 被中断/找不到：当成还没下，重新排队
  queue.push(item);
  await saveItem(item);
}

async function loadQueue() {
  await migrateLegacyQueue();
  const allKeys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()                       // Chrome 130+，只取键名
    : Object.keys(await chrome.storage.local.get(null));
  const keys = allKeys.filter((k) => k.startsWith(QKEY)).sort();
  const got = keys.length ? await chrome.storage.local.get(keys) : {};
  const { paused: p } = await chrome.storage.local.get("paused");
  paused = Boolean(p);
  const pending = [];
  for (const k of keys) {
    const item = got[k];
    if (!item || typeof item !== "object") continue;
    item.qk = k;
    qseq = Math.max(qseq, Number(k.slice(QKEY.length)) || 0);
    if (item.dlId != null) pending.push(item);
    else queue.push(item);
  }
  for (const item of pending) await reconcile(item);
  console.log("[快手归档] 队列已载入", queue.length, "排队 /", active, "下载中");
}

// 所有读写队列的入口都先等它：消息、下载事件可能比载入先到
const ready = loadQueue().catch((err) => console.warn("[快手归档] 载入队列失败", err));

let statsMem = null;
let statsSaveTimer = null;

async function bumpStats(patch) {
  if (!statsMem) {
    const { stats } = await chrome.storage.local.get("stats");
    statsMem = Object.assign({ done: 0, failed: 0, enqueued: 0 }, stats || {});
  }
  for (const k of Object.keys(patch)) statsMem[k] = (statsMem[k] || 0) + patch[k];
  broadcast({ cmd: "stats", stats: statsMem, queued: queue.length, active });

  if (!statsSaveTimer) {
    statsSaveTimer = setTimeout(async () => {
      statsSaveTimer = null;
      if (statsMem) {
        try { await chrome.storage.local.set({ stats: statsMem }); } catch (_) {}
      }
    }, 3000);
  }
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
  let set = arcMem.get(author);
  if (!set) {
    const k = "arc:" + author;
    const got = await chrome.storage.local.get(k);
    set = new Set(Array.isArray(got[k]) ? got[k] : []);
    arcMem.set(author, set);
  }
  const isNew = !set.has(item.workId);
  if (isNew) {
    set.add(item.workId);
  }
  const patch = { ["dl:" + item.workId]: Date.now() };
  if (isNew) {
    patch["arc:" + author] = [...set];
  }
  await chrome.storage.local.set(patch);
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
  await ready;
  if (paused) return;
  const { concurrency, betweenMs } = await loadSettings();

  while (!paused && active < concurrency && queue.length) {
    const item = queue.shift();
    active++;

    try {
      const downloadId = await chrome.downloads.download({
        url: item.url,
        filename: item.path,
        conflictAction: "uniquify",
        saveAs: false
      });
      inflight.set(downloadId, item);
      item.dlId = downloadId;
      saveItem(item);   // 键还留着，只记下 downloadId；下完才删
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
  // 先记 dl:（去重依据）再删队列键：两步之间被打断，最坏是任务还在队列里，
  // 下次启动 reconcile 查到已完成、再收尾一次——不会漏记"已下载"
  if (item && item.workId) {
    try { await arcAdd(item); } catch (_) {}
  }
  await dropItem(item);
  await bumpStats({ done: 1 });
  pump();
}

async function onItemFailed(item, reason) {
  delete item.dlId;
  if (item.urls && item.urlIdx + 1 < item.urls.length) {
    item.urlIdx++;
    item.url = item.urls[item.urlIdx];
    item.tries = 0;
    queue.push(item);
    await saveItem(item);
  } else if (item.tries + 1 < DEFAULTS.maxTries) {
    item.tries++;
    queue.push(item);
    await saveItem(item);
  } else {
    await dropItem(item);
    await bumpStats({ failed: 1 });
    console.warn("[快手归档] 放弃下载", item.path, reason);
  }
  pump();
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  await ready;
  const item = inflight.get(delta.id);
  if (!item) return;

  if (delta.state.current === "complete") {
    inflight.delete(delta.id);
    await onItemDone(item);
  } else if (delta.state.current === "interrupted") {
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
      await ready;
      const { saveRoot } = await loadSettings();
      // 同一个文件已经在排队或正在下（连点两次「下载全部」、两个标签页各点一次），
      // 不再重复入队，否则 uniquify 会存出 "xxx (1).mp4"
      const taken = new Set(queue.map((it) => it.path));
      for (const it of inflight.values()) taken.add(it.path);
      const patch = {};
      let n = 0, dup = 0;
      for (const w of msg.works || []) {
        for (const item of expand(w, saveRoot)) {
          if (taken.has(item.path)) { dup++; continue; }
          taken.add(item.path);
          item.id = ++qseq;
          item.qk = qkey(item.id);
          patch[item.qk] = item;
          queue.push(item);
          n++;
        }
      }
      if (n) await chrome.storage.local.set(patch);
      await bumpStats({ enqueued: n });
      pump();
      sendResponse({ ok: true, added: n, skipped: dup, queued: queue.length });
    })();
    return true;
  }

  if (msg.cmd === "getState") {
    (async () => {
      await ready;
      if (!statsMem) {
        const { stats } = await chrome.storage.local.get("stats");
        statsMem = Object.assign({ done: 0, failed: 0, enqueued: 0 }, stats || {});
      }
      const settings = await loadSettings();
      sendResponse({
        queued: queue.length,
        active,
        paused,
        stats: statsMem,
        settings
      });
    })();
    return true;
  }

  if (msg.cmd === "pauseQueue") { paused = true; savePaused(); sendResponse({ paused }); return; }
  if (msg.cmd === "resumeQueue") { paused = false; savePaused(); pump(); sendResponse({ paused }); return; }
  if (msg.cmd === "clearQueue") {
    (async () => {
      await ready;
      const dropped = queue;
      queue = [];
      dropped.forEach((it) => { it.finished = true; });
      if (dropped.length) await chrome.storage.local.remove(dropped.map((it) => it.qk)).catch(() => {});
      sendResponse({ queued: 0 });
    })();
    return true;
  }

  if (msg.cmd === "saveSettings") {
    chrome.storage.local.set({ settings: msg.settings }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------- 续跑 ----------
//
// 顶层的 loadQueue()（上面的 ready）在 service worker 每次被拉起时都会跑一次，
// 浏览器启动/插件安装更新也是靠它，不用再挂 onStartup/onInstalled（以前三处都调
// resume，一次启动会并发载入三遍）。

ready.then(() => {
  if (queue.length) pump();
  reconcileTxtOnBoot().catch(() => {});
});
