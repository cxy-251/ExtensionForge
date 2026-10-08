# 隐私政策 / Privacy Policy

最后更新 / Last updated: 2026-09-03

## 中文

本政策适用于 Chrome 扩展「YouTube 观看增强助手」。

扩展只在 `https://www.youtube.com/*` 页面上作为 content script 自动运行，用于：

- 在播放器控制栏插入网页全屏与单视频循环按钮；
- 在频道视频页插入「全部播放」按钮。

为了实现这些功能，扩展会在当前页面本地读取播放器及其祖先 DOM、元素尺寸、可见状态、滚动位置和焦点状态。这些信息仅用于插入按钮、铺满播放器布局，以及退出时恢复页面。

扩展不会：

- 收集、保存或上传浏览历史、账号信息、搜索内容或网页内容；
- 读取 Cookie、认证信息或网络请求；
- 使用分析、广告、跟踪或遥测服务；
- 向开发者或第三方发送数据；
- 加载或执行远程代码；
- 在任何非 YouTube 页面运行（清单中不申请任何 host 之外的主机权限，也没有后台脚本或 `activeTab`/`scripting` 权限）。

扩展没有后台服务器，不持久化网页内容；运行状态在页面刷新或关闭后清除。

联系与支持：

https://github.com/cxy-251/ExtensionForge/issues

YouTube is a trademark of Google LLC. This extension is not affiliated with or endorsed by Google LLC.

---

## English

This policy applies to the Chrome extension “YouTube Watch Enhancer”.

The extension runs automatically as a content script only on `https://www.youtube.com/*` pages to:

- Add viewport-fullscreen and single-video-loop buttons to the player controls;
- Add a “play all” button on channel video pages.

To provide these features, the extension locally reads the active player and its ancestor DOM, element dimensions, visibility, scroll position, and focus state. This information is used only to insert buttons, expand the player layout, and restore the page on exit.

The extension does not:

- Collect, store, or upload browsing history, account information, searches, or webpage content;
- Read cookies, credentials, or network requests;
- Use analytics, advertising, tracking, or telemetry services;
- Send data to the developer or third parties;
- Load or execute remote code;
- Run on any non-YouTube page (the manifest declares no host access beyond the YouTube content script, and no background script or `activeTab`/`scripting` permission).

The extension has no backend server and does not persist webpage content. Runtime state is cleared when the page is refreshed or closed.

Contact and support:

https://github.com/cxy-251/ExtensionForge/issues

YouTube is a trademark of Google LLC. This extension is not affiliated with or endorsed by Google LLC.
