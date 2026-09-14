/*
 * 后台 service worker：下载队列。跟 002（快手）同一套逻辑，去掉了控制台页(FSA)相关的
 * 协调——v1 没有批量列表/连续模式/控制台页，downloaded.txt 直接无条件走 chrome.downloads
 * 写（不用判断"控制台页在不在管"），簡单很多。
 *
 * content.js 把「作品」结构丢过来，这里展开成一个个下载项，按并发上限交给
 * chrome.downloads，失败重试一次，进度写入 chrome.storage 供 popup 展示。
 */
"use strict";

const DEFAULTS = Object.freeze({
  saveRoot: "抖音",
  concurrency: 2,
  betweenMs: 1500,
  maxTries: 2
});

let queue = [];
let paused = false;
let active = 0;
const inflight = new Map();

// ---------- CDN 直链带上登录态 Cookie ----------
//
// 之前这个插件只给 CDN 域名（douyinvod.com 等）套了 Referer/Origin，没有 Cookie；
// 大部分公开视频这样就够用，但排查 TikTok（004）那次才搞清楚：一部分请求需要真实
// 登录态 Cookie 才放行，直连没带 Cookie 会被拦、Chrome 按拿到的内容把文件存成 .html。
// 而且 rules.json 那份 CDN_DOMAINS 列表里压根没有 "douyin.com" 自己——如果某些视频
// 直链走的是 www.douyin.com/aweme/v1/play/ 这种挂在主域名下的兜底地址（TikTok 那边
// 实测过这个套路：www.tiktok.com/aweme/v1/play/），这条规则一次都没套上过，别说
// Cookie，连 Referer 都没给。这里照抄 004 那次验证过确实有效的方案：单独给
// douyin.com 本域开一条规则，resourceTypes 里不含 xmlhttprequest（不影响页面自己
// 发的 /aweme/v1/... 接口请求，那些交给 inject.js 被动旁路读就行）。
const CDN_DOMAINS = ["douyinvod.com", "zjcdn.com", "douyinpic.com", "iesdouyin.com", "snssdk.com"];
const CDN_COOKIE_RULE_ID = 9001;
const DOUYIN_DOMAIN_COOKIE_RULE_ID = 9002;

async function refreshCdnCookieRule() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "douyin.com" });
    if (!cookies || !cookies.length) return;
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [CDN_COOKIE_RULE_ID, DOUYIN_DOMAIN_COOKIE_RULE_ID],
      addRules: [
        {
          id: CDN_COOKIE_RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "cookie", operation: "set", value: cookieHeader },
              { header: "referer", operation: "set", value: "https://www.douyin.com/" },
              { header: "origin", operation: "set", value: "https://www.douyin.com" }
            ]
          },
          condition: { requestDomains: CDN_DOMAINS, resourceTypes: ["xmlhttprequest", "media", "other"] }
        },
        {
          id: DOUYIN_DOMAIN_COOKIE_RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "cookie", operation: "set", value: cookieHeader },
              { header: "referer", operation: "set", value: "https://www.douyin.com/" },
              { header: "origin", operation: "set", value: "https://www.douyin.com" }
            ]
          },
          condition: { requestDomains: ["douyin.com"], resourceTypes: ["media", "other"] }
        }
      ]
    });
  } catch (e) {
    console.warn("[抖音归档] 刷新 CDN Cookie 规则失败", e);
  }
}

// pump() 每次真下载前都会等一次这个刷新完成——万一它意外卡住（并发重复调用、
// Chrome 内部处理慢），下载队列就会卡死在"排队中、永远不开始"。这里加一层去重
// （同一时间只真正跑一次，其它调用方等同一个 promise）+ 一个超时保险（最多等 3 秒，
// 超时就不等了，Cookie 刷新继续在后台跑，不耽误先把下载跑起来）。
let cookieRefreshInFlight = null;
function refreshCdnCookieRuleGuarded() {
  if (!cookieRefreshInFlight) {
    cookieRefreshInFlight = refreshCdnCookieRule().finally(() => { cookieRefreshInFlight = null; });
  }
  return Promise.race([cookieRefreshInFlight, new Promise((r) => setTimeout(r, 3000))]);
}

// Cookie 会过期/轮换，得定期刷新——必须用 chrome.alarms，不能用 setInterval：MV3 的
// service worker 闲置一段时间会被系统直接杀掉，setInterval 扛不住这个，被杀之后就
// 再也不会刷新了（这也是 004 那次真实踩过、后来才弄明白的坑）。
refreshCdnCookieRule();
chrome.alarms.create("refreshCdnCookie", { periodInMinutes: 4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshCdnCookie") refreshCdnCookieRule();
});
if (chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((info) => {
    if (info.cookie && /douyin\.com$/.test(info.cookie.domain || "")) refreshCdnCookieRule();
  });
}

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
  // 同一句文案发好几条、同一天发好几条都很常见——videoId 编进文件名，从根上防撞名
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
// dl:<videoId>   chrome.storage —— 去重依据
// arc:<author>   chrome.storage —— 该作者已下的 videoId 数组
// v1 没有控制台页/FSA，downloaded.txt 统一走 chrome.downloads 直接写（会闪一下下载栏）

const arcMem = new Map();
// downloaded.txt 原来是 setTimeout 防抖 4 秒后写——这 4 秒空窗期 service worker 完全
// 可能被系统杀掉，回调就没了，文件永远写不出来。改成不用计时器之后又踩了另一个坑：
// 改成"每成功一条就立刻写"，一批视频连续下完，downloaded.txt 就跟着被反复写、
// chrome://downloads 里刷一串重复下载提示。现在改成靠真实事件（不是计时器）攒批：
// 攒够 5 条，或者这一批任务已经跑完（队列空、没有在跑的），才真正写一次。
const txtWriting = new Set();
const txtDirty = new Set();
const txtPending = new Map();   // author -> 距离上次真正写入，已经攒了几条成功记录

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
  const body = ids.sort().map((id) => "douyin " + id).join("\n") + "\n";
  const path = joinPath([saveRoot, author]) + "/downloaded.txt";
  try {
    await chrome.downloads.download({
      url: "data:text/plain;charset=utf-8," + encodeURIComponent(body),
      filename: path,
      conflictAction: "overwrite",
      saveAs: false
    });
  } catch (err) {
    console.warn("[抖音归档] 写 downloaded.txt 失败", author, err);
  }
}

// ---------- 队列泵 ----------

async function pump() {
  if (paused) return;
  await refreshCdnCookieRuleGuarded();   // 真要下载了，先确保 Cookie 规则是最新的登录态（带超时保险）
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

    if (betweenMs) await new Promise((r) => setTimeout(r, betweenMs + Math.random() * 1200));
  }
}

async function onItemDone(item) {
  active = Math.max(0, active - 1);
  if (item && item.workId) {
    try { await arcAdd(item); } catch (_) {}
  }
  await bumpStats({ done: 1 });
  pump();
}

async function onItemFailed(item, reason) {
  if (item.urls && item.urlIdx + 1 < item.urls.length) {
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
    console.warn("[抖音归档] 放弃下载", item.path, reason);
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
}

chrome.runtime.onStartup.addListener(resume);
chrome.runtime.onInstalled.addListener(resume);
resume();
