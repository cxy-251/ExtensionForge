# dyd —— 逆向参考资料

老工具 DyD（Electron 版多平台短视频下载器 v3.0.3）的逆向分析。抖音、快手、TikTok 的部分已经
吸收进 `../005ShortVideoCreatorArchiver`，这里只留还用得上的：

| 文件 | 用途 |
|---|---|
| `方案分析.md` | DyD「寄生浏览器 + 重放请求」方案的优缺点，以及和其它方案的对比 |
| `分析报告.md` | 逆向 DyD 的完整过程（解包、去混淆、模块地图、快手失效诊断） |
| `tools/` | `Extract-Asar.ps1` 解包 asar；`deobf2.js` + `polish.js` 还原 javascript-obfuscator 混淆 |
| `src-deobfuscated/service/ks.annotated.js` | 人工注释版的快手逻辑——「读懂别人代码后该整理成什么样」的范例 |
| `src-deobfuscated/service/xhs.js` | 小红书（还没做过的平台） |
| `src-deobfuscated/service/vx.js` | 视频号（依赖 DyD 作者的远程服务，仅作了解） |
| `src-deobfuscated/service/collection.js`、`common.js` | 看懂上面几个文件需要的公共部分 |

怎么用这些资料、小红书和视频号的预研结论，见 `../docs/逆向与分析方法.md`。

混淆原件、其余平台的去混淆代码、Electron 外壳部分已移除，需要时从 git 历史找：
`git log -- dyd/`。这是第三方软件的反编译代码，只用于学习参考。
