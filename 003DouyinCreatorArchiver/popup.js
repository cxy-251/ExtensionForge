/* 工具栏弹窗：展示下载队列状态 + 暂停/继续/清空。
 * 队列是常驻的（chrome.storage.local 里一个任务一个 q:<序号> 键 + paused 字段，
 * background.js 每次拉起都会读回来接着跑）——
 * 重启浏览器不会自动清空，必须手动暂停/清空才能真正停下来。 */
"use strict";

const $ = (id) => document.getElementById(id);

async function q() {
  const st = await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null);
  if (!st) { $("q").textContent = "队列：—"; return; }
  const s = st.stats || {};
  $("q").textContent = `队列：完成 ${s.done || 0} · 失败 ${s.failed || 0} · 排队 ${st.queued || 0}` +
    (st.paused ? " ｜ ⏸ 已暂停" : "");
  $("btnPause").disabled = !!st.paused;
  $("btnResume").disabled = !st.paused;
}

$("btnPause").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ cmd: "pauseQueue" }).catch(() => {});
  q();
});
$("btnResume").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ cmd: "resumeQueue" }).catch(() => {});
  q();
});
$("btnClear").addEventListener("click", async () => {
  if (!confirm("清空整条下载队列？已经在下载中的那一条不受影响，排队等待的会全部清掉。")) return;
  await chrome.runtime.sendMessage({ cmd: "clearQueue" }).catch(() => {});
  q();
});

q();
setInterval(q, 2000);
