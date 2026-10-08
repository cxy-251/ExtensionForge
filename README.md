# ExtensionForge

自用浏览器扩展的集中地。以后所有浏览器插件都写在这个目录下，一个子目录一个扩展。

> **Forge** = 锻造厂 / 铁匠铺。取「在这里打造扩展」之意（同类命名如 SourceForge）。

---

## 目录约定

```
ExtensionForge/
  NNN<PascalCase 名称>/     每个扩展一个独立、可直接加载的目录
    manifest.json           Manifest V3
    ...                     content / background / popup 等
    README.md               该扩展的用法与原理
    PRIVACY.md              该扩展的隐私说明（中英）
```

- `NNN` 三位序号，按加入顺序递增（`001`、`002`…），目录名后半段用 PascalCase 描述功能。
- 每个子目录都是**独立扩展**：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选该子目录。
- 无构建步骤，源码即产物；改完 content script 要「重新加载扩展 + 刷新目标页」。

## 共同风格

- Manifest V3，权限按最小必要申请，能不用 background 就不用。
- 面板 / 弹窗 UI 用中文，浅色 + `prefers-color-scheme: dark` 两套。
- 逻辑集中在少数几个文件，注释用中文分节（`// ---------- X ----------`）。
- 每个扩展自带 `README.md` + `PRIVACY.md`。
- 不加载远程代码，不发数据到自有服务器。

---

## 扩展清单

| 序号 | 目录 | 名称 | 作用 |
|---|---|---|---|
| 001 | `001YouTubeWatchEnhancer` | YouTube 观看增强助手 | YouTube 播放器网页全屏、单视频循环、频道视频页一键合成播放列表 |
| 002 | `002KuaishouCreatorArchiver` | 快手创作者作品归档助手 | 旁路读取快手作品接口，抓视频/图集直链并批量下载；支持导入创作者主页列表连续归档（批量列表+控制台页） |
| 003 | `003DouyinCreatorArchiver` | 抖音创作者作品归档助手 | 同 002 架构，抖音接口；v1 只做单页手动采集 |
| 004 | `004TikTokCreatorArchiver` | TikTok 创作者作品归档助手 | 同 002/003 架构，TikTok 接口；v1 只做单页手动采集，内置了 002/003 踩过的图集/串标签坑 |
| 005 | `005ShortVideoCreatorArchiver` | 短视频创作者作品归档助手 | 002/003/004 三合一：只在创作者主页作品页下滑采集 + 入队下载，面板上直接暂停/继续出队 |

002/003/004 三个"创作者作品归档助手"是同一套架构的三份实现（旁路抓包 + 面板采集 +
下载队列），字段/接口按平台各自适配，遇到的坑（CDN 直链要带登录态 Cookie、图集混入
兼容音轨、串页面标签采错数据……）后一个版本会把前一个版本踩过的坑直接内置修掉，
具体细节各看各的 README。

---

## 相关

- `dyd/` —— 老工具 DyD（Electron 版多平台短视频下载器）的逆向分析与去混淆源码；
  `002KuaishouCreatorArchiver` 的快手解析分支即移植自 `dyd/src-deobfuscated/service/ks.annotated.js`，
  `003DouyinCreatorArchiver`/`004TikTokCreatorArchiver` 的 Cookie/Referer 下载头方案参考自
  `dyd/src-deobfuscated/service/dy.js`/`tk.js`；设计取舍见 `dyd/方案分析.md`。

<!--
002/003/004 短视频归档插件分析与合并架构方案：

一、三个插件各领域现状、存在问题与预解决方案
1. 暂停机制（仅暂停出队，不中断传输）：
   - 现状：background.js（003:384, 004:412）中 paused=true 仅阻断从 queue 出队，在途 inflight 请求由 Chrome 自然完成，底层逻辑符合需求。
   - 存在问题：该暂停仅由 popup.js 触发；页面悬浮面板（content.js）完全没有暂停/继续出队按钮，无法在网页端直接干预；002 甚至未在 popup 中提供按钮，必须进入独立 app.html。
   - 预解决方案：在悬浮面板中直接接入 pauseQueue 与 resumeQueue 消息，提供一键切换按钮。

2. 功能界面割裂（悬浮面板 vs Popup）：
   - 现状：003/004 的 Popup 拥有暂停/继续/清空控制和总计数，但脱离主浏览页；页面悬浮面板拥有采集和入队功能，但入队后无控制权；002 则将控制拆分到了独立控制台 app.html。
   - 存在问题：用户 90% 的交互在网页悬浮面板，操作权与状态查看却被割裂在 Popup 或二级标签页中。
   - 预解决方案：将 Popup 的出队控制行（暂停/继续/清空）与数字状态直接合并到页面悬浮面板，统一操作入口，弱化或对齐 Popup。

3. 状态反馈（无需进度条，需数字与按钮联动）：
   - 现状：点击「下载全部」后仅展示单次静态提示（003/content.js:619）；background.js（003:230）广播了 stats 但 content.js 零接收。
   - 存在问题：出队、下载成功、失败、剩余排队数量在页面面板上完全没有后续回显；面板无法感知当前队列是否处于暂停状态。
   - 预解决方案：content.js 监听后台 stats 与 paused 广播，面板展示简单文本（排队: X · 完成: Y · 失败: Z），并动态切换按钮文案（⏸ 暂停出队 / ▶ 继续出队）。

4. 流控（出队节奏）：
   - 现状：003/background.js:13-14 将 concurrency 写死为 2，betweenMs 写死为 1500ms。
   - 存在问题：缺少带宽让渡手段，并发下载大视频时会抢占用户正常浏览网页的下行带宽。
   - 预解决方案：在页面面板提供暂停出队按钮，当用户需要带宽时手动一键挂起后续出队。

二、一对多合并架构方案
1. 公共核心层（Core）：
   - 统一调度引擎（core/background_queue.js）：复用 q:<seq> 存储结构；仅暂停出队（paused 拦截 pump 出队，在途 inflight 自然下载完毕）；统一支持继续出队与清空队列。
   - 统一交互面板（core/ui_panel.js）：以 Shadow DOM 注入页面右下角，合并原 Popup 的控制功能，提供自动采集、下载全部、出队控制行（⏸ 暂停出队 / ▶ 继续出队 / 🗑 清空）与简单数字反馈（排队: X · 完成: Y · 失败: Z），消除 Popup 与悬浮面板的界面割裂。
   - 统一存储与去重（core/storage.js）：规范去重键命名空间与各平台子保存目录。
2. 平台适配层（Adapters）：
   - 快手/抖音/TikTok 各自独立实现数据提取解析器（Parser，输出统一 Work 对象结构）。
   - 各自独立配置平台 CDN 域名与 declarativeNetRequest 请求头规则。

三、潜在问题与预计踩坑点
1. declarativeNetRequest 规则 ID 冲突：多平台规则共存时，必须对 Rule ID 分段隔离（如快手 1000+、抖音 2000+、TikTok 3000+），防止更新 Session Cookie 规则时互相覆盖。
2. 去重键全局冲突：storage.local 中的已下载标记必须加平台前缀，统一规范为 dl:<platform>:<videoId>，防止跨平台同名 ID 误判去重。
3. 宿主网页 CSS 污染：悬浮面板必须严格使用 Shadow DOM（attachShadow）隔离，防止宿主页面的 reset 样式破坏面板外观。
4. CSP 与脚本注入差异：统一在 manifest.json 中使用 world: "MAIN" 声明 content_scripts，彻底废弃动态创建 <script> 标签的降级逻辑，避免触发抖音/TikTok 的 Trusted Types / CSP 拦截报错。
5. 网络规则隔离：declarativeNetRequest 的 requestDomains 必须严格限制在各自平台的 CDN 域名内，防止跨平台携带登录态 Cookie 导致安全风险。
-->

