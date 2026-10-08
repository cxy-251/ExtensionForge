# 005 短视频创作者作品归档助手（快手 / 抖音 / TikTok）

002/003/004 合并后的版本，只做一件事：**在创作者主页上不停下滑采集作品，然后入队下载**。
002/003/004 保持不动，可以并存。

## 支持的页面

只认创作者主页的「作品」页，其它页面（单个视频、点赞、收藏、合集、推荐流）不出面板、不采集：

| 平台 | 页面 | 采集的接口 |
|---|---|---|
| 快手 | `www.kuaishou.com/profile/<id>` | `graphql`（`visionProfilePhotoList`）、`profile/public`、`profile/feed` |
| 抖音 | `www.douyin.com/user/<sec_uid>`（无 `showTab` 或 `showTab=post`） | `aweme/post` + 首屏 `RENDER_DATA` |
| TikTok | `www.tiktok.com/@<uniqueId>` | `/api/post/item_list` + 首屏 `__UNIVERSAL_DATA_FOR_REHYDRATION__` |

每条作品还会按作者 id 和主页主人比对一次（快手 `author.id`、抖音 `author.sec_uid`、
TikTok `author.uniqueId`），对不上的丢掉；站内跳到别的页面，采集列表清空。

## 用法

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录；
2. 登录对应平台，打开创作者主页，右下角出现面板；
3. 「自动采集」不停下滑，直到连续 4 轮没有新作品（到底了）才停，不限总轮数；遇到安全验证会停下；
4. 「下载全部」把没下过的作品加入下载队列；
5. 面板上有一行队列数字：排队 / 下载中 / 完成 / 失败；
6. 点浏览器工具栏的扩展图标（气泡）：**⏸ 暂停出队 / ▶ 继续出队**、**🗑 清空全部排队**、**📂 从磁盘导入已下记录**。

暂停只拦截出队，已经交给浏览器的下载照常下完，适合临时把带宽让出来。
队列三个平台共用一条，常驻在 `chrome.storage`，重启浏览器后接着下。

## 保存位置

`<Chrome 下载目录>/<快手|抖音|TikTok>/<作者>/`：视频 `日期_标题_id.mp4`，图集一个作品一个文件夹。
每个作者文件夹里有一份 `downloaded.txt`（`kuaishou|douyin|tiktok <id>`，兼容 yt-dlp `--download-archive`）。

## 与 002/003/004 的区别

- 去重键带平台前缀：`dl:<platform>:<id>`、`arc:<platform>:<author>`；
- Cookie 动态规则 ID 分段：快手 1xxx、抖音 2xxx、TikTok 3xxx，`requestDomains` 只限本平台域名；
- 面板在 Shadow DOM 里，不受页面样式影响；面板只管采集和入队，队列控制都在气泡里；
- 只靠 manifest `world: "MAIN"` 注入 `inject.js`，去掉了 `<script>` 兜底注入；
- 新扩展的存储是空的，读不到 002/003/004 的记录，要先从磁盘导入一次（见下）。

## 接上 002/003/004 的已下记录

**开始用 005 下载之前**做一次：工具栏弹窗 →「📂 从磁盘导入已下记录」→ 选平台 → 选这个平台的下载
文件夹（例如 `下载目录/抖音`）。会读每个作者文件夹里的 `downloaded.txt`，再从视频文件名
`日期_标题_<id>.mp4`、图集文件夹名 `日期_标题_<id>` 里补 id，导入成 `dl:`/`arc:` 记录。只读不写盘，可以重复导入。

一定要先导入：005 写 `downloaded.txt` 是按 `arc:` 整份覆盖，路径和 003 一样，不导入的话旧 txt 会被只含新记录的版本冲掉。

## 文件

```text
manifest.json         三个平台的 content script、DNR 规则
inject.js             MAIN world：只转发主页作品列表接口的回包 + 首屏状态
content/common.js     共用小工具
content/adapter-*.js  各平台：判定主页、解析作品
content/panel.js      面板、自动下滑、入队、队列控制
background.js         下载队列、Cookie 规则、去重记录、downloaded.txt
popup.*               工具栏弹窗：全平台队列一览 + 暂停/继续/清空 + 打开导入页
import.*              从磁盘导入已下记录
rules.json            静态 Referer/Origin 规则
```
