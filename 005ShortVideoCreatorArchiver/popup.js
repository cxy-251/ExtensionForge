/* 工具栏弹窗：每个平台一行（排队/下载中/完成/失败 + 暂停/继续出队 + 清空排队）+ 失败清单（重试/清空）+ 打开导入页。 */
"use strict";

const $ = (id) => document.getElementById(id);
const LABELS = { kuaishou: "快手", douyin: "抖音", tiktok: "TikTok", xiaohongshu: "小红书" };
const ORDER = ["douyin", "tiktok", "xiaohongshu", "kuaishou"];

// 每个平台一行：数字 + ⏸/▶ + 🗑。行是固定的，只更新里面的字，免得每 2 秒整块重画
function ensureRows() {
  const box = $("plats");
  if (box.childElementCount) return;
  for (const p of ORDER) {
    const row = document.createElement("div");
    row.className = "plat";
    row.dataset.p = p;
    const name = document.createElement("span"); name.className = "name"; name.textContent = LABELS[p];
    const chip = document.createElement("span"); chip.className = "chip";
    const nums = document.createElement("span"); nums.className = "nums";
    const pause = document.createElement("button"); pause.className = "sbtn"; pause.dataset.act = "pause";
    const clear = document.createElement("button"); clear.className = "sbtn"; clear.dataset.act = "clear";
    clear.textContent = "清空"; clear.title = `清空${LABELS[p]}还在排队的（正在下的不受影响）`;
    row.append(name, chip, nums, pause, clear);
    box.appendChild(row);
  }
}

function render(st) {
  ensureRows();
  const by = (st && st.byPlatform) || {};
  const pausedBy = (st && st.pausedBy) || {};
  for (const row of $("plats").children) {
    const p = row.dataset.p;
    const v = by[p] || { queued: 0, active: 0, done: 0, failed: 0 };
    const paused = !!pausedBy[p];
    const nums = row.querySelector(".nums");
    nums.textContent = "";
    const add = (label, n, cls) => {
      const b = document.createElement("b"); b.textContent = String(n || 0);
      if (cls && n) b.className = cls;
      nums.append(label, b, " ");
    };
    add("排", v.queued); add("完", v.done); add("败", v.failed, "bad");
    // 状态标签说的是「现在实际在干什么」，按钮说的是「点了会怎样」
    const chip = row.querySelector(".chip");
    const state = v.active ? "run" : paused ? "pause" : v.queued ? "wait" : "idle";
    chip.className = "chip " + state;
    chip.textContent = { run: paused ? "下载中·将暂停" : "下载中", pause: "已暂停", wait: "等待中", idle: "空闲" }[state];
    row.classList.toggle("idle", state === "idle");
    const pause = row.querySelector('[data-act="pause"]');
    pause.textContent = paused ? "继续" : "暂停";
    pause.title = paused ? `继续${LABELS[p]}出队` : `暂停${LABELS[p]}出队（正在下的照常下完）`;
    pause.classList.toggle("on", paused);
    row.querySelector('[data-act="clear"]').disabled = !v.queued;
  }
  last = st;
}

let last = null;

$("plats").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const p = btn.closest(".plat").dataset.p;
  if (btn.dataset.act === "pause") {
    const paused = !!(last && last.pausedBy && last.pausedBy[p]);
    render(await chrome.runtime.sendMessage({ cmd: paused ? "resumeQueue" : "pauseQueue", platform: p }).catch(() => null));
  } else if (btn.dataset.act === "clear") {
    const n = (last && last.byPlatform && last.byPlatform[p] && last.byPlatform[p].queued) || 0;
    if (!confirm(`清空${LABELS[p]}还在排队的 ${n} 个任务？正在下载的不受影响。`)) return;
    render(await chrome.runtime.sendMessage({ cmd: "clearQueue", platform: p }).catch(() => null));
  }
});

// 失败清单：按「平台 · 作者」分组，作品标题点了打开作品页。内容没变就不重画，免得展开的列表跳动
let failSig = "";
function renderFailures(list) {
  const box = $("failBox");
  const sig = JSON.stringify((list || []).map((r) => [r.platform, r.workId, r.files.length]));
  if (sig === failSig) return;
  failSig = sig;
  if (!list || !list.length) { box.hidden = true; return; }
  box.hidden = false;
  const files = list.reduce((n, r) => n + r.files.length, 0);
  $("failSum").textContent = `下载失败：${list.length} 个作品 / ${files} 个文件`;
  const groups = new Map();
  for (const r of list) {
    const g = `${LABELS[r.platform] || r.platform} · ${r.author || "未知作者"}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const wrap = $("failList");
  wrap.textContent = "";
  for (const [name, recs] of groups) {
    const g = document.createElement("div");
    g.className = "fail-group";
    const h = document.createElement("div");
    h.textContent = `${name}（${recs.length}）`;
    g.appendChild(h);
    for (const r of recs) {
      const label = `${r.title || r.workId}${r.files.length > 1 ? `（${r.files.length} 个文件）` : ""}`;
      const a = document.createElement(/^https?:\/\//.test(r.pageUrl || "") ? "a" : "div");
      a.className = "fail-item";
      a.textContent = a.title = label;
      if (a.tagName === "A") { a.href = r.pageUrl; a.target = "_blank"; }
      g.appendChild(a);
    }
    wrap.appendChild(g);
  }
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null));
  const f = await chrome.runtime.sendMessage({ cmd: "getFailures" }).catch(() => null);
  renderFailures(f && f.list);
}


$("btnImport").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("import.html") }));

$("btnRetry").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ cmd: "retryFailures" }).catch(() => null);
  $("btnRetry").textContent = r ? `🔁 已重新入队 ${r.added} 个文件` : "🔁 重试失败";
  setTimeout(() => { $("btnRetry").textContent = "🔁 重试失败"; }, 3000);
  refresh();
});
$("btnFailClear").addEventListener("click", async () => {
  if (!confirm("清空失败清单？只是不再显示，不会删除任何文件，也不影响以后重新采集下载。")) return;
  await chrome.runtime.sendMessage({ cmd: "clearFailures" }).catch(() => null);
  refresh();
});

refresh();
setInterval(refresh, 2000);
