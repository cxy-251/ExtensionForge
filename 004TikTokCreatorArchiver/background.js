/*
 * 后台 service worker：下载队列。跟 002（快手）/003（抖音）同一套逻辑，v1 没有批量
 * 列表/连续模式/控制台页，downloaded.txt 直接无条件走 chrome.downloads 写。
 *
 * content.js 把「作品」结构丢过来，这里展开成一个个下载项，按并发上限交给
 * chrome.downloads，失败重试一次，进度写入 chrome.storage 供 popup 展示。
 */
"use strict";

const DEFAULTS = Object.freeze({
  saveRoot: "TikTok",
  concurrency: 2,
  betweenMs: 1500,
  maxTries: 2
});

let queue = [];
let paused = false;
let active = 0;
const inflight = new Map();

// ---------- CDN 直链要带上真实登录态 Cookie 才给下载 ----------
//
// 参考 dyd（别人已经做出来能用的桌面版下载器）的 tk.js：它下载视频时手动带上了页面
// 自己请求时用的 Cookie + Referer 两个头。之前以为视频直链走的是 tiktokcdn.com 这类
// 独立 CDN 域名，结果拿到真实回包样本一看，根本不是——TikTok 网页版的视频直链
// （bitrateInfo[].PlayAddr.UrlList / video.playAddr / video.downloadAddr）实际挂在
// v16-webapp-prime.tiktok.com / v19-webapp-prime.tiktok.com / www.tiktok.com（走
// /aweme/v1/play/ 这条兜底）这些 tiktok.com 自己的子域名下，压根不在 tiktokcdn.com
// 这类域名里！下载请求发出去时因为没匹配上任何一条规则，一个 Cookie 都没带，TikTok
// 服务器认出这是没登录态的请求，直接返回一个验证/拦截页面（html），Chrome 下载管理器
// 存下来的自然是个 .html 文件——这才是"采集到的视频全变成 html"的真正原因，跟接口
// 字段选没选对完全无关。
//
// chrome.downloads.download() 本身不支持自定义请求头，只能用 declarativeNetRequest
// 的动态规则（session rules）在网络层把 Cookie 塞进去：定期读一遍浏览器里 tiktok.com
// 域名下的真实 Cookie，拼成请求头，写成规则。
//
// tiktok.com 这个域名单独开一条规则、且 resourceTypes 里特意不含 xmlhttprequest——
// 这个域名同时也是页面自己发 /api/post/item_list 这些接口请求的域名，inject.js 靠
// 被动旁路读取这些请求本来就工作正常，不该去动它们（哪怕塞的是同一份 Cookie，理论上
// 应该等价，但没必要冒不必要的风险）；只让这条规则去管 media/other 这两类（下载请求
// 走这两类），CDN_DOMAINS 那几个域名本来就只会是媒体资源，不会跟页面自身接口请求撞上，
// 继续沿用完整的 resourceTypes 列表。
const CDN_DOMAINS = [
  "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com",
  "tiktokv.com", "tiktokv.us", "muscdn.com", "ibyteimg.com", "byteoversea.com"
];
const CDN_COOKIE_RULE_ID = 9001;
const TIKTOK_DOMAIN_COOKIE_RULE_ID = 9002;

async function refreshCdnCookieRule() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "tiktok.com" });
    if (!cookies || !cookies.length) return;
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [CDN_COOKIE_RULE_ID, TIKTOK_DOMAIN_COOKIE_RULE_ID],
      addRules: [
        {
          id: CDN_COOKIE_RULE_ID,
          priority: 2,   // 比 rules.json 里那条静态 referer/origin 规则（priority 1）优先级高
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "cookie", operation: "set", value: cookieHeader },
              { header: "referer", operation: "set", value: "https://www.tiktok.com/" },
              { header: "origin", operation: "set", value: "https://www.tiktok.com" }
            ]
          },
          condition: {
            requestDomains: CDN_DOMAINS,
            resourceTypes: ["xmlhttprequest", "media", "other"]
          }
        },
        {
          id: TIKTOK_DOMAIN_COOKIE_RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "cookie", operation: "set", value: cookieHeader },
              { header: "referer", operation: "set", value: "https://www.tiktok.com/" },
              { header: "origin", operation: "set", value: "https://www.tiktok.com" }
            ]
          },
          condition: {
            requestDomains: ["tiktok.com"],
            resourceTypes: ["media", "other"]
          }
        }
      ]
    });
  } catch (e) {
    console.warn("[TikTok归档] 刷新 CDN Cookie 规则失败", e);
  }
}

// pump() 每次真下载前都会等一次这个刷新完成——万一它意外卡住（并发重复调用、Chrome
// 内部处理慢），下载队列就会卡死在"排队中、永远不开始"（抖音那边真实遇到过一次）。
// 这里加一层去重（同一时间只真正跑一次，其它调用方等同一个 promise）+ 一个超时保险
// （最多等 3 秒，超时就不等了，Cookie 刷新继续在后台跑，不耽误先把下载跑起来）。
let cookieRefreshInFlight = null;
function refreshCdnCookieRuleGuarded() {
  if (!cookieRefreshInFlight) {
    cookieRefreshInFlight = refreshCdnCookieRule().finally(() => { cookieRefreshInFlight = null; });
  }
  return Promise.race([cookieRefreshInFlight, new Promise((r) => setTimeout(r, 3000))]);
}

// Cookie 可能会轮换/过期，定期刷新——这里必须用 chrome.alarms，不能用 setInterval。
// MV3 的 service worker 闲置一段时间就会被系统直接杀掉（不是暂停，是真的没了），
// setInterval 这种定时器扛不住这件事，一旦被杀就彻底失效，只有等下次有事件（收到消息、
// 下载状态变化……）才会重新拉起这个脚本、从头跑一遍——之前只在插件刚加载那一刻刷新过
// 一次 Cookie 规则，之后大概率就再没真正刷新过，导致会话 Cookie 过期后下载被拒；重启
// 浏览器等于把这个后台脚本重新拉起了一次，刚好又刷新了一次新鲜 Cookie，新任务才能下
// 载成功——这就是"重启后新任务能下、之前的不能下"的真正原因。chrome.alarms 是 Chrome
// 专门给这种场景设计的：即使 service worker 被杀了，闹钟时间到了也会把它重新唤醒。
refreshCdnCookieRule();
chrome.alarms.create("refreshCdnCookie", { periodInMinutes: 4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshCdnCookie") refreshCdnCookieRule();
});
if (chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((info) => {
    if (info.cookie && /tiktok\.com$/.test(info.cookie.domain || "")) refreshCdnCookieRule();
  });
}

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
    .catch((err) => console.warn("[TikTok归档] 写队列项失败", item.qk, err));
}

function dropItem(item) {
  item.finished = true;
  return chrome.storage.local.remove(item.qk)
    .catch((err) => console.warn("[TikTok归档] 删队列项失败", item.qk, err));
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
    console.log("[TikTok归档] 旧队列已拆分为独立任务", n, "条，去掉重复", dup, "条");
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
  console.log("[TikTok归档] 队列已载入", queue.length, "排队 /", active, "下载中");
}

// 所有读写队列的入口都先等它：消息、下载事件可能比载入先到
const ready = loadQueue().catch((err) => console.warn("[TikTok归档] 载入队列失败", err));

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
  // 同一句文案发好几条、同一天发好几条都很常见——videoId 编进文件名，从根上防撞名
  const stem = work.title
    ? [work.dateStr, work.title, work.videoId].filter(Boolean).join("_")
    : [work.dateStr, work.videoId].filter(Boolean).join("_");
  const authorDir = joinPath([root, author]);
  const meta = { workId: work.videoId, author, authorDir, title: work.title || "", dateStr: work.dateStr || "" };

  const vurls = (work.videoUrls && work.videoUrls.length ? work.videoUrls : (work.videoUrl ? [work.videoUrl] : []))
    .filter(Boolean);
  // 只有真的没有图片时才当视频下（有图片一律走下面的图集分支，防止 TikTok 图集作品
  // 里那个兼容视频/音轨字段被误当成视频下载——003 上线后才踩过这个坑，这里直接照做）
  if (work.kind === "video" && vurls.length) {
    items.push({
      url: vurls[0],
      urls: vurls,
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
// dl:<videoId>   chrome.storage —— 去重依据
// arc:<author>   chrome.storage —— 该作者已下的 videoId 数组
// v1 没有控制台页/FSA，downloaded.txt 统一走 chrome.downloads 直接写（会闪一下下载栏）

const arcMem = new Map();
// downloaded.txt 原来是 setTimeout 防抖 4 秒后写——这 4 秒空窗期 service worker 完全
// 可能被系统直接杀掉（跟前面 Cookie 刷新踩过的坑是同一类问题），回调就没了，文件永远
// 写不出来。改成不用计时器之后又踩了另一个坑：改成"每成功一条就立刻写"，一批视频
// 连续下完，downloaded.txt 就跟着被反复写、chrome://downloads 里刷一串重复下载提示
// （抖音那边真实遇到过）。现在改成靠真实事件（不是计时器）攒批：攒够 5 条，或者这
// 一批任务已经跑完（队列空、没有在跑的），才真正写一次。
const txtWriting = new Set();
const txtDirty = new Set();
const txtPending = new Map();   // author -> 距离上次真正写入，已经攒了几条成功记录

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

  const n = (txtPending.get(author) || 0) + 1;
  const drained = queue.length === 0 && active === 0;   // 这一批任务跑完了，最后兜底写一次
  if (n >= 5 || drained) {
    txtPending.set(author, 0);
    scheduleTxt(author);
  } else {
    txtPending.set(author, n);
  }
}

async function scheduleTxt(author) {
  if (txtWriting.has(author)) { txtDirty.add(author); return; }
  txtWriting.add(author);
  try { await writeTxtViaDownload(author); } catch (_) {}
  txtWriting.delete(author);
  if (txtDirty.has(author)) { txtDirty.delete(author); scheduleTxt(author); }
}

async function writeTxtViaDownload(author) {
  const { saveRoot } = await loadSettings();
  const k = "arc:" + author;
  const got = await chrome.storage.local.get(k);
  const ids = Array.isArray(got[k]) ? [...new Set(got[k])] : [];
  if (!ids.length) return;
  const body = ids.sort().map((id) => "tiktok " + id).join("\n") + "\n";
  const path = joinPath([saveRoot, author]) + "/downloaded.txt";
  try {
    await chrome.downloads.download({
      url: "data:text/plain;charset=utf-8," + encodeURIComponent(body),
      filename: path,
      conflictAction: "overwrite",
      saveAs: false
    });
  } catch (err) {
    console.warn("[TikTok归档] 写 downloaded.txt 失败", author, err);
  }
}

// ---------- 队列泵 ----------

async function pump() {
  await ready;
  if (paused) return;
  await refreshCdnCookieRuleGuarded();   // 真要下载了，先确保 CDN 头规则是最新的登录态 Cookie（带超时保险）
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
    console.warn("[TikTok归档] 放弃下载", item.path, reason);
  }
  pump();
}

// ---------- 清理下载记录 ----------
//
// chrome.downloads 每下一个文件就在 Chrome 下载历史里留一条记录，Chrome 自己从不清。
// 归档动辄几万个文件，记录攒到二十多万条时 History 库两百多 MB，Chrome 启动要把它们
// 全读进内存、下载列表每次变动也要过一遍——冷启动卡、平时卡、内存高。
// 这里只删「记录」（erase 不碰盘上文件），而且不是下一个删一个：结束的下载攒够
// ERASE_EVERY 个、或队列跑空时扫一遍，只挑本扩展发起的、已结束的、不在 inflight 里的
// （还没收尾的留给 reconcile 查）。浏览器启动 / 扩展安装重载时再扫一遍，兜住 service
// worker 中途被回收时没来得及清的——第一次重载扩展也就顺手把旧的存量清掉了。
const ERASE_EVERY = 200;
const SWEEP_PAGE = 500;
let endedSinceSweep = 0;
let sweeping = null;
let sweepAgain = false;
let sweepTimer = null;

function noteDownloadEnded() {
  if (++endedSinceSweep >= ERASE_EVERY) sweepRecords();
}

function sweepSoon() {
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(sweepRecords, 10_000);
}

function sweepRecords() {
  if (sweeping) { sweepAgain = true; return sweeping; }
  endedSinceSweep = 0;
  sweeping = (async () => {
    await ready;
    let erased = 0, cursor = null;
    for (;;) {
      // 按开始时间分页往后翻，一次只拿一页，存量二十万条时也不会一口气把全部记录搬过来
      const q = { orderBy: ["startTime"], limit: SWEEP_PAGE };
      if (cursor) q.startedAfter = cursor;
      let page;
      try { page = await chrome.downloads.search(q); } catch (_) { break; }
      const mine = page.filter((d) => d.byExtensionId === chrome.runtime.id &&
        d.state !== "in_progress" && !inflight.has(d.id));
      await Promise.all(mine.map((d) => chrome.downloads.erase({ id: d.id }).catch(() => {})));
      erased += mine.length;
      if (page.length < SWEEP_PAGE) break;
      cursor = page[page.length - 1].startTime;
    }
    if (erased) console.log("[TikTok归档] 已清理下载记录", erased, "条");
  })().finally(() => {
    sweeping = null;
    if (sweepAgain) { sweepAgain = false; sweepRecords(); }
  });
  return sweeping;
}

chrome.runtime.onStartup.addListener(() => { sweepRecords(); });
chrome.runtime.onInstalled.addListener(() => { sweepRecords(); });

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  await ready;
  if (delta.state.current !== "in_progress") noteDownloadEnded();
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
  if (!queue.length && !active) sweepSoon();       // 这一批跑空了，等最后的 downloaded.txt 写完再清
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

ready.then(() => { if (queue.length) pump(); });
