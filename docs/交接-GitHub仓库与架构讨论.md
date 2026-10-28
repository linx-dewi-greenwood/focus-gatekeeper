# 交接：GitHub 仓库与架构设计讨论

2026-10-26 · 给新任务的背景说明。产品设计见同目录 `产品设计文档.md`。

## 要讨论的问题

1. **上 GitHub**：仓库结构、公开还是私有、许可证、`.gitignore`、README、版本号与发布方式（扩展打包、中控安装包）、是否加 CI 跑测试。
2. **架构设计**：现在的“中控 + 适配器”结构哪些地方要在上仓库前理顺（见下方“已知的架构问题”）。

## 项目现状

本地路径：`D:\桌面\项目\Focus`（Windows 11，Node.js v24，Chrome）

```
Focus\
├─ extension\          浏览器扩展 v0.2.1（Chrome / Edge，Manifest V3）
│  ├─ engine.js        规则引擎：主线、岔路栈、四象限、置换额度、计时、切换分类（扩展和中控共用）
│  ├─ background.js    浏览器适配器：标签页切换检测、连接中控、单机模式
│  ├─ content.js       网页里的卡片和角标（中控的卡片/角标窗口也直接加载它）
│  ├─ popup.*          扩展弹窗（中控的控制面板也直接加载它）
│  └─ manifest.json、icons\
├─ hub\                中控 v0.1.0（Electron 44.5.0）
│  ├─ src\main.js      主进程：窗口、托盘、Alt+B、断网检测
│  ├─ src\core.js      核心：状态文件、计时、应用切换判断、WebSocket 服务（纯 Node，可单测）
│  ├─ src\watcher.js + fgwatch.ps1   前台窗口检测（常驻 PowerShell + 内嵌 C#，Win32 API）
│  ├─ ui\*.html + shim.js            中控窗口；shim 用 IPC 模拟 chrome.* 让扩展界面代码复用
│  ├─ test\core.test.js              21 项测试（npm test）
│  └─ package.json、.gitignore（node_modules、package-lock.json）
├─ docs\               产品设计文档、本交接文档、图
├─ README.md           安装与使用说明
├─ 启动中控.bat / 启动中控（无窗口）.vbs
```

运行：`cd /d "D:\桌面\项目\Focus\hub" && npm install && npm start`；扩展在 `chrome://extensions` 加载 `extension\`。

## 已定的设计决定

- 中控是唯一状态中心；扩展连上 `ws://127.0.0.1:47321` 时把状态和计时交给中控，断开时退回单机。WebSocket 只接受 `chrome-extension://` 等扩展来源，拒绝网页。
- 规则只写一份（`extension/engine.js`），中控用 `require('../../extension/engine.js')` 引用。
- 前台窗口检测不用原生 npm 模块，用 `powershell.exe -EncodedCommand` 跑内嵌 C#，避免用户装编译工具。
- 窗口标题不保存，只存进程名和域名；数据只在本机（中控状态 `%APPDATA%\focus-hub\state.json`）。
- 岔路四象限、2 小时内最多置换一次、四档提醒强度、切换分四类（必要 / 突发 / 拦下的分心 / 分心，未回答的按停留 2 分钟预判，小结可改并“记住”）。

## 已知的架构问题（上仓库前值得讨论）

- **跨目录引用**：中控从 `../../extension/` 加载 engine、content、popup。能跑，但打包中控安装包时这些文件不在 hub 里；可考虑 monorepo + `packages/engine` 共享包，或构建时复制。
- **package-lock.json 被忽略**：当前 `.gitignore` 忽略了它，上仓库时应提交 lock 文件以锁定依赖。
- **Electron 版本**：锁定 44.5.0，`npm install` 报 2 个 high 漏洞，应升到 44.x 最新补丁版。
- **只有中控核心有自动测试**：引擎没有独立单测；扩展的端到端测试（Playwright）只在开发环境里跑过，没放进仓库。
- **没有打包**：中控靠 `npm start` 运行；扩展靠“加载已解压”。发布需要 electron-builder 之类和扩展 zip。
- **单一浏览器连接**：Chrome 和 Edge 同时装扩展时只认最后连上的一个。
- **状态模型**：所有状态在一个 JSON 对象里（engine 的 `DEFAULT_STATE`），历史最多 30 条；设计文档里的“数据模型”一节是早期设想的表结构，与现状不一致，需要更新其一。
- **待用户在 Windows 上验证**：“返回”时最小化分心窗口并切回原窗口。v0.1 用过 `AttachThreadInput`，在真机上把 VS Code 和 Claude 一起冻住了；已改为不阻塞的 `ShowWindowAsync` + 模拟 Alt 键 + `SetForegroundWindow`（失败时 `SwitchToThisWindow`），每条命令单独开线程，还需真机确认。
- **冻结 bug 的真正原因（已修）**：卡片上的“关闭/好，继续/知道了”按钮写成 `onclick: clearCard`，点击事件被当成 `silent` 参数，中控卡片窗口没被隐藏，留下一层透明、置顶、全屏的窗口挡住其他程序。已修复，并且卡片窗口改为只和卡片一样大，主进程每 1.5 秒检查可见窗口里有没有卡片。
- **全屏卡片的安全措施**：所有卡片都能用 Esc 关闭（提问卡 Esc = 返回），Alt+Shift+B / 托盘菜单强制关闭，卡片窗口无响应或崩溃时自动隐藏并重载。原则：中控的全屏窗口任何时候都不能把用户困住。

## 设计文档里的待决问题

- 置换主线后，被挂起的原主线剩余时间保留还是重填（现在：恢复时重填，默认原时长一半）。
- 断网之外还有哪些突发情况值得自动识别（IDE 报错、电量低）。
- 严格档是否直接显示“属于（需确认）”按钮。
