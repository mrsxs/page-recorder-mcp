---
type: feature
title: 弹窗、脚本库与 AI 解读
description: 扩展弹窗如何读取和编辑录制，当前录制如何同步到脚本库和本机备份，重装后如何恢复，AI 解读任务如何在 MV3 后台运行，以及录制包导入导出的脱敏和校验规则。
tags: [popup, library, ai-docs, package, storage]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T03:12:21.110Z
sources:
  - id: openwiki-source-f22365b596e25ba4bf7c6003
    resource: repo://background.js
  - id: openwiki-source-7c47ddfa0668cdae5410afcf
    resource: repo://lib/exporter.js
  - id: openwiki-source-729b0761ea4ceafd92c10f6f
    resource: repo://popup/popup.js
generated: { by: "claude-code", at: "2026-11-23T03:12:21.110Z" }
---

# 弹窗、脚本库与 AI 解读

弹窗是录制数据的编辑界面，权威状态在 `background.js`。弹窗通过 `chrome.runtime.sendMessage` 发命令，每 800ms 用 `getData` 轮询一次，所以关掉再打开不会丢状态。弹窗同时加载 `lib/exporter.js`，接口列表和导出内容都在本地由 `PR_EXPORTER` 现算。

## 存储模型

数据放在 `chrome.storage.local`：

| 键 | 内容 |
|---|---|
| `state` | 当前录制的状态、起始页和元数据 |
| `events` | 当前录制的步骤和请求 |
| `apiOverrides` | 用户手动改过的接口字段 |
| `aiDocs` | 接口函数名、用途、参数说明和 `ignore` 标记 |
| `settings` | 录制、回放、AI、桥接设置，包括 AI API Key |
| `libIndex` | 脚本库索引，用于快速列表 |
| `lib:<id>` | 一条完整脚本 |
| `libDeleted` | 已删除脚本的 id 和时间，最多 1000 条，用来把删除同步到本机备份 |
| `aiStatus` | AI 解读任务的进度或错误 |

普通写入有 400ms 防抖，关键操作用 `persist(true)` 立即写入。录制中输入的密码不在这里，它只放在内存和 `chrome.storage.session`，详见[凭据处理与信任边界](../security/credentials-and-trust.md)。

这些数据跟着扩展 ID 走。连上桥接后，脚本库还会同步一份到 `~/.page-recorder/library/`，见[脚本库本机备份与恢复](../bridge/library-backup.md)。

## 当前录制和脚本库

“当前录制”是正在编辑的工作副本，脚本库保存多条完成的录制：

- 停止录制时自动调用 `syncLibrary`，用录制 id 写入或更新条目。
- 未在录制时，删除步骤、改参数、设可选、改名、改接口字段或 AI 文档也会同步到脚本库。
- 事件被删光时，对应的脚本库条目也会删除，避免还能运行旧步骤。这种删除和弹窗里的删除都会写入 `libDeleted`。
- `libOpen` 把脚本载入为当前录制，录制进行中不允许。
- 脚本库变化时通过 `bridgeNotify('libraryChanged')` 通知桥接，桥接再通知 AI 工具刷新工具列表，并同步本机备份。

名称优先级是：用户手动命名、AI 建议标题、页面标题或域名加录制时间。

## 弹窗功能

### 时间线

时间线显示步骤和请求。语义步骤（设置日期、选择选项、双击）通过 `members` 和 `groupedIn` 管理原始点击，成员默认折叠。删除语义步骤后，成员回到顶层。删除开头的顶层步骤时，`startUrl` 改成剩下第一个顶层步骤的地址。

编辑模式支持 Shift 连选、带上步骤触发的请求，以及批量设为“可选步骤”。

### 接口参数

“输入参数”和接口字段是两层：

- **输入参数**改的是录制步骤的值，回放和关联的接口字段都跟着变。修改走 `setParam`。
- **接口字段**写入 `apiOverrides`。手动修改关联字段后，字段固定成填写的值，弹窗提供“恢复关联”。

`setParam` 只接受组件里已有的选项：

| 控件 | 允许的值 |
|---|---|
| 复选框 | `true` / `false` |
| 单选框 | 组内选项。弹窗按序号提交，因为没写 `value` 的单选框值可能都是 `on`；手填文字或值必须唯一 |
| 原生下拉框 | 选项的值或文字 |
| 原生多选下拉框 | 选项组成的列表 |

**“AI 可调用”不是单独的开关**，它写入 `aiDocs.apis[name].ignore`，和 AI 标记的无关接口共用。`toolSchemas` 会过滤 `ignore` 的接口，所以取消勾选后 MCP 不再列出这个工具。

### 脚本库卡片

卡片可以临时改参数后运行，这些改动只影响这一次。“⚡ 直接请求”用 `mode: 'api'`，“▶ 回放操作”用 `mode: 'ui'`。运行模式的语义见[运行路由、直接请求与校准](../replay/execution-routing.md)。

### 恢复提示

本机目录里有、当前浏览器没有的其他来源脚本，会在脚本库页顶部按来源分组显示，点“恢复到这个浏览器”后由桥接异步写入。提示信息来自后台内存里的 `libraryOffers`，桥接每次同步时刷新。

### 自动更新设置

桥接设置里的“有新版时自动更新扩展”对应 `settings.autoUpdate`，默认开启。关闭后扩展拒绝 `updatePrepare` 和 `updateReload`。完整流程见[扩展与技能自动更新](../operations/auto-update.md)。

## AI 解读

扩展内置的 AI 解读支持 OpenAI 兼容接口和 Anthropic。三种用法共用同一份文档结构：

1. 弹窗点“AI 解读接口”，由后台调用模型。
2. “复制提示词”发给任意 AI，再“粘贴 AI 结果”。
3. AI 工具通过 `get_recording` 分析，再用 `save_api_docs` 写回。

后台任务为 MV3 的生命周期做了这些处理：

- 优先用流式请求，让响应头尽快到达。服务返回与 stream 相关的 400 时退回非流式。
- 分析期间每 20 秒调用一次扩展 API，重置 service worker 的空闲计时。
- 总时长上限 5 分钟，超时后中止。
- 进度写入 `aiStatus`，弹窗关闭不影响任务。
- 后台重新加载时如果发现 `running` 状态，就标记为“被浏览器回收”，不会一直显示分析中。

结果通过 `mergeDocs` 按接口合并，不会抹掉其他接口已有的说明。

## 录制包

录制包（`.prpkg.json`，`format: page-recorder-package`，`version: 1`）用于换机器、发给同事或备份。

**导出**：不包含设置（里面有 AI API Key），请求和步骤地址再脱敏一遍，并去掉 `tabId`。

**导入**：录制包可能来自别人，所以按不可信输入处理：

- 校验格式和版本，版本比扩展新时报错。
- 只保留合法的 `step` 和 `request` 事件。
- 起始地址、步骤、接口和框架地址必须是不含内嵌凭据的 http(s) 地址。WebSocket 请求除外。
- 上传步骤的本机路径被清空。
- 总是生成新 id，标记 `imported: true`，并使用本机当前设置。

经桥接 HTTP 导入还要求设置 token，见[桥接服务生命周期与连接](../bridge/server-lifecycle.md)。

## 修改时注意

- 给设置加字段时要同时改 `DEFAULT_SETTINGS` 和弹窗里的 `data-k` 控件。
- 改步骤结构时要同步检查 `grouping`（弹窗）和导出器的成员归属规则，两边注释都声明规则一致。
- 不要把 `settings` 放进录制包、本机备份或给 AI 的内容。

另见[录制分析、参数关联与产物](../recording/analysis-and-parameters.md)和 [MCP 工具与结果处理](../bridge/mcp-tools-and-results.md)。
