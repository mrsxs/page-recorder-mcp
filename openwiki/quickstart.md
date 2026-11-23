---
type: guide
title: 快速上手与任务路由
description: 面向 Page Recorder 开发者的入口：项目概况、从源码运行扩展和桥接、验证改动的方法，以及按开发任务定位 wiki 页面和源码。
tags: [quickstart, development, routing, onboarding]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T04:07:50.896Z
sources:
  - id: openwiki-source-f22365b596e25ba4bf7c6003
    resource: repo://background.js
  - id: openwiki-source-3fc1bc0b476b9611eb76c9de
    resource: repo://bridge/server.js
  - id: openwiki-source-7ff5f61fb83168bee1eea6fa
    resource: repo://lib/runtime.js
  - id: openwiki-source-b25e71362ad2d0521bb4e04c
    resource: repo://manifest.json
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-082a8c7ef223cd8c05964577
    resource: repo://test/result.test.mjs
  - id: openwiki-source-63085c83c53a27dea66bd9b4
    resource: repo://test/security-and-bugs.test.mjs
generated: { by: "claude-code", at: "2026-11-23T03:12:21.110Z" }
---

# 快速上手与任务路由

Page Recorder 是一个 Chrome MV3 扩展加一个零依赖的本地桥接。扩展录制用户在已登录页面上的操作和接口，桥接通过 MCP 或 REST 让 AI 工具回放这些操作或直接调用接口。用户手册在仓库根目录的 `README.md`，这里只讲开发。

## 代码地图

| 路径 | 职责 |
|---|---|
| `manifest.json` | 权限和内容脚本注入 |
| `inject/hook.js` | 页面 MAIN world 的请求钩子 |
| `content/recorder.js` | 操作录制和语义步骤 |
| `background.js` | 状态、脚本库、运行路由、真实输入、桥接连接 |
| `lib/exporter.js` | 分析、参数关联、脱敏、导出 |
| `lib/runtime.js` | 回放引擎和接口直调，会原样嵌入导出脚本 |
| `popup/` | 扩展界面 |
| `bridge/server.js` | MCP、REST、WebSocket、后台进程 |
| `bridge/library.js` | 脚本库同步到 `~/.page-recorder/library/`，重装后恢复 |
| `bridge/updater.js` | 自动更新扩展目录和已安装的技能 |
| `skills/page-recorder/SKILL.md` | 给 AI 的使用说明，随 npm 包发布 |
| `test/` | Node 测试 |

系统如何配合见[系统架构总览](./architecture/system-overview.md)。

## 从源码运行

需要 Node 18 或更高版本，不用 `npm install`，也没有构建步骤。

```bash
# 1. 启动桥接（前台运行，不会自动退出）
node bridge/server.js

# 2. 确认状态
curl http://127.0.0.1:17321/api/status
```

加载扩展：

1. 打开 `chrome://extensions`，开启开发者模式。
2. 点“加载已解压的扩展程序”，选择仓库根目录。
3. 刷新要录制的页面。扩展加载之前打开的页面没有注入内容脚本。

扩展最多约 30 秒连上桥接，弹窗右上角显示“桥接 ●”。没有桥接时，扩展控制台的 `ERR_CONNECTION_REFUSED` 是定时重连的正常现象。

把本地代码接入 Claude Code：

```bash
claude mcp add -s user page-recorder -- node /绝对路径/bridge/server.js --stdio
```

stdio 模式会按需拉起后台桥接，启动它的程序都退出后桥接自动关闭。详见[桥接服务生命周期与连接](./bridge/server-lifecycle.md)。

从带 `.git` 的源码目录运行时，桥接默认不自动更新，但脚本库备份照常写入 `~/.page-recorder/library/`。开发时不想碰真实数据，可以用 `PR_BRIDGE_DIR` 指向临时目录。

## 改动后如何生效

| 改了什么 | 需要做什么 |
|---|---|
| `bridge/*` | 重启桥接进程 |
| `background.js`、`lib/*`、`manifest.json` | 在 `chrome://extensions` 重新加载扩展 |
| `content/recorder.js`、`inject/hook.js` | 重新加载扩展，并**刷新目标页面** |
| `popup/*` | 重新打开弹窗 |

## 验证

```bash
npm test
```

测试使用假扩展和 `node:vm`，**不启动真实 Chrome**。改录制、回放、组件驱动时，还要加载扩展在真实页面上验证。新增测试文件必须写进 `package.json` 的 `test` 命令。详见[测试、CI 与发布](./operations/testing-and-release.md)。

## 按任务定位

| 我要做什么 | 先读 | 主要源码 |
|---|---|---|
| 抓不到某类请求、请求重复 | [录制与请求捕获管线](./recording/capture-pipeline.md) | `inject/hook.js`、`background.js` 的 `netFlush` |
| 某个控件录成了多余的点击 | [录制与请求捕获管线](./recording/capture-pipeline.md) | `content/recorder.js` 的 `onFieldsChanged` |
| 接口被拆错或合并错 | [录制分析、参数关联与产物](./recording/analysis-and-parameters.md) | `lib/exporter.js` 的 `analyze`、`opOf` |
| 字段没关联到输入参数 | [录制分析、参数关联与产物](./recording/analysis-and-parameters.md) | `lib/exporter.js` 的 `linkOne` |
| 回放点错或找不到元素 | [页面回放运行时](./replay/runtime-engine.md) | `lib/runtime.js` 的 `locate`、`pointFor` |
| 日期或下拉回放失败 | [页面回放运行时](./replay/runtime-engine.md) | `lib/runtime.js` 的 `pickDateInner`、`pickChoice` |
| 为什么走了页面回放 | [运行路由、直接请求与校准](./replay/execution-routing.md) | `background.js` 的 `runRecording` |
| 直接请求 401、403 或被判失败 | [运行路由、直接请求与校准](./replay/execution-routing.md) | `lib/runtime.js` 的 `call`、`background.js` 的 `watchLiveRequest` |
| 新增或修改 MCP 工具 | [MCP 工具与结果处理](./bridge/mcp-tools-and-results.md) | `bridge/server.js` 的 `STATIC_TOOLS`、`callTool` |
| 结果太大或 `read_result` 异常 | [MCP 工具与结果处理](./bridge/mcp-tools-and-results.md) | `bridge/server.js` 的 `aiText` |
| 桥接连不上或自动退出 | [桥接服务生命周期与连接](./bridge/server-lifecycle.md) | `bridge/server.js`、`~/.page-recorder/*.log` |
| 改弹窗、脚本库或 AI 解读 | [弹窗、脚本库与 AI 解读](./extension/library-and-ai-docs.md) | `popup/popup.js`、`background.js` |
| 脚本丢失、恢复失败、删除后又出现 | [脚本库本机备份与恢复](./bridge/library-backup.md) | `bridge/library.js`、`background.js` 的 `restoreLibItem` |
| 扩展或技能没自动更新 | [扩展与技能自动更新](./operations/auto-update.md) | `bridge/updater.js`、`background.js` 的 `updateBusy` |
| 涉及凭据、权限或新的输入来源 | [凭据处理与信任边界](./security/credentials-and-trust.md) | `lib/exporter.js`、`background.js`、`bridge/server.js` |
| 发布新版本 | [测试、CI 与发布](./operations/testing-and-release.md) | `package.json`、`manifest.json`、`.github/workflows/ci.yml` |

## 改代码前要记住

- `lib/runtime.js` 的主函数必须自包含，不能引用外部变量或扩展 API。
- 参数名和接口名是已保存脚本的兼容性契约，改规则前先看 `test/params.test.mjs`。
- `recorder.js` 和 `runtime.js` 各有一份元素上下文算法，单选规则在三个文件中各有实现，修改时要同步。
- 页面事件和导入的录制包都是不可信输入。
- 提交类接口结果未知时不能自动重试，这是运行路由的核心约束。
- 发布扩展改动必须提高版本号，否则用户侧不会自动更新。
- 新增后台长任务要纳入 `updateBusy`，否则可能被自动更新打断。
- 新字段进入脚本前，先确认它可以长期保存在本机备份里。
