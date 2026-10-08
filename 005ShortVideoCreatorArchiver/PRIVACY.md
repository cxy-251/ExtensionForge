# 隐私政策 / Privacy Policy

最后更新 / Last updated: 2026-10-08

## 中文

本政策适用于 Chrome 扩展「短视频创作者作品归档助手」。

扩展只在快手（`kuaishou.com`）、抖音（`douyin.com`、`iesdouyin.com`）、TikTok（`tiktok.com`）、小红书（`xiaohongshu.com`）页面上运行，用于在创作者主页采集作品并交给浏览器下载。为此，扩展会在本机：

- 读取这些页面自己发出的「作者作品列表」接口的响应，以及页面首屏内嵌的作品数据，从中取出作品标题、作者、视频/图片直链；不读取其它接口，也不重放这些网站的接口请求（下面小红书笔记网页是唯一例外）；
- 在小红书上，你点「自动采集」后，扩展会以你的登录状态逐篇请求该作者笔记的网页（`xiaohongshu.com/explore/<笔记id>`，和你在新标签页打开那篇笔记相同，每篇间隔 1~2 秒），从网页里内嵌的数据读取图片和视频地址；这是本扩展唯一主动发起的网站请求，只发往小红书自己的笔记网页，被拦截时立即停止；
- 读取抖音、TikTok 域名下的 Cookie，通过 `declarativeNetRequest` 会话规则把它附加到发往**同一平台**视频/图片域名的下载请求上（这些平台的直链需要登录态才能下载）。Cookie 只在浏览器网络层使用，不保存、不发送到任何其它地方，也不会被带到别的平台；
- 在 `chrome.storage.local` 里保存下载队列、已下载作品的 id 和作者名（用于去重），以及一份计数；
- 通过 `chrome.downloads` 把文件保存到浏览器下载目录，并在每个作者文件夹里写一份 `downloaded.txt`；定期清除本扩展产生的下载记录（不删除文件）；
- 「从磁盘导入已下记录」页面只在你主动选择文件夹后，读取其中的文件名和 `downloaded.txt` 内容，只读、不上传、不修改。

扩展不会：

- 收集或上传浏览历史、账号信息、搜索内容或网页内容；
- 使用分析、广告、跟踪或遥测服务；
- 向开发者或任何第三方发送数据；
- 加载或执行远程代码。

扩展没有后台服务器。卸载扩展会一并删除它保存在浏览器里的数据；已下载的文件和 `downloaded.txt` 留在你的磁盘上。

联系与支持：

https://github.com/cxy-251/ExtensionForge/issues

快手 / Kuaishou、抖音 / Douyin、TikTok、小红书 / Xiaohongshu 是其各自权利人的商标，本扩展与它们没有任何关联。

---

## English

This policy applies to the Chrome extension “Short Video Creator Archiver”.

The extension runs only on Kuaishou (`kuaishou.com`), Douyin (`douyin.com`, `iesdouyin.com`), TikTok (`tiktok.com`) and Xiaohongshu (`xiaohongshu.com`) pages, to collect a creator's posts from their profile page and hand them to the browser for download. To do this, the extension locally:

- Reads the responses of the “creator post list” requests that these pages make themselves, plus the post data embedded in the initial page, to extract titles, authors and video/image URLs. It does not read other requests, and does not replay these sites' API requests (the Xiaohongshu note pages below are the only exception);
- On Xiaohongshu, after you click “auto collect”, requests that creator's note pages one by one with your signed-in session (`xiaohongshu.com/explore/<note id>`, the same as opening the note in a new tab, 1–2 seconds apart) and reads the image and video URLs embedded in them. These are the only requests the extension initiates to a website; they go only to Xiaohongshu's own note pages and stop as soon as they are blocked;
- Reads cookies for the Douyin and TikTok domains and, through `declarativeNetRequest` session rules, attaches them to download requests sent to the **same platform's** video/image domains (these platforms require a signed-in session to download). Cookies are used only in the browser's network layer; they are not stored, not sent anywhere else, and never attached to another platform;
- Stores the download queue, the ids and author names of downloaded posts (for de-duplication), and a counter in `chrome.storage.local`;
- Saves files to the browser's download folder through `chrome.downloads`, writes a `downloaded.txt` in each author folder, and periodically erases the download-history entries it created (files are not deleted);
- On the “import downloaded records” page, only after you choose a folder, reads file names and `downloaded.txt` contents in it — read-only, nothing is uploaded or modified.

The extension does not:

- Collect or upload browsing history, account information, searches or webpage content;
- Use analytics, advertising, tracking or telemetry services;
- Send data to the developer or any third party;
- Load or execute remote code.

The extension has no backend server. Uninstalling it removes the data it stored in the browser; downloaded files and `downloaded.txt` stay on your disk.

Contact and support:

https://github.com/cxy-251/ExtensionForge/issues

Kuaishou, Douyin, TikTok and Xiaohongshu are trademarks of their respective owners. This extension is not affiliated with or endorsed by them.
