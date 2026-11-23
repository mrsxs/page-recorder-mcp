---
type: integration
title: MCP 工具与结果处理
description: 桥接如何把脚本库暴露成固定工具和动态接口工具，脚本库变大时如何按需查找，以及大结果如何压缩、缓存并通过 read_result 读取。
tags: [mcp, tools, search-apis, read-result, rest-api]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T04:07:50.896Z
sources:
  - id: openwiki-source-f22365b596e25ba4bf7c6003
    resource: repo://background.js
  - id: openwiki-source-3fc1bc0b476b9611eb76c9de
    resource: repo://bridge/server.js
  - id: openwiki-source-8c1ba99b77babe61c62d4e7e
    resource: repo://bridge/updater.js
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-17093eceaca38426b9664efa
    resource: repo://skills/page-recorder/SKILL.md
generated: { by: "claude-code", at: "2026-11-23T04:07:50.896Z" }
---

# MCP 工具与结果处理

`bridge/server.js` 把扩展脚本库转换成 AI 可调用的接口。协议处理集中在 `handleRpc`，工具执行集中在 `callTool`。stdio 和 `/mcp` 共用这两层，差别由 `ctx.via` 表示。

## 工具列表

### 固定工具

`STATIC_TOOLS` 始终存在：

| 工具 | 用途 |
|---|---|
| `list_recordings` | 列出脚本，放不下时改成分页概要 |
| `search_apis` | 按关键词跨脚本查接口 |
| `get_recording` | 取步骤、参数和接口详情 |
| `run_recording` | 运行脚本，支持 `auto`、`api`、`ui` |
| `call_api` | 直接调用一个接口 |
| `read_result` | 从已保存结果里取一部分，不重新调用接口 |
| `get_script` | 分段读取导出脚本，或写成本机文件 |
| `save_api_docs` | 把接口说明写回脚本库 |
| `export_package` / `import_package` | 导出、导入录制包 |

### 动态工具

`dynamicTools` 为每个脚本生成一个 `<脚本>__run`，并为每个接口生成一个 `<脚本>__<函数名>`。工具名限制在 64 个字符内，重名时追加序号。

动态工具总数超过 `MAX_TOOLS`（默认 30，可用 `--max-tools` 或 `PR_MAX_TOOLS` 修改）时，`tools/list` **一个都不列**。这样 AI 不会把“只列了一部分”误认为其余接口不存在。此时名字映射 `dynamicMap` 仍然保留，已知名字的工具照样能调用，新调用方应走 `search_apis` + `call_api`。

`tools/list` 最多等扩展 6 秒，因为部分客户端约 10 秒就超时。超时先返回固定工具，列表晚到后暂存并发出 `tools/list_changed`，客户端再次拉取时直接使用。

### 按需查找

`search_apis` 在函数名、接口名、用途、脚本名、参数名和参数说明中按权重打分：

- 同时匹配所有关键词的结果优先。没有全匹配时才返回部分匹配，并在 `note` 中说明。
- 中文连写词没有分词，3 字及以上的词会拆成相邻两字，命中过半算半分匹配。
- 返回的 `recording_id` 和 `api` 可以原样传给 `call_api`。接口名超过 300 字符时，`api` 改放函数名，截短的原名放在 `api_name`，避免填回时对不上。
- 多浏览器时结果带 `browser`（`instanceId`），因为资料名可能重复。

`list_recordings` 的 `query` 是**筛选**，要求所有关键词都命中，不会退到部分匹配。

## 结果处理

`run_recording`、`call_api` 和动态工具的结果都经过 `aiText`：

1. **展开 JSON 字符串**：最多展开 4 层，位置记在 `_decoded_json_strings`。需要原文时用 `read_result` 加 `raw: true`。
2. **小结果整段返回**：默认上限 24000 字符，可用 `PR_RESULT_CHARS` 或 `result_max_chars` 调整。
3. **大结果给预览和 `result_id`**：按结构压缩，数组只留开头几项，长文本截短，省略处写明路径。`ok`、`error`、`status`、`code` 这类状态字段优先保留。
4. **按需取值**：`read_result` 或调用时的 `result_path`、`result_fields`、`result_offset`、`result_limit` 只取需要的部分。

### 结果缓存的边界

- 最多保留最近 30 次结果，每条保留 30 分钟，总量默认不超过 64MB（`PR_RESULT_CACHE_MB`）。
- 单条超过总量上限时不缓存，此时没有 `result_id`，要在调用时直接带 `result_path`。
- 缓存位于**处理这次 RPC 的进程**内。stdio 模式下就是 MCP 进程本身，它重启后 `result_id` 失效，所以每条消息都重启 MCP 的客户端读不到上一条消息的结果。
- `result_path` 写错时不报调用失败，而是返回错误、预览和 `result_id`。接口已经执行过，提交类接口不能因为路径写错再执行一次。

### 参数名冲突

接口自己有 `result_limit` 这类同名字段时，名字归接口。`resultNames(own)` 会把这些字段从结果参数中排除，它们照常发给接口。

### 大块元数据

- `get_recording` 超过上限时返回概要、接口目录和 `result_id`，单个接口用 `read_result` 取 `path: "apis[i]"`。
- `get_script` 按行分段，开头注释写明总行数和下一段的 `start_line`。`to_file: true` 写到 `~/.page-recorder/exports/`，经 HTTP 调用时需要本机认证，详见[凭据处理与信任边界](../security/credentials-and-trust.md)。

## REST 与 MCP 的差异

REST 路由不经过 `aiText`，`/api/recordings/:id/run` 和 `/call` 返回完整原始结果。它们适合脚本集成，不适合直接喂给上下文有限的模型。

| 能力 | MCP | REST |
|---|---|---|
| 列表 | `list_recordings` | `GET /api/recordings` |
| 详情 | `get_recording` | `GET /api/recordings/:id` |
| 运行 | `run_recording` | `POST /api/recordings/:id/run` |
| 调用 | `call_api` | `POST /api/recordings/:id/call` |
| 写说明 | `save_api_docs` | `POST /api/recordings/:id/docs` |
| 导出 | `export_package` | `GET /api/recordings/:id/package` |
| 导入 | `import_package` | `POST /api/packages`（必须设置 token） |

## 协议版本

`initialize` 只回显 `MCP_VERSIONS` 中支持的版本，否则回最新支持版本。这些版本都带 `initialize` 握手，服务不声明自己没有实现的协议版本。

## 面向 AI 的技能

`skills/page-recorder/SKILL.md` 是可选技能，规定 AI 的使用顺序：先摸清接口，再改参数直接请求，被拒时让页面自己发，最后把结论写回接口说明。修改工具行为时要同步检查这份说明。运行模式和失败状态见[运行路由、直接请求与校准](../replay/execution-routing.md)。

技能里的失败处理按第一条命中的规则走：

| 结果 | 技能要求 AI 做什么 |
|---|---|
| `unknown: true`，或 5xx、408、429 | 先查询确认结果，提交类接口确认没生效后才重发 |
| `notSent: true` | 按 `error` 补参数，或让页面自己发 |
| `writeRejected: true` | 先查询确认，确认没生效后才让页面自己发 |
| 401、403，且有 `omittedHeaders` | 让页面发一次，拿到最新的鉴权头再直接请求 |
| 其余 401、403 | 让页面自己发 |
| `rejected: true`，或业务返回码和录制时不同 | 查询类接口让页面自己发，提交类接口先确认没生效 |

`writeRejected` 只由 `run_recording` 的直接请求返回。`call_api` 没有这个字段，所以技能对 `rejected` 单独要求提交类接口先确认。

技能文件随 npm 包发布，已安装到 WorkBuddy 或 Claude Code 的副本由桥接自动更新，见[扩展与技能自动更新](../operations/auto-update.md)。

## 相关测试

- `test/tools.test.mjs`：工具上限、`search_apis`、分页、长接口名和多浏览器回填。
- `test/result.test.mjs`：预览长度、路径读取、缓存上限、`get_recording`、`get_script` 和导入导出。
- `test/smoke.test.mjs`：协议版本协商和 `tools/list` 等待行为。

另见[桥接服务生命周期与连接](./server-lifecycle.md)、[弹窗、脚本库与 AI 解读](../extension/library-and-ai-docs.md)。
