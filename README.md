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
  docs/                     跨扩展的经验文档（踩坑记录、逆向方法）
  dyd/                      逆向参考资料
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
| 005 | `005ShortVideoCreatorArchiver` | 短视频创作者作品归档助手 | 快手 / 抖音 / TikTok：在创作者主页下滑采集作品，一键入队批量下载 |

002（快手）、003（抖音）、004（TikTok）三个单平台归档助手已合并进 005，旧代码见 git 历史
（`git log -- 003DouyinCreatorArchiver/`）。序号不复用。

---

## 文档与参考

- `docs/踩坑记录.md` —— 002 → 005 一路实际踩过的坑（采集混入、`.html` 直链、写盘、下载记录膨胀……），
  做新平台之前先过一遍；
- `docs/逆向与分析方法.md` —— 怎么分析一个平台的网页、怎么逆向别人的下载工具、怎么给 005 加平台，
  以及小红书 / 视频号的预研笔记；
- `dyd/` —— 老工具 DyD（Electron 版多平台短视频下载器）的逆向资料：方案分析、逆向报告、去混淆工具，
  以及还没做过的小红书、视频号部分。
