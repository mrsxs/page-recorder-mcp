---
type: operations
title: 桥接服务生命周期与连接
description: 桥接的 HTTP、stdio、后台 daemon 三种运行方式，扩展 WebSocket 连接和能力声明、连接后的同步与更新调度、多浏览器路由、实例间转发、自动退出机制，以及常见连接故障的判断方法。
tags: [bridge, daemon, stdio, websocket, troubleshooting]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T04:07:50.896Z
sources:
  - id: openwiki-source-f22365b596e25ba4bf7c6003
    resource: repo://background.js
  - id: openwiki-source-7958d1f6df0f69c0d4c3ff11
    resource: repo://bridge/library.js
  - id: openwiki-source-3fc1bc0b476b9611eb76c9de
    resource: repo://bridge/server.js
  - id: openwiki-source-8c1ba99b77babe61c62d4e7e
    resource: repo://bridge/updater.js
generated: { by: "claude-code", at: "2026-11-23T04:07:50.896Z" }
---

# 桥接服务生命周期与连接

`bridge/server.js` 是零依赖的 Node 程序入口，脚本备份和自动更新分别在同目录的 `library.js`、`updater.js`。它监听 `127.0.0.1:17321`（默认），一侧接 AI 工具，另一侧接浏览器扩展。

## 运行方式

| 启动命令 | 行为 | 何时退出 |
|---|---|---|
| `node bridge/server.js` | 前台监听 HTTP、MCP HTTP、REST 和 `/ext` | 收到信号或进程被结束。端口被占用时以退出码 1 结束 |
| `node bridge/server.js --stdio` | 复用已有桥接，没有就在后台拉起一个，自己只转发 | stdin 结束时退出 |
| `--stdio --no-daemon` | 不起后台进程，自己监听端口；端口被占用时转发给占用者 | stdin 结束时退出 |
| `--daemon`（内部使用） | 由 stdio 实例拉起的后台桥接 | 登记的启动程序全部退出后自动关闭 |
| `extension [目录]` | 把扩展文件复制到目录，并记下这个目录供自动更新使用 | 复制完成即退出 |

### stdio 为什么要拉起后台进程

有的 AI 客户端每条消息都重启一次 MCP 进程。如果端口跟着 MCP 进程走，扩展每次都要重连，最多等 30 秒。所以 stdio 实例按下面的顺序工作：

1. `ensureBridge` 探测 `/api/status`，端口上已有服务就复用。
2. 没有就 `spawnDaemon`，以 detached 方式启动 `--daemon` 进程，日志写到 `~/.page-recorder/bridge-<端口>.log`，然后最多等 3 秒。
3. 3 秒内没起来时，stdio 实例退回自己监听端口。
4. 成功后通过 `/api/events` 订阅变化，并向 `/api/owners` 登记自己和启动它的程序。

### 自动退出

后台桥接每 2 秒检查一次登记的 PID：

- 所有 owner 都退出后立即关闭。
- 启动后 30 秒内一直没有 owner 登记，也会关闭。

`ownerPid` 沿父进程链向上，跳过 `node`、`npx`、shell 等中间层，找到真正的程序。macOS 上按 `.app` 归并主进程和 Helper，所以每条消息重启 MCP 的客户端也会落到同一个主进程。

这意味着**没有 AI 工具运行时桥接本来就不在线**。日志最后一行是“启动桥接的程序都已退出，桥接关闭”时，这是正常结束，不是崩溃。

前台启动的 `node bridge/server.js` 不是 daemon，不走这套自动退出逻辑。

## 实例间转发

端口只能有一个进程持有。持有者叫 primary，其他实例通过 `forwardToPrimary` 把扩展调用 POST 到 `/api/ext`。

- 启动 primary 时生成随机 `SECRET`，写入 `~/.page-recorder/bridge-<端口>.json`（权限 `0600`），退出时删除。
- 转发请求带 `x-page-recorder-secret`。`/api/ext` 和 `/api/owners` 只接受这个口令。
- 转发时遇到 `ECONNREFUSED`（后台桥接已退出），stdio 实例会重新拉起桥接并再发一次。

## 扩展连接

扩展主动连接 `settings.bridgeUrl`，桥接不主动连扩展：

1. MV3 service worker 用周期 0.5 分钟的 `chrome.alarms` 触发 `bridgeConnect`。
2. 连接成功后发送 `hello`，带扩展版本、`instanceId`、资料名和 `capabilities`，之后每 20 秒发一次 `ping`。
3. 桥接按 `instanceId` 登记连接。3 秒内没收到 `hello` 时按匿名实例处理，用来兼容旧版扩展。
4. 登记后，桥接安排一次脚本库同步和一次自动更新检查。

`capabilities` 目前有 `librarySync` 和 `selfUpdate`。旧版扩展不声明，桥接就不向它发备份和更新方法。扩展重新加载后由 `onInstalled` 立即重连，不用等下一次定时器。

WebSocket 由桥接手写实现，遵守这些限制：

- 客户端帧必须带掩码，RSV 位必须为 0，单条消息最大 64MB。
- 最多同时保留 32 个 WebSocket 连接。
- 同一 `instanceId` 重连时替换旧连接，旧连接上的请求以明确错误结束，提示调用方重试。
- 一个 `instanceId` 首次登记后绑定扩展来源，其他扩展来源不能冒用。

## 多浏览器路由

每个 Chrome 用户资料里的扩展是一个实例，可以同时在线。`extCall` 按下面的规则选连接：

- 传了 `browser`：按 `instanceId`、资料名、忽略大小写的资料名依次查找。资料名重名时报错，要求改用 `instanceId`。
- 只有一个实例：直接发送。
- 多个实例且调用带录制：按 id、完整名称、名称包含三级查找拥有者。同一级命中多个实例时报歧义错误。
- `importPackage` 不属于某个录制，多实例时必须指定 `browser`。

指定的浏览器如果最近 10 分钟内连过，桥接会等它重连，最多 35 秒；从未见过的名字立即报错。

## 备份和自动更新的调度

| 工作 | 在哪个进程运行 | 触发时机 |
|---|---|---|
| 脚本库同步 | 持有扩展 WebSocket 的 primary | 扩展登记后、收到 `libraryChanged` 后，防抖 300ms |
| 自动更新 | 每个开启了自动更新的桥接进程，转发实例通过 `/api/status` 查询浏览器 | 进程就绪 500ms 后、扩展登记或脚本库变化后 1.5 秒；扩展忙时 60 秒后再试 |

自动更新在这些情况下不运行：

- 启动时带 `--no-auto-update`，或设置了 `PR_AUTO_UPDATE=0`。
- 从带 `.git` 的源码目录运行，除非设置 `PR_AUTO_UPDATE=1`。

`spawnDaemon` 会把 `--no-auto-update` 传给自己拉起的后台桥接，也继承环境变量。**这两个开关都不影响已经在运行的后台桥接**：别的 AI 工具先起了桥接时，要用扩展设置里的开关才能全局关闭。

恢复脚本的请求只接受最近一次发给这个连接的来源，且来源当前不在线，见[脚本库本机备份与恢复](./library-backup.md)。

新版 stdio 实例复用端口上的旧版桥接时，旧版 `/api/status` 不返回 `extensionId` 和 `capabilities`，所以这时不会发生扩展更新。备份也要等新版桥接持有端口后才开始。

详见[脚本库本机备份与恢复](./library-backup.md)和[扩展与技能自动更新](../operations/auto-update.md)。

## 故障判断

| 现象 | 含义 | 处理 |
|---|---|---|
| 扩展控制台 `ws://127.0.0.1:17321/ext` 报 `ERR_CONNECTION_REFUSED` | 端口上没有桥接，扩展在定时重连 | 启动桥接，或让配置了 stdio MCP 的 AI 工具运行起来 |
| 日志：`启动桥接的程序都已退出` | 后台桥接按设计退出 | 同上，需要常驻时用前台方式运行 |
| 工具报 `浏览器扩展未连接` | 桥接在，但 35 秒内没有实例连上 | 确认 Chrome 已打开、扩展已启用、设置里开启桥接且地址正确 |
| 日志：`端口 … 已被另一个桥接实例占用` | 另一个进程占着端口 | stdio 实例会自动转发。前台模式会退出，需要先停掉占用者 |
| WebSocket 握手 403 | 非扩展来源、Host 不合法、扩展不在白名单或 token 不对 | 设置 token 时桥接地址要写成 `ws://…/ext?token=<口令>` |
| 改了代码但行为没变 | 旧桥接或旧扩展还在运行 | 重启桥接，并在 `chrome://extensions` 重新加载扩展 |
| 发了新版但扩展没更新 | 旧桥接占着端口、扩展目录不符合条件，或扩展正忙 | 看 `/api/status` 的版本和 `capabilities`，再按[自动更新排查](../operations/auto-update.md#排查)处理 |

查看实时状态：

```bash
curl http://127.0.0.1:17321/api/status
```

返回里的 `extensionConnected`、`browsers[].version`、`browsers[].extensionId`、`browsers[].capabilities` 和 `pid` 可以判断连接状态、运行的版本以及扩展支持哪些新能力。

## 相关测试

`test/smoke.test.mjs` 覆盖后台桥接的复用和自动退出、`--no-daemon` 的工具列表、token 下的扩展连接，以及非本机地址未设 token 时拒绝启动。

另见 [MCP 工具与结果处理](./mcp-tools-and-results.md)、[凭据处理与信任边界](../security/credentials-and-trust.md)、[测试、CI 与发布](../operations/testing-and-release.md)。
