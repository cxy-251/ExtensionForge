/* 工具栏弹窗：全平台队列一览 + 暂停/继续出队 + 清空整条队列 + 打开导入页。 */
"use strict";

const $ = (id) => document.getElementById(id);
const LABELS = { kuaishou: "快手", douyin: "抖音", tiktok: "TikTok" };
let last = null;

function render(st) {
  last = st;
  if (!st) { $("q").textContent = "队列：—"; $("per").textContent = ""; return; }
  const s = st.stats || {};
  $("q").textContent = `排队 ${st.queued || 0} · 下载中 ${st.active || 0} · 完成 ${s.done || 0} · 失败 ${s.failed || 0}` +
    (st.paused ? " ｜ ⏸ 已暂停出队" : "");
  const per = Object.entries(st.byPlatform || {})
    .filter(([, v]) => v.queued || v.active)
    .map(([k, v]) => `${LABELS[k] || k} 排队 ${v.queued} / 下载中 ${v.active}`);
  $("per").textContent = per.join(" ｜ ");
  $("btnToggle").textContent = st.paused ? "▶ 继续出队" : "⏸ 暂停出队";
  $("btnToggle").classList.toggle("paused", !!st.paused);
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null));
}

$("btnToggle").addEventListener("click", async () => {
  const cmd = last && last.paused ? "resumeQueue" : "pauseQueue";
  render(await chrome.runtime.sendMessage({ cmd }).catch(() => null));
});
$("btnClear").addEventListener("click", async () => {
  if (!confirm("清空全部平台的排队任务？已经在下载中的不受影响。")) return;
  render(await chrome.runtime.sendMessage({ cmd: "clearQueue" }).catch(() => null));
});

$("btnImport").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("import.html") }));

refresh();
setInterval(refresh, 2000);
