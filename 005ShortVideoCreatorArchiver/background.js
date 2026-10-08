/*
 * 后台 service worker：三个平台共用的一条下载队列。
 *
 * 逻辑整体照搬 003（抖音）那份——一个任务一个 q:<序号> 键、downloadId 落盘续跑、
 * 失败换候选直链、downloaded.txt 攒批写、分批清理下载记录——区别只在于：
 *   - 每个任务带 platform 字段，保存目录 / downloaded.txt 前缀 / 去重键都按平台分开；
 *   - 登录态 Cookie 规则按平台各管各的，Rule ID 分段（快手 1xxx、抖音 2xxx、TikTok 3xxx、小红书 4xxx），
 *     requestDomains 严格限制在本平台域名内，不会把一家的 Cookie 带去另一家；
 *   - 每个平台各一条下载通道（PER_PLATFORM），不同平台同时下、互不排队；
 *   - 暂停、清空都按平台：暂停抖音不影响小红书接着下。
 *
 * 存储键：
 *   q:<序号>                    下载任务
 *   dl:<platform>:<videoId>     去重依据
 *   arc:<platform>:<author>     该作者已下的 videoId 数组（写 downloaded.txt 用）
 *   fail:<platform>:<videoId>   失败清单：这个作品里所有候选直链都试完还没下成功的文件（带直链，可重试）
 *   pausedBy / stats            pausedBy: { 平台: true } 暂停了出队的平台
 */
"use strict";

const PLATFORMS = Object.freeze({
  kuaishou: {
    label: "快手",
    saveRoot: "快手",
    archivePrefix: "kuaishou",
    origin: "https://www.kuaishou.com",
    // 002 一直没带 Cookie 也下得动，这里保持原样不加；要加就填 "kuaishou.com"
    cookieDomain: null,
    cdnDomains: ["kwaicdn.com", "yximgs.com", "kwimgs.com", "ndcimgs.com", "oskwai.com", "djvod.com"],
    selfDomain: null,
    ruleBase: 1000
  },
  douyin: {
    label: "抖音",
    saveRoot: "抖音",
    archivePrefix: "douyin",
    origin: "https://www.douyin.com",
    cookieDomain: "douyin.com",
    cdnDomains: ["douyinvod.com", "zjcdn.com", "douyinpic.com", "iesdouyin.com", "snssdk.com"],
    selfDomain: "douyin.com",
    ruleBase: 2000
  },
  tiktok: {
    label: "TikTok",
    saveRoot: "TikTok",
    archivePrefix: "tiktok",
    origin: "https://www.tiktok.com",
    cookieDomain: "tiktok.com",
    cdnDomains: [
      "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com",
      "tiktokv.com", "tiktokv.us", "muscdn.com", "ibyteimg.com", "byteoversea.com"
    ],
    selfDomain: "tiktok.com",
    ruleBase: 3000
  },
  xiaohongshu: {
    label: "小红书",
    saveRoot: "小红书",
    archivePrefix: "xiaohongshu",
    origin: "https://www.xiaohongshu.com",
    // 原图 sns-img-bd、视频 sns-video/sns-bak 实测不带 Cookie 也能取，只补 Referer
    cookieDomain: null,
    cdnDomains: ["xhscdn.com"],
    selfDomain: null,
    ruleBase: 4000
  }
});

// 每个平台各一条下载通道：抖音、TikTok、小红书……可以同时各下一个，互不排队；同一平台内按入队先后下
const PER_PLATFORM = 1;
const BETWEEN_MS = 1500;   // 每条起始间隔，pump() 里还会再加随机抖动
const MAX_TRIES = 2;

const LOG_TAG = "[短视频归档]";

let queue = [];
let pausedBy = {};              // 平台 -> true：这个平台暂停出队（正在下的照常下完）
const isPaused = (p) => !!pausedBy[p];
let active = 0;                 // 全部平台正在下载的数
const activeBy = {};            // 平台 -> 正在下载的数
const inflight = new Map();

// ---------- CDN 直链带上登录态 Cookie ----------
//
// 来历见 docs/踩坑记录.md「二、下载」：一部分直链（尤其挂在 douyin.com / tiktok.com 主域名下的
// /aweme/v1/play/ 兜底地址）不带真实登录态 Cookie 会被拦，Chrome 把拦截页存成 .html。
// chrome.downloads 不能自定义请求头，只能用 declarativeNetRequest 的 session 规则塞进去。
// 主域名那条规则不含 xmlhttprequest，不碰页面自己发的接口请求。

function cookieRuleIds(p) {
  return [p.ruleBase + 901, p.ruleBase + 902];
}

async function refreshCookieRule(key) {
  const p = PLATFORMS[key];
  if (!p || !p.cookieDomain) return;
  try {
    const cookies = await chrome.cookies.getAll({ domain: p.cookieDomain });
    if (!cookies || !cookies.length) return;
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = [
      { header: "cookie", operation: "set", value: cookieHeader },
      { header: "referer", operation: "set", value: p.origin + "/" },
      { header: "origin", operation: "set", value: p.origin }
    ];
    const [cdnId, selfId] = cookieRuleIds(p);
    const addRules = [{
      id: cdnId,
      priority: 2,   // 高于 rules.json 里只有 referer/origin 的静态规则（priority 1）
      action: { type: "modifyHeaders", requestHeaders: headers },
      condition: { requestDomains: p.cdnDomains, resourceTypes: ["xmlhttprequest", "media", "other"] }
    }];
    if (p.selfDomain) {
      addRules.push({
        id: selfId,
        priority: 2,
        action: { type: "modifyHeaders", requestHeaders: headers },
        condition: { requestDomains: [p.selfDomain], resourceTypes: ["media", "other"] }
      });
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [cdnId, selfId], addRules });
  } catch (e) {
    console.warn(LOG_TAG, "刷新", p.label, "Cookie 规则失败", e);
  }
}

function refreshAllCookieRules() {
  return Promise.all(Object.keys(PLATFORMS).map(refreshCookieRule));
}

// 去重 + 3 秒超时保险：刷新万一卡住，不能把下载队列一起卡死在"排队中"
let cookieRefreshInFlight = null;
function refreshAllCookieRulesGuarded() {
  if (!cookieRefreshInFlight) {
    cookieRefreshInFlight = refreshAllCookieRules().finally(() => { cookieRefreshInFlight = null; });
  }
  return Promise.race([cookieRefreshInFlight, new Promise((r) => setTimeout(r, 3000))]);
}

// 必须用 chrome.alarms，不能用 setInterval：service worker 闲置会被系统杀掉
refreshAllCookieRules();
chrome.alarms.create("refreshCdnCookie", { periodInMinutes: 4 });
chrome.alarms.create("watchdog", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshCdnCookie") refreshAllCookieRules();
  else if (alarm.name === "watchdog") watchdog().catch((e) => console.warn(LOG_TAG, "看门狗出错", e));
});

// 这几个站点的埋点 Cookie 变得很勤，按平台合并一下，2 秒内只刷一次
const cookieChangeTimers = new Map();
if (chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((info) => {
    const domain = (info.cookie && info.cookie.domain) || "";
    for (const [key, p] of Object.entries(PLATFORMS)) {
      if (!p.cookieDomain || !domain.endsWith(p.cookieDomain)) continue;
      if (cookieChangeTimers.has(key)) continue;
      cookieChangeTimers.set(key, setTimeout(() => {
        cookieChangeTimers.delete(key);
        refreshCookieRule(key);
      }, 2000));
    }
  });
}

// ---------- 持久化队列：一个任务一个键 ----------
//
// 不要把整条队列存成一个数组（002/003 踩过：1500 条任务 21MB，每下一条重写一遍，
// Chrome 常年 25~50MB/s 写盘）。任务在真正下完之前一直在盘上，SW 被回收也不丢；
// 重新拉起时靠记下的 downloadId 问 Chrome 那一条下完没有。

const QKEY = "q:";
let qseq = 0;

function qkey(n) {
  return QKEY + String(n).padStart(10, "0");   // 补零让键按字典序 = 入队顺序
}

function saveItem(item) {
  if (item.finished) return Promise.resolve();
  return chrome.storage.local.set({ [item.qk]: item })
    .catch((err) => console.warn(LOG_TAG, "写队列项失败", item.qk, err));
}

function dropItem(item) {
  item.finished = true;
  return chrome.storage.local.remove(item.qk)
    .catch((err) => console.warn(LOG_TAG, "删队列项失败", item.qk, err));
}

function savePaused() {
  return chrome.storage.local.set({ pausedBy }).catch(() => {});
}

function takeSlot(item) {
  active++;
  activeBy[item.platform] = (activeBy[item.platform] || 0) + 1;
}

function freeSlot(item) {
  active = Math.max(0, active - 1);
  activeBy[item.platform] = Math.max(0, (activeBy[item.platform] || 0) - 1);
}

async function reconcile(item) {
  let d = null;
  try { [d] = await chrome.downloads.search({ id: item.dlId }); } catch (_) {}
  if (d && d.url !== item.url) d = null;
  if (d && d.state === "complete") {
    takeSlot(item);
    await onItemDone(item);
    return;
  }
  if (d && d.state === "in_progress") {
    takeSlot(item);
    inflight.set(d.id, item);
    return;
  }
  delete item.dlId;
  queue.push(item);
  await saveItem(item);
}

async function loadQueue() {
  const allKeys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const keys = allKeys.filter((k) => k.startsWith(QKEY)).sort();
  const got = keys.length ? await chrome.storage.local.get(keys) : {};
  const { pausedBy: pb, paused: legacy } = await chrome.storage.local.get(["pausedBy", "paused"]);
  pausedBy = Object.assign({}, pb);
  // 旧版本只有一个全局 paused：当时暂停着的，升级后所有平台都保持暂停
  if (legacy !== undefined) {
    if (legacy && !pb) for (const k of Object.keys(PLATFORMS)) pausedBy[k] = true;
    await chrome.storage.local.remove("paused");
    await savePaused();
  }
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
  console.log(LOG_TAG, "队列已载入", queue.length, "排队 /", active, "下载中");
}

const ready = loadQueue().catch((err) => console.warn(LOG_TAG, "载入队列失败", err));

// ---------- 统计 ----------

let statsMem = null;
let statsSaveTimer = null;

// 总数 + 按平台分开的数（stats.platforms.<平台>.done/failed/enqueued），面板只看本平台的
async function ensureStats() {
  if (!statsMem) {
    const { stats } = await chrome.storage.local.get("stats");
    statsMem = Object.assign({ done: 0, failed: 0, enqueued: 0 }, stats || {});
    statsMem.platforms = Object.assign({}, statsMem.platforms);
  }
  return statsMem;
}

async function bumpStats(patch, platform) {
  await ensureStats();
  const mine = platform ? (statsMem.platforms[platform] = statsMem.platforms[platform] || {}) : null;
  for (const k of Object.keys(patch)) {
    statsMem[k] = (statsMem[k] || 0) + patch[k];
    if (mine) mine[k] = (mine[k] || 0) + patch[k];
  }
  if (!statsSaveTimer) {
    statsSaveTimer = setTimeout(async () => {
      statsSaveTimer = null;
      if (statsMem) {
        try { await chrome.storage.local.set({ stats: statsMem }); } catch (_) {}
      }
    }, 3000);
  }
}

function countByPlatform() {
  const out = {};
  const done = (statsMem && statsMem.platforms) || {};
  for (const k of Object.keys(PLATFORMS)) {
    out[k] = { queued: 0, active: 0, done: (done[k] && done[k].done) || 0, failed: (done[k] && done[k].failed) || 0 };
  }
  for (const it of queue) if (out[it.platform]) out[it.platform].queued++;
  for (const it of inflight.values()) if (out[it.platform]) out[it.platform].active++;
  return out;
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
  // 同一句文案、同一天发好几条都很常见——videoId 编进文件名，从根上防撞名
  const stem = work.title
    ? [work.dateStr, work.title, work.videoId].filter(Boolean).join("_")
    : [work.dateStr, work.videoId].filter(Boolean).join("_");
  const authorDir = joinPath([root, author]);
  const meta = {
    platform: work.platform, workId: work.videoId, author, authorDir,
    title: work.title || "", dateStr: work.dateStr || "", pageUrl: work.pageUrl || ""
  };

  const vurls = (work.videoUrls && work.videoUrls.length ? work.videoUrls : (work.videoUrl ? [work.videoUrl] : []))
    .filter(Boolean);
  if (work.kind === "video" && vurls.length) {
    items.push({
      url: vurls[0], urls: vurls, urlIdx: 0,
      path: authorDir + "/" + safeSeg(stem) + ".mp4",
      kind: "video", tries: 0, ...meta
    });
  }

  // 每张图可以是一个地址，也可以是一组候选（小红书：原图在前，压缩图兜底），失败换下一个。
  // 扩展名先写 .jpg，真正下载时按实际类型改（见 onDeterminingFilename）
  if (work.imageUrls && work.imageUrls.length) {
    const folder = joinPath([root, author, stem || work.videoId]);
    work.imageUrls.forEach((url, i) => {
      const urls = (Array.isArray(url) ? url : [url]).filter(Boolean);
      if (!urls.length) return;
      items.push({
        url: urls[0], urls, urlIdx: 0,
        path: folder + "/" + String(i + 1).padStart(2, "0") + ".jpg",
        kind: "image", tries: 0, ...meta
      });
    });
  }

  return items;
}

// ---------- 已下载归档 + downloaded.txt ----------
//
// downloaded.txt 不能每下一条就写（下载栏刷一串提示），也不能用计时器防抖（SW 被杀就
// 永远写不出来）。靠真实事件攒批：同一作者攒够 5 条，或者整条队列跑空，才真正写一次。

const arcMem = new Map();      // "<platform>:<author>" -> Set<videoId>
const txtWriting = new Set();
const txtDirty = new Set();
const txtPending = new Map();

function arcKey(platform, author) {
  return "arc:" + platform + ":" + author;
}

async function arcAdd(item) {
  const platform = item.platform;
  const author = item.author || "未知作者";
  const k = arcKey(platform, author);
  let set = arcMem.get(k);
  if (!set) {
    const got = await chrome.storage.local.get(k);
    set = new Set(Array.isArray(got[k]) ? got[k] : []);
    arcMem.set(k, set);
  }
  const isNew = !set.has(item.workId);
  if (isNew) set.add(item.workId);
  const patch = { ["dl:" + platform + ":" + item.workId]: Date.now() };
  if (isNew) patch[k] = [...set];
  await chrome.storage.local.set(patch);

  const n = (txtPending.get(k) || 0) + 1;
  const drained = queue.length === 0 && active === 0;
  if (n >= 5 || drained) {
    txtPending.set(k, 0);
    scheduleTxt(platform, author);
  } else {
    txtPending.set(k, n);
  }
}

// 队列跑空的那一刻，把所有还攒着没写的作者都补写一遍（不然最后不满 5 条的作者会漏）
function flushPendingTxt() {
  for (const [k, n] of txtPending) {
    if (!n) continue;
    txtPending.set(k, 0);
    const rest = k.slice(4);                    // 去掉 "arc:"
    const i = rest.indexOf(":");
    scheduleTxt(rest.slice(0, i), rest.slice(i + 1));
  }
}

async function scheduleTxt(platform, author) {
  const k = arcKey(platform, author);
  if (txtWriting.has(k)) { txtDirty.add(k); return; }
  txtWriting.add(k);
  try { await writeTxtViaDownload(platform, author); } catch (_) {}
  txtWriting.delete(k);
  if (txtDirty.has(k)) { txtDirty.delete(k); scheduleTxt(platform, author); }
}

async function writeTxtViaDownload(platform, author) {
  const p = PLATFORMS[platform];
  if (!p) return;
  const k = arcKey(platform, author);
  const got = await chrome.storage.local.get(k);
  const ids = Array.isArray(got[k]) ? [...new Set(got[k])] : [];
  if (!ids.length) return;
  const body = ids.sort().map((id) => p.archivePrefix + " " + id).join("\n") + "\n";
  const path = joinPath([p.saveRoot, author]) + "/downloaded.txt";
  try {
    await startDownload("data:text/plain;charset=utf-8," + encodeURIComponent(body), path, "overwrite");
  } catch (err) {
    console.warn(LOG_TAG, "写 downloaded.txt 失败", platform, author, err);
  }
}

// ---------- 失败清单 ----------
//
// 按「文件」记，不按作品记：图集里只要有一张下成功，作品就记进 dl:（「下载全部」以后会跳过它），
// 没下成功的那几张只能靠这里补。同一个文件以后下成功了（重试或重新采集）就从清单里删掉。

const FKEY = "fail:";
const failKey = (item) => FKEY + item.platform + ":" + item.workId;

async function recordFailure(item, reason) {
  if (!item.workId) return;
  const k = failKey(item);
  const got = await chrome.storage.local.get(k);
  const rec = got[k] || {
    platform: item.platform, workId: item.workId, author: item.author, title: item.title,
    dateStr: item.dateStr || "", pageUrl: item.pageUrl || "", files: []
  };
  rec.at = Date.now();
  const f = { path: item.path, kind: item.kind, urls: item.urls || [item.url], reason: String(reason || "").slice(0, 80) };
  const i = rec.files.findIndex((x) => x.path === f.path);
  if (i >= 0) rec.files[i] = f; else rec.files.push(f);
  await chrome.storage.local.set({ [k]: rec });
}

async function clearFailure(item) {
  if (!item.workId) return;
  const k = failKey(item);
  const got = await chrome.storage.local.get(k);
  const rec = got[k];
  if (!rec) return;
  rec.files = rec.files.filter((x) => x.path !== item.path);
  if (rec.files.length) await chrome.storage.local.set({ [k]: rec });
  else await chrome.storage.local.remove(k);
}

async function listFailures() {
  const keys = (chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null))).filter((k) => k.startsWith(FKEY));
  const got = keys.length ? await chrome.storage.local.get(keys) : {};
  return Object.values(got).filter((r) => r && r.files && r.files.length).sort((a, b) => b.at - a.at);
}

// 用当时记下的直链重新入队（小红书原图不过期，多半能成；抖音/TikTok 直链几小时就失效，多半还会失败，
// 那就得回作者主页重新采集）。记录留着，真下成功了才删。
async function retryFailures(platform) {
  await ready;
  const taken = new Set(queue.map((it) => it.path));
  for (const it of inflight.values()) taken.add(it.path);
  const patch = {};
  let n = 0;
  for (const rec of await listFailures()) {
    if (platform && rec.platform !== platform) continue;
    for (const f of rec.files) {
      if (taken.has(f.path) || !f.urls || !f.urls.length) continue;
      taken.add(f.path);
      const item = {
        url: f.urls[0], urls: f.urls, urlIdx: 0, path: f.path, kind: f.kind, tries: 0,
        platform: rec.platform, workId: rec.workId, author: rec.author, title: rec.title,
        dateStr: rec.dateStr, pageUrl: rec.pageUrl
      };
      item.id = ++qseq;
      item.qk = qkey(item.id);
      patch[item.qk] = item;
      queue.push(item);
      n++;
    }
  }
  if (n) await chrome.storage.local.set(patch);
  pump();
  return n;
}

// ---------- 队列泵 ----------

let pumping = false;

async function pump() {
  await ready;
  if (pumping) return;
  pumping = true;
  try {
    await refreshAllCookieRulesGuarded();
    for (;;) {
      // 找第一个所在平台没暂停、还有空通道的任务；都没有（满了、暂停了、队列空了）就等下次再来
      const i = queue.findIndex((it) => !isPaused(it.platform) && (activeBy[it.platform] || 0) < PER_PLATFORM);
      if (i < 0) break;
      const item = queue.splice(i, 1)[0];
      takeSlot(item);

      try {
        const downloadId = await startDownload(item.url, item.path, "uniquify");
        inflight.set(downloadId, item);
        item.dlId = downloadId;
        saveItem(item);
      } catch (err) {
        freeSlot(item);
        await onItemFailed(item, String(err && err.message || err), true);
      }

      // 固定间隔本身就是机器特征，加点随机抖动
      await new Promise((r) => setTimeout(r, BETWEEN_MS + Math.random() * 1200));
    }
  } finally {
    pumping = false;
  }
}

async function onItemDone(item) {
  freeSlot(item);
  // 先记 dl:（去重依据）再删队列键：中间被打断最坏是 reconcile 再收尾一次，不会漏记
  if (item && item.workId) {
    try { await arcAdd(item); } catch (_) {}
    try { await clearFailure(item); } catch (_) {}
  }
  await dropItem(item);
  await bumpStats({ done: 1 }, item.platform);
  pump();
}

async function onItemFailed(item, reason, fromPump) {
  delete item.dlId;
  if (item.urls && item.urlIdx + 1 < item.urls.length) {
    item.urlIdx++;
    item.url = item.urls[item.urlIdx];
    item.tries = 0;
    queue.push(item);
    await saveItem(item);
  } else if (item.tries + 1 < MAX_TRIES) {
    item.tries++;
    queue.push(item);
    await saveItem(item);
  } else {
    try { await recordFailure(item, reason); } catch (_) {}
    await dropItem(item);
    await bumpStats({ failed: 1 }, item.platform);
    console.warn(LOG_TAG, "放弃下载", item.path, reason);
  }
  if (!fromPump) pump();
}

// ---------- 看门狗 ----------
//
// 正在下的文件占着本平台唯一的通道。它要是在 Chrome 里停住了（被暂停、危险文件等用户确认、
// 网络卡死），或者结束了但 service worker 正好没接到 onChanged，队列就会一直卡着不动。
// 每分钟问 Chrome 一遍：结束了的补收尾；被暂停的恢复；连续 STALL_CHECKS 次一个字节都没涨的
// 取消掉（走 onChanged 的 interrupted → 换下一个候选直链）。最后顺手 pump 一次。
const STALL_CHECKS = 3;
const progressMem = new Map();   // downloadId -> { bytes, still }

async function watchdog() {
  await ready;
  for (const [id, item] of [...inflight]) {
    let d = null;
    try { [d] = await chrome.downloads.search({ id }); } catch (_) {}
    if (!inflight.has(id)) continue;          // 等的这会儿 onChanged 已经处理了
    if (!d || d.state === "interrupted") {
      inflight.delete(id);
      progressMem.delete(id);
      freeSlot(item);
      await onItemFailed(item, d ? (d.error || "interrupted") : "下载记录不见了");
      continue;
    }
    if (d.state === "complete") {
      inflight.delete(id);
      progressMem.delete(id);
      await onItemDone(item);
      continue;
    }
    if (d.paused && d.canResume) { chrome.downloads.resume(id).catch(() => {}); continue; }
    const m = progressMem.get(id) || { bytes: -1, still: 0 };
    if (d.bytesReceived === m.bytes) m.still++; else { m.bytes = d.bytesReceived; m.still = 0; }
    progressMem.set(id, m);
    if (m.still >= STALL_CHECKS) {
      progressMem.delete(id);
      console.warn(LOG_TAG, "下载卡住，取消换下一个候选", item.path);
      chrome.downloads.cancel(id).catch(() => {});
    }
  }
  for (const id of progressMem.keys()) if (!inflight.has(id)) progressMem.delete(id);
  pump();
}

// ---------- 清理下载记录 ----------
//
// chrome.downloads 每个文件都在 Chrome 下载历史留一条记录，Chrome 自己从不清，攒到几十万条
// 会拖慢整个浏览器。只 erase 记录（不碰盘上文件），只挑本扩展发起的、已结束的、不在 inflight 里的。
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
    if (erased) console.log(LOG_TAG, "已清理下载记录", erased, "条");
  })().finally(() => {
    sweeping = null;
    if (sweepAgain) { sweepAgain = false; sweepRecords(); }
  });
  return sweeping;
}

chrome.runtime.onStartup.addListener(() => { sweepRecords(); });
chrome.runtime.onInstalled.addListener(() => { sweepRecords(); });

// CDN 个别边缘节点不给视频，回一个验证/拦截网页。以前这种会被存成 .html，Chrome 再当成
// 危险文件拦下来——拦下来的下载可能一直挂在"等用户确认"，不完成也不失败，白占一个并发名额。
// 在 Chrome 拿到响应头、还没开始写盘时看一眼类型：是网页就直接取消，onChanged 收到
// interrupted 后照常走 onItemFailed 换下一个候选直链。
//
// 注册了 onDeterminingFilename 之后，download() 里给的 filename 不一定还算数，所以本扩展
// 发起的下载在这里把路径再明确给一次（startDownload 先按 url 记下）；别人的下载原样放行。
const pendingNames = new Map();   // url -> { filename, conflictAction }

function startDownload(url, filename, conflictAction) {
  pendingNames.set(url, { filename, conflictAction });
  return chrome.downloads.download({ url, filename, conflictAction, saveAs: false })
    .catch((err) => { pendingNames.delete(url); throw err; });
}

// 图片的扩展名按实际类型定：小红书原图可能是 jpeg 也可能是 webp/png，统一叫 .jpg 会对不上
const IMAGE_EXT = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png", "image/gif": "gif", "image/avif": "avif", "image/heic": "heic" };

chrome.downloads.onDeterminingFilename.addListener((d, suggest) => {
  if (d.byExtensionId !== chrome.runtime.id) { suggest(); return; }
  const name = pendingNames.get(d.url);
  pendingNames.delete(d.url);
  if (/^text\/html\b/i.test(d.mime || "")) {
    suggest();
    chrome.downloads.cancel(d.id).catch(() => {});
    return;
  }
  if (!name) { suggest(); return; }
  const ext = IMAGE_EXT[(d.mime || "").split(";")[0].trim().toLowerCase()];
  if (ext && /\.jpg$/i.test(name.filename)) name.filename = name.filename.replace(/\.jpg$/i, "." + ext);
  suggest(name);
});

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
    freeSlot(item);
    await onItemFailed(item, delta.error ? delta.error.current : "interrupted");
  }
  if (!queue.length && !active) {
    flushPendingTxt();
    sweepSoon();
  }
});

// ---------- 消息 ----------

async function stateSnapshot() {
  await ready;
  return {
    queued: queue.length,
    active,
    pausedBy,
    stats: await ensureStats(),
    byPlatform: countByPlatform()
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.cmd === "enqueue") {
    (async () => {
      await ready;
      // 同一个文件已经在排队或正在下，不再重复入队，否则 uniquify 会存出 "xxx (1).mp4"
      const taken = new Set(queue.map((it) => it.path));
      for (const it of inflight.values()) taken.add(it.path);
      const patch = {};
      const perPlatform = {};
      let n = 0, dup = 0;
      for (const w of msg.works || []) {
        if (!w || !PLATFORMS[w.platform]) continue;
        for (const item of expand(w, PLATFORMS[w.platform].saveRoot)) {
          if (taken.has(item.path)) { dup++; continue; }
          taken.add(item.path);
          item.id = ++qseq;
          item.qk = qkey(item.id);
          patch[item.qk] = item;
          queue.push(item);
          n++;
          perPlatform[w.platform] = (perPlatform[w.platform] || 0) + 1;
        }
      }
      if (n) await chrome.storage.local.set(patch);
      for (const [p, k] of Object.entries(perPlatform)) await bumpStats({ enqueued: k }, p);
      pump();
      sendResponse({ ok: true, added: n, skipped: dup, queued: queue.length });
    })();
    return true;
  }

  if (msg.cmd === "getFailures") {
    listFailures().then((list) => sendResponse({ list }));
    return true;
  }
  if (msg.cmd === "retryFailures") {
    retryFailures(msg.platform).then((added) => sendResponse({ added }));
    return true;
  }
  if (msg.cmd === "clearFailures") {
    (async () => {
      const keys = (await listFailures()).map((r) => FKEY + r.platform + ":" + r.workId);
      if (keys.length) await chrome.storage.local.remove(keys);
      sendResponse({ cleared: keys.length });
    })();
    return true;
  }

  if (msg.cmd === "getState") {
    stateSnapshot().then(sendResponse);
    return true;
  }

  // platform 不给 = 所有平台
  if (msg.cmd === "pauseQueue" || msg.cmd === "resumeQueue") {
    const on = msg.cmd === "pauseQueue";
    const targets = msg.platform && PLATFORMS[msg.platform] ? [msg.platform] : Object.keys(PLATFORMS);
    (async () => {
      await ready;                   // 先等存档读完，不然读档会把这里刚设的状态盖掉
      for (const p of targets) { if (on) pausedBy[p] = true; else delete pausedBy[p]; }
      await savePaused();
      if (!on) pump();
      sendResponse(await stateSnapshot());
    })();
    return true;
  }

  // platform 不给 = 清整条队列；给了就只清那个平台的排队项。正在下的不受影响。
  if (msg.cmd === "clearQueue") {
    (async () => {
      await ready;
      const only = msg.platform && PLATFORMS[msg.platform] ? msg.platform : null;
      const dropped = only ? queue.filter((it) => it.platform === only) : queue;
      queue = only ? queue.filter((it) => it.platform !== only) : [];
      dropped.forEach((it) => { it.finished = true; });
      if (dropped.length) await chrome.storage.local.remove(dropped.map((it) => it.qk)).catch(() => {});
      sendResponse(Object.assign({ cleared: dropped.length }, await stateSnapshot()));
    })();
    return true;
  }

});

// ---------- 续跑 ----------

ready.then(() => { if (queue.length) pump(); });
