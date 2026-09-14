# 003 抖音创作者作品归档助手

Chrome Manifest V3 扩展。跟 002（快手）同一套架构，字段/接口换成抖音的：在**你自己的
浏览器**里、你正常浏览抖音时，旁路读取页面自身发出的作品接口，抓视频/图集直链交给
浏览器下载。v1 范围：**只做单页手动采集**，没有 002 那种批量创作者列表 + 连续模式 +
控制台页（要加的话照抄 002 的 `app.html`/`app.js`）。

> 设计取舍同 002：不造自动化浏览器、不重放请求、不逆签名，只在真实会话里旁路读响应。

---

## 安装与更新

1. 打开 `chrome://extensions`；
2. 打开右上角「开发者模式」；
3. 点「加载已解压的扩展程序」，选择本目录 `003DouyinCreatorArchiver`；
4. 改代码/权限变更后：在扩展卡片点「重新加载」，再刷新已打开的抖音页面。

---

## 用法

1. **登录抖音**（重要：不登录只能看到前 20 个作品，这是抖音自己的限制，插件绕不开）；
2. 打开创作者主页 / 合集 / 点赞收藏页 / 单作品详情页，右下角出现采集面板；
3. 点「自动采集」往下滚动收集，或手动滚动也行——两个都会被面板抓到；
4. 点「下载全部」交给下载队列，或点某一条右边的 ⬇ 单独下载；
5. 工具栏弹窗（点扩展图标）能看到下载队列进度，也能**暂停队列 / 继续 / 清空队列**——
   下载队列是常驻的（存在 `chrome.storage` 里，重启浏览器也不会自动清空），不想让它
   继续下就点弹窗里的按钮。

## 采集哪些接口

参考 `../dyd/src-deobfuscated/service/dy.js`（别人已经做出来能用的桌面版下载器）验证过
的抖音接口清单：

| 页面类型 | 接口特征 | 响应字段 |
|---|---|---|
| 主页作品 | `aweme/post` | `aweme_list[]` |
| 合集 | `mix/aweme` | `aweme_list[]` |
| 点赞/收藏 | `aweme/favorite` | `aweme_list[]` |
| 收藏夹列表 | `aweme/listcollection` | `aweme_list[]` |
| 单作品详情 | `aweme/detail` | `aweme_detail{}` |

**只采集当前页面显示的标签**：接口来源类型跟当前页面（作品/点赞/合集/详情）对不上
就直接丢弃，不算数，页面身份（路径+标签）一变就清空重来——不会把这个标签页历史上
偷偷刷到的其它页面数据（比如后台悄悄触发的推荐流/转发流接口）也混进当前这次采集。

## 画质

抖音的 `video.bit_rate[]` 本身就是多档画质数组，插件默认收集全部档位、第一档优先
（通常是最高画质）。没有档位数组时兜底拼
`https://aweme.snssdk.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0` 直接要
1080p——这两条都是 dyd 里验证过的真实有效字段/公式，不是猜的。

---

## 下载队列与 CDN 直链

- 下载走 `chrome.downloads`，并发 2、失败自动换下一个候选直链（同一条视频往往有十几
  个候选：不同画质 + 不同镜像域名），候选都试完了才真正放弃；
- **CDN 直链需要真实登录态 Cookie**：`chrome.cookies.getAll({domain:"douyin.com"})`
  读出你浏览器里真实的抖音登录 Cookie，通过 `declarativeNetRequest` 动态规则塞进
  下载请求头（连同 `Referer`/`Origin`），每 4 分钟用 `chrome.alarms` 刷新一次（不用
  `setInterval`——MV3 的 service worker 闲置会被系统杀掉，`setInterval` 扛不住这个，
  `chrome.alarms` 才能保证即使被杀了也会被重新唤醒去刷新）；
- 规则覆盖两类域名：`douyinvod.com`/`zjcdn.com`/`douyinpic.com`/`iesdouyin.com`/
  `snssdk.com` 这几个 CDN 域名，以及 `douyin.com` 主域名自己（部分视频直链走
  `www.douyin.com/aweme/v1/play/...` 这种挂在主域名下的兜底地址，不给这条规则会完全
  没 Referer/Cookie）。

### 已知现象：下载列表里偶尔会看到「已被禁止」/存成 `.html`

**不是采集抓错了直链，是抖音 CDN 边缘节点各自为政**：同一条视频的十几个候选直链分别
落在不同的边缘节点上，即使 Cookie/Referer 都带对了，仍然会有个别节点返回一个验证/拦
截页面而不是视频内容——Chrome 按拿到的内容把这次下载存成了 `.html`，队列看到失败后
会自动换下一个候选重试。**只要最终完成的数量跟采集到的数量对得上，这些 `.html`/已被
禁止的记录就只是过程噪音，不用管**；如果 Chrome 的「安全浏览」开着「增强保护」，也会
叠加拦一部分，可以在 `chrome://settings/security` 里降低保护等级验证是否是这层叠加的。

### `downloaded.txt`

每个作者文件夹下会有一份 `downloaded.txt`（`douyin <videoId>`，每行一条，兼容
yt-dlp `--download-archive` 格式）。不是每下完一条就立刻写——那样一批视频连续下完会
反复触发下载提示；改成攒够 5 条、或者这一批下载任务真正跑完（队列空、没有在跑的）才
真正写一次，靠真实事件驱动，不依赖计时器（怕 service worker 被杀导致完全不触发）。

---

## 工作原理

```text
inject.js     （MAIN world, document_start）
   挂钩 window.fetch / XMLHttpRequest，把上面那几类接口的响应体抄一份 postMessage 出去。

content.js    （ISOLATED world）
   收响应 → 解析成「作品」→ 按「来源接口类型是否匹配当前页面标签」过滤 → 去重入库 →
   渲染面板 / 自动滚动 / 验证码识别 → 把作品结构发给 background。

background.js （service worker）
   维护登录态 Cookie 规则（chrome.alarms 定期刷新）→ 作品展开成下载项（多候选直链）→
   按并发上限调 chrome.downloads → 失败换链/重试 → 完成后写 dl:<id>/arc:<作者> 索引、
   批量写 downloaded.txt。

popup.js      工具栏弹窗：下载队列状态 + 暂停/继续/清空。
rules.json    declarativeNetRequest 静态规则：给 CDN 域名和 douyin.com 主域名补 Referer/Origin
              （Cookie 部分是动态规则，静态规则里没法放动态值）。
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
   - 每条都是 `✗ +0/0` → 抖音接口结构变了，点**「导出接口回包样本」**把真实结构导出，
     发给开发者改 `content.js` 的解析分支，不要猜字段瞎改；
   - 有 `⊘ 过滤N(非当前标签)` → 正常现象，说明过滤逻辑在生效，挡掉了不属于当前页面
     标签的数据（比如后台偷偷刷到的推荐流）；
3. 确认已登录抖音。

## 已知限制

- 依赖抖音 Web 接口结构，改版后某分支可能采不到，需要照真实响应改代码；
- 未登录只能看到前 20 个作品，抖音自己的限制；
- 自动滚动有痕迹，建议分批跑，别一次开几千个；
- 保存路径受 `chrome.downloads` 限制，只能是「下载目录」下的子文件夹。
