/* 工具栏弹窗：只是控制台的入口 + 队列一览。真正的功能都在 app.html。 */
"use strict";

const $ = (id) => document.getElementById(id);

$("openApp").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("app.html");
  try {
    const tabs = await chrome.tabs.query({ url });
    if (tabs && tabs[0]) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (_) {
    chrome.tabs.create({ url });
  }
  window.close();
});

async function q() {
  const st = await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null);
  if (!st) { $("q").textContent = "队列：—"; return; }
  const s = st.stats || {};
  $("q").textContent = `队列：完成 ${s.done || 0} · 失败 ${s.failed || 0} · 排队 ${st.queued || 0}`;
}
q();
setInterval(q, 2000);
