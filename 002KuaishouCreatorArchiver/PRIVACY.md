# 隐私政策 / Privacy Policy

最后更新 / Last updated: 2026-09-07

## 中文

本政策适用于 Chrome 扩展「快手创作者作品归档助手」。

扩展只在 `*://*.kuaishou.com/*` 与 `*://*.chenzhongtech.com/*` 页面上运行，用于：

- 旁路读取页面**自身**发出的作品接口响应（`/graphql`、`profile/public`、`feedbyid`、
  `photo/info` 等），从中解析视频 / 图集直链与标题、作者、点赞数、时间等公开信息；
- 在创作者主页显示一个采集面板；
- 把选中的直链交给浏览器（`chrome.downloads`）下载；
- 给发往快手 CDN（`*.kwaicdn.com` / `*.yximgs.com` / `*.kwimgs.com`）的下载请求
  补 `Referer` / `Origin` 头，避免直链 403。

扩展**不会**：

- 读取或上传 Cookie、登录凭据、账号信息；
- 主动向快手发起额外的业务请求，或重放页面的请求；
- 修改页面发出的请求内容（仅对 CDN 下载请求补 Referer/Origin 头）；
- 收集浏览历史、搜索内容或与作品无关的网页内容；
- 使用分析、广告、跟踪或遥测服务；
- 向开发者或任何第三方服务器发送数据（本扩展没有后台服务器）；
- 加载或执行远程代码；
- 在非快手 / chenzhongtech 域名下运行。

本地存储：导入的创作者主页列表、采集/下载进度与设置，仅保存在浏览器本机的
`chrome.storage.local`，不同步、不外发。下载的视频 / 图片文件保存在你系统的下载
目录下。清除扩展数据或卸载扩展即全部移除。

联系与支持：https://github.com/cxy-251/PyGitRep001/issues

Kuaishou / 快手 是其权利人的商标，本扩展与其无任何关联，也未获其授权或认可。

---

## English

This policy applies to the Chrome extension “Kuaishou Creator Archiver”.

The extension runs only on `*://*.kuaishou.com/*` and `*://*.chenzhongtech.com/*` pages to:

- Passively read responses of the work/feed API calls the **page itself** makes
  (`/graphql`, `profile/public`, `feedbyid`, `photo/info`, …), parsing out video /
  image direct URLs plus public metadata (title, author, like count, timestamp);
- Show a capture panel on creator profile pages;
- Hand selected direct URLs to the browser (`chrome.downloads`) for downloading;
- Add `Referer` / `Origin` headers to download requests going to Kuaishou CDNs
  (`*.kwaicdn.com` / `*.yximgs.com` / `*.kwimgs.com`) so direct links don’t 403.

The extension does **not**:

- Read or upload cookies, credentials, or account information;
- Initiate extra business requests to Kuaishou, or replay the page’s requests;
- Alter the content of requests the page makes (only adds Referer/Origin to CDN
  download requests);
- Collect browsing history, searches, or page content unrelated to works;
- Use analytics, advertising, tracking, or telemetry;
- Send data to the developer or any third-party server (there is no backend);
- Load or execute remote code;
- Run on any non-Kuaishou / non-chenzhongtech domain.

Local storage: the imported creator list, capture/download progress, and settings
are kept only in the browser’s local `chrome.storage.local` — not synced, not sent
anywhere. Downloaded media is saved to your system Downloads folder. Removing the
extension or clearing its data removes all of it.

Contact and support: https://github.com/cxy-251/PyGitRep001/issues

Kuaishou is a trademark of its respective owner. This extension is not affiliated
with, authorized by, or endorsed by it.
