# 004 TikTok 创作者作品归档助手

Chrome Manifest V3 扩展。跟 002（快手）/003（抖音）同一套架构，字段/接口换成 TikTok 的
`itemList`/`itemStruct` 结构。v1 范围：**只做单页手动采集**，没有 002 那种批量创作者
列表 + 连续模式 + 控制台页（要加的话照抄 002 的 `app.html`/`app.js`）。

这一版是在 002/003 都踩过坑之后写的，两个已知坑直接从一开始就避开了：

- **图集/图片作品优先按图集处理**：TikTok 的 Photo Mode（图集）作品即使接口里也带了个
  兼容视频/音轨字段（给老客户端播放用），只要有真实图片就一律按图集下载，不会被那个
  兼容字段抢走（抖音 003 上线后才发现这个坑，导致图集混入一段音频，这次直接内置）。
- **只采集当前页面显示的标签**：来源接口类型跟当前页面（作品/点赞/合集/详情）对不上
  就丢弃，页面身份一变就清空重来——不会把这个标签页历史上打开过的其它页面的作品
  也算进当前这次采集（抖音 003 上线后才发现"点赞视频混入采集"这个坑，这次直接内置）。

---

## 安装与更新

1. 打开 `chrome://extensions`；
2. 打开右上角「开发者模式」；
3. 点「加载已解压的扩展程序」，选择本目录 `004TikTokCreatorArchiver`；
4. 改代码/权限变更后：在扩展卡片点「重新加载」，再刷新已打开的 TikTok 页面。

---

## 用法

1. 打开创作者主页（`/@user`）/ 单视频页（`/video/xxx`）/ 点赞列表 / 合集页，右下角出现
   采集面板（TikTok 大多数账号默认不公开点赞列表，采不到属于正常情况，不是插件的问题）；
2. 点「自动采集」往下滚动收集，或手动滚动也行——两个都会被面板抓到；
3. 点「下载全部」交给下载队列，或点某一条右边的 ⬇ 单独下载；
4. 工具栏弹窗（点扩展图标）能看到下载队列进度，也能**暂停队列 / 继续 / 清空队列**——
   下载队列是常驻的（存在 `chrome.storage` 里，重启浏览器也不会自动清空），不想让它
   继续下就点弹窗里的按钮。

## 采集哪些接口

不用逆向 TikTok 自己那套 `X-Bogus`/`X-Gnarly`/`msToken`/WBI 风格请求签名算法——浏览器
自己浏览时算好的签名请求，插件只是旁路"抄一份"页面自己发出的回包，跟 002/003 是同一
个思路：

| 页面类型 | 接口特征 | 响应字段 |
|---|---|---|
| 主页作品 | `/api/post/item_list` | `itemList[]` |
| 点赞列表 | `/api/favorite/item_list` | `itemList[]` |
| 合集 | `/api/playlist/item_list` 或 `/api/mix/item_list` | `itemList[]` |
| 单视频详情 | 不走单独接口，内嵌在首屏 `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">`（老版本页面是 `SIGI_STATE`） | `itemStruct{}` |

TikTok 页面同时还会在后台悄悄触发一些跟"当前页面"无关的接口（比如陌生人的转发列表
`/api/repost/item_list`、故事流 `/api/story/batch/item_list`），这些**一律不采**——
只有接口来源类型跟当前页面标签严格匹配才收，宁可少采也不能采错（见上面"已知坑"）。

TikTok 前端改版比较频繁，字段名如果对不上了，先点面板上的「导出接口回包样本」把真实
结构导出来，再改代码，不要猜字段瞎改。

## 画质

`video.bitrateInfo[]` 是 TikTok 自己给的多档画质数组（每档通常带 3 个候选 URL：
`v16-webapp-prime.tiktok.com`/`v19-webapp-prime.tiktok.com` 两个直连镜像 + 一个走
`www.tiktok.com/aweme/v1/play/` 的兜底地址），插件收集全部档位、第一档优先——这套
字段路径是拿真实导出的接口回包样本核对过的，不是凭记忆猜的。没有档位数组时兜底用
`playAddr`/`downloadAddr`。

---

## 下载队列与 CDN 直链

- 下载走 `chrome.downloads`，并发 2、失败自动换下一个候选直链，候选都试完了才真正放弃；
- **CDN 直链需要真实登录态 Cookie，且真正挂在 `tiktok.com` 自己的子域名下**：一开始
  以为视频直链走的是 `tiktokcdn.com`/`tiktokv.com` 这类独立 CDN 域名，实测发现根本
  不是——TikTok 网页版的视频直链挂在 `v16-webapp-prime.tiktok.com`/
  `v19-webapp-prime.tiktok.com`/`www.tiktok.com` 这些 `tiktok.com` 自己的子域名下，
  不给 `tiktok.com` 这条规则的话请求一个 Cookie 都不带，TikTok 直接返回验证/拦截页面，
  Chrome 存下来的自然是个 `.html` 文件；
- `chrome.cookies.getAll({domain:"tiktok.com"})` 读出真实登录 Cookie，通过
  `declarativeNetRequest` 动态规则塞进下载请求头（连同 `Referer`/`Origin`），每 4 分钟
  用 `chrome.alarms` 刷新一次（不用 `setInterval`——MV3 的 service worker 闲置会被系统
  杀掉，`setInterval` 扛不住这个）。

### 已知现象：下载列表里偶尔会看到「已被禁止」/存成 `.html`

**不是采集抓错了直链，是 TikTok CDN 边缘节点各自为政**：同一条视频的十几个候选直链
分别落在不同的边缘节点上，即使 Cookie/Referer 都带对了（可以在扩展的 service worker
控制台里跑 `chrome.declarativeNetRequest.getMatchedRules()` 确认规则确实命中了），仍
然会有个别节点返回一个验证/拦截页面而不是视频内容——Chrome 按拿到的内容把这次下载
存成了 `.html`，队列看到失败后会自动换下一个候选重试。**只要最终完成的数量跟采集到
的数量对得上，这些 `.html`/已被禁止的记录就只是过程噪音，不用管**；如果 Chrome 的
「安全浏览」开着「增强保护」，也会叠加拦一部分，可以在 `chrome://settings/security`
里降低保护等级验证是否是这层叠加的。

### `downloaded.txt`

每个作者文件夹下会有一份 `downloaded.txt`（`tiktok <videoId>`，每行一条，兼容 yt-dlp
`--download-archive` 格式）。不是每下完一条就立刻写——那样一批视频连续下完会反复触发
下载提示；改成攒够 5 条、或者这一批下载任务真正跑完（队列空、没有在跑的）才真正写一
次，靠真实事件驱动，不依赖计时器（怕 service worker 被杀导致完全不触发）。

---

## 工作原理

```text
inject.js     （MAIN world, document_start）
   挂钩 window.fetch / XMLHttpRequest，把上面那几类接口的响应体抄一份 postMessage 出去。

content.js    （ISOLATED world）
   收响应 → 解析成「作品」（图集优先判断）→ 按「来源接口类型是否匹配当前页面标签」
   严格过滤 → 去重入库 → 渲染面板 / 自动滚动 / 验证码识别 → 把作品结构发给 background。

background.js （service worker）
   维护登录态 Cookie 规则（chrome.alarms 定期刷新，覆盖 CDN 域名 + tiktok.com 主域名）→
   作品展开成下载项（多候选直链）→ 按并发上限调 chrome.downloads → 失败换链/重试 →
   完成后写 dl:<id>/arc:<作者> 索引、批量写 downloaded.txt。

popup.js      工具栏弹窗：下载队列状态 + 暂停/继续/清空。
rules.json    declarativeNetRequest 静态规则：给 CDN 域名和 tiktok.com 主域名补
              Referer/Origin（Cookie 部分是动态规则，静态规则里没法放动态值）。
```

## 文件结构

```text
manifest.json        清单：两个 content script（MAIN 抓包 + ISOLATED 逻辑）、popup、DNR 规则
inject.js            页面主世界：fetch / XHR 旁路抓包
content.js/.css      采集解析、页面面板、自动滚动、验证码识别、下发下载
background.js        下载队列 + Cookie 规则维护 + dl:/arc: 索引 + downloaded.txt
popup.html/.css/.js  工具栏弹窗：队列状态 + 暂停/继续/清空
rules.json           静态 declarativeNetRequest 规则（Referer/Origin）
README.md
```

---

## 排错：面板出来了，但「采集 0 条」/ 下载不到东西

1. 先点面板里的**「统计检测」**，看已采集直链几条、接口回包几次；
2. 点**「调试信息 ▸」**展开：
   - 一条回包都没有 → `inject.js` 没抓到请求，多半是没「重新加载扩展 + 刷新页面」；
   - 每条都是 `✗ +0/0` → TikTok 接口结构变了，点**「导出接口回包样本」**把真实结构
     导出，发给开发者改 `content.js` 的解析分支，不要猜字段瞎改；
   - 有 `⊘ 过滤N(非当前标签)` → 正常现象，说明过滤逻辑在生效，挡掉了不属于当前页面
     标签的数据（比如后台偷偷刷到的转发/故事流接口）；
3. 下载一直卡在「排队中」不开始 → 打开扩展的 service worker 控制台看有没有报错；
   Cookie 刷新逻辑加了超时保险（最多等 3 秒），正常不应该卡住整条队列。

## 已知限制

- 依赖 TikTok Web 接口结构，改版后某分支可能采不到，需要照真实响应改代码；
- 大多数账号默认不公开点赞列表，采不到属于 TikTok 自己的隐私设置，不是插件的问题；
- 自动滚动有痕迹，建议分批跑，别一次开几千个；
- 保存路径受 `chrome.downloads` 限制，只能是「下载目录」下的子文件夹。
