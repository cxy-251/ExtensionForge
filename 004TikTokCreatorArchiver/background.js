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
  // 只有真的没有图片时才当视频下（有图片一律走下面的图集分支，防止 TikTok 图集作品
  // 里那个兼容视频/音轨字段被误当成视频下载——003 上线后才踩过这个坑，这里直接照做）
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
  if (paused) return;
  await refreshCdnCookieRuleGuarded();   // 真要下载了，先确保 CDN 头规则是最新的登录态 Cookie（带超时保险）
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
    console.warn("[TikTok归档] 放弃下载", item.path, reason);
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
