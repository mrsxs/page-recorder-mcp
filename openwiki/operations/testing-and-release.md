---
type: operations
title: 测试、CI 与发布
description: 项目的测试分层、假扩展和虚拟页面夹具、CI 矩阵、版本一致性检查、由标签触发的 npm 发布流程、发布包包含的文件，以及版本号如何触发用户侧自动更新。
tags: [testing, ci, release, npm, node-test]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T04:07:50.896Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-3fc1bc0b476b9611eb76c9de
    resource: repo://bridge/server.js
  - id: openwiki-source-8c1ba99b77babe61c62d4e7e
    resource: repo://bridge/updater.js
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-94fada3aaa8074a858b813c3
    resource: repo://test/persistence.test.mjs
  - id: openwiki-source-082a8c7ef223cd8c05964577
    resource: repo://test/result.test.mjs
  - id: openwiki-source-63085c83c53a27dea66bd9b4
    resource: repo://test/security-and-bugs.test.mjs
  - id: openwiki-source-dfd516e25729907b76c79f44
    resource: repo://test/smoke.test.mjs
  - id: openwiki-source-13204a94e0b770737b14cc15
    resource: repo://test/tools.test.mjs
generated: { by: "claude-code", at: "2026-11-23T04:07:50.896Z" }
---

# 测试、CI 与发布

项目没有运行依赖，也没有构建步骤。测试使用 Node 内置的 `node:test`，发布内容就是源码文件。

## 运行测试

```bash
npm test
```

`package.json` 里**显式列出**了测试文件：

```text
node --test test/smoke.test.mjs test/result.test.mjs test/tools.test.mjs test/params.test.mjs test/security-and-bugs.test.mjs test/persistence.test.mjs
```

新增测试文件时必须加到这条命令里，否则本地和 CI 都不会运行。

## 测试分层

| 文件 | 覆盖范围 | 方式 |
|---|---|---|
| `test/smoke.test.mjs` | 语法、版本一致、`extension` 子命令、桥接启动、后台 daemon、协议协商、token | 启动真实桥接进程，配合假扩展 |
| `test/result.test.mjs` | JSON 展开、预览、`read_result`、缓存上限、脚本分段、导入导出 | 真实桥接 + 假扩展 |
| `test/tools.test.mjs` | 工具上限、`search_apis`、分页、多浏览器 | 真实桥接 + 假扩展 |
| `test/params.test.mjs` | 参数命名稳定性、同名和覆盖规则 | 直接调用 `PR_EXPORTER.analyze` |
| `test/security-and-bugs.test.mjs` | 注入、脱敏、原型污染、回放令牌、世界隔离、HTTP 鉴权和请求限制 | exporter 直调、`node:vm` 运行时、真实桥接 |
| `test/persistence.test.mjs` | 脚本备份、删除、重装恢复、跨资料隔离、恢复来源校验、备份脱敏、写接口回退判定、扩展目录更新和回滚、技能更新、发布包内容 | 直接调用 `library.js`、`updater.js`、`exporter.js`，配合内存里的假浏览器和临时目录 |

### 测试夹具

- **假扩展**：测试用 `net.connect` 完成 WebSocket 握手，发送带掩码的帧和 `hello`，再按方法返回预设数据。这样不需要浏览器就能测完整的 MCP 到扩展调用链。
- **虚拟页面**：`createRuntimeEnv` 用 `node:vm` 构造最小的 `window`、`document`、`fetch`，加载 `lib/runtime.js`。录制通道测试用同样的方式同时加载 `hook.js` 和 `recorder.js`，并验证两种注入顺序。
- **隔离状态**：测试把 `PR_BRIDGE_DIR` 指到临时目录，不碰真实的 `~/.page-recorder`。端口随机选择，避免和正在运行的桥接冲突。
- **客户端进程**：daemon 自动退出测试用 `/usr/bin/perl` 扮演“启动 MCP 的程序”，没有 perl 的环境会跳过这项测试。

### 测试覆盖不到的地方

**`npm test` 不启动真实 Chrome。** 这些行为需要加载扩展后手动验证：

- MV3 service worker 的生命周期和 `chrome.*` API。
- 真实页面上的元素定位、组件库交互和真实输入。
- `webRequest` 补抓、跨域 iframe 选择和整页跳转续跑。
- 自动更新时 `chrome.runtime.reload()`、开发者模式、`onInstalled` 和打开页面重新注入的真实行为。
- Windows 上已解压扩展 ID 的计算结果是否和真实 Chrome 一致。

修改录制或回放逻辑时，单元测试通过不等于页面行为正确。

## CI

`.github/workflows/ci.yml` 在推送到 `main`、推送 `v*` 标签、PR 和手动触发时运行：

- 操作系统：Ubuntu、Windows、macOS。
- Node：18、22、24、26。
- `fail-fast: false`，一个组合失败不会取消其他组合。

`engines.node` 声明 `>=18`，所以代码不能使用 Node 18 没有的全局 API。测试里已有这类处理，例如自行提供 `CustomEvent`。

## 发布

**只有推送 `v*` 标签才会发布到 npm。** 合并到 `main` 时 `publish` 任务显示为跳过，线上版本不变。

```bash
# 1. 同时修改 package.json 和 manifest.json 的 version
# 2. 提交并合并
git tag v<版本>
git push origin v<版本>
```

发布任务的约束：

1. 依赖 `test` 任务，整个矩阵通过才会运行。
2. 标签必须等于 `v` + `package.json` 版本，否则失败。
3. 用 Node 24 执行 `npm publish --provenance --access public`，需要仓库密钥 `NPM_TOKEN` 和 `id-token: write` 权限。

`smoke` 测试会检查 `manifest.json` 与 `package.json` 版本一致，只改一个文件会导致测试失败。

**版本号也是用户侧自动更新的开关。** 桥接比较自己的版本和扩展上报的版本，只有更高才更新。扩展改动发布时必须提高版本号，否则用户不会收到新文件。详见[扩展与技能自动更新](./auto-update.md)。

## 发布包内容

`package.json` 的 `files` 白名单决定 npm 包内容：

- 包含：`bridge/`、`skills/`、`manifest.json`、`background.js`、`content/`、`inject/`、`lib/`、`popup/`、`icons/`、`README.md`、`LICENSE`。
- **不包含**：`test/`、`.github/`、`openwiki/`、`AGENTS.md`。

技能随 npm 包发布，桥接靠它更新已安装的副本。新增扩展运行需要的顶层文件时，要同时更新 `files` 和 `bridge/updater.js` 的 `EXTENSION_FILES`，`extension` 子命令和自动更新共用这个列表。

另见[快速上手与任务路由](../quickstart.md)、[桥接服务生命周期与连接](../bridge/server-lifecycle.md)、[扩展与技能自动更新](./auto-update.md)、[凭据处理与信任边界](../security/credentials-and-trust.md)。
