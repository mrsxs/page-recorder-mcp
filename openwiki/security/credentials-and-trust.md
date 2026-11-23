---
type: security
title: 凭据处理与信任边界
description: Page Recorder 如何脱敏密码和令牌、隔离页面与扩展权限、限定实时鉴权的使用范围、保护本地桥接、文件读写、本机备份和自动更新，以及当前设计仍然接受的风险。
tags: [security, credentials, redaction, trust-boundary, bridge-auth]
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
  - id: openwiki-source-526e70b83767af4ab35c995c
    resource: repo://content/recorder.js
  - id: openwiki-source-46772d2492298b47982bc2b4
    resource: repo://inject/hook.js
  - id: openwiki-source-7c47ddfa0668cdae5410afcf
    resource: repo://lib/exporter.js
  - id: openwiki-source-7ff5f61fb83168bee1eea6fa
    resource: repo://lib/runtime.js
  - id: openwiki-source-b25e71362ad2d0521bb4e04c
    resource: repo://manifest.json
  - id: openwiki-source-94fada3aaa8074a858b813c3
    resource: repo://test/persistence.test.mjs
  - id: openwiki-source-dfd516e25729907b76c79f44
    resource: repo://test/smoke.test.mjs
generated: { by: "claude-code", at: "2026-11-23T04:07:50.896Z" }
---

# 凭据处理与信任边界

Page Recorder 在用户已登录的浏览器里运行脚本，拥有 `<all_urls>`、`debugger`、`scripting`、`webRequest` 权限。**能调用它的人，就能以用户身份操作已登录的网站。** 这页说明哪些输入不可信，以及代码在哪里拦截。

## 信任分区

| 分区 | 信任程度 | 能做什么 |
|---|---|---|
| 目标页面和 MAIN world | 不可信 | 可以伪造事件和消息，可以读 MAIN 里的一切 |
| 内容脚本（ISOLATED） | 受限 | 只能发白名单消息 |
| 扩展后台 | 可信 | 持有存储、调试接口和实时鉴权 |
| 弹窗 | 可信 | 完整命令集 |
| 录制包 | 不可信 | 导入前校验并清理 |
| 本机备份目录 | 恢复时按外部输入处理 | 校验后才进入脚本库 |
| 已安装的 npm 包 | 更新来源 | 其中的文件会写进用户的扩展目录和技能 |
| 本地桥接 | 按请求鉴权 | 把调用转给扩展 |
| AI 工具 | 用户选择信任 | 通过桥接以用户登录态执行 |

## 录制时的脱敏

### 密码

识别条件包括 `type=password`、一次性验证码和密码类 `autocomplete`、常见 `name`/`id`。一个框被识别后，点“显示密码”把 `type` 改成 `text` 也继续按密码处理。

1. 步骤里的值存成空串，只保留 `secretId`。
2. 明文通过 `secret` 消息交给后台，只放在内存和 `chrome.storage.session`，不写入 `local`，最多 20 个。
3. 之后请求里出现同样的值，按原文、URL 编码、表单编码、JSON 转义四种形式替换成 `__PR_SECRET_<id>__`。收到密码时还会回扫最近 5 秒已入库的请求。
4. 分析时占位符关联到密码参数，回放前必须重新填写。
5. 停止录制或开始新录制时清除明文。

### 令牌和签名

`scrubRequest` 在**入库前**处理：

- 名字像密码、令牌、签名、CSRF 的查询参数和请求体字段换成 `__PR_MASKED__`。判断看字段路径的最后一段，所以 `user[password]`、`loginPwd`、`j_password` 都能命中。
- URL 的 userinfo 密码和 hash 里的令牌同样处理。
- 敏感请求头存成 `***`，保留头名，直接请求时再补实时值。
- 嵌套 JSON 字符串和响应体也会递归脱敏。

**对外输出时再脱敏一层**：导出脚本、录制包、给 AI 的内容还会遮盖非标准请求头里像令牌的长串（长 base64、hex、JWT）。

设置里的 `maskPasswords`、`maskHeaders` 可以关闭这些保护，关闭后敏感值会进入本地存储和导出内容。

## 隔离页面和扩展能力

- **钩子无特权**：`hook.js` 只通过私有 `MessagePort` 传遥测，不持有扩展权限。
- **消息白名单**：后台只接受本扩展的消息。来自标签页的消息限定在 `CONTENT_MESSAGES` 内，`updateEvent`、`secret`、`stop` 还要求发送方是当前录制标签页。
- **回放令牌**：由密码学随机数生成，只放在 ISOLATED world。`realInput`、`replayNetwork`、`replayProgress` 都要同时匹配令牌、标签页、框架和文档。
- **真实输入**：只有顶层框架能用，坐标必须落在顶层页面内且不在 iframe 上。
- **跨世界适配**：页面脚本即使拿到事件名，也只能触发固定的几个组件操作，拿不到令牌。
- **文件上传**：只能设置本次回放参数里给出的文件路径，页面不能借扩展读取其他本机文件。
- **事件字段不可信**：“已脱敏”由后台内部参数决定，不读事件对象上的字段。
- **响应当数据处理**：直接调用 JSONP 时用 `fetch` 取文本，校验回调形式后 `JSON.parse`，不执行服务端返回的脚本。
- **原型污染防护**：路径写入、参数合并和结果读取都排除 `__proto__`、`constructor`、`prototype`。

## 实时鉴权的范围

直接请求需要页面最新的令牌，但不能让令牌流向别的地方：

- 按 `[标签页, 文档, 目标范围]` 缓存在后台内存，5 分钟过期。
- 只补这个接口录制时本来就带的头。
- 页面上读到的隐藏字段和 CSRF meta 只发给同源接口。
- 带实时值的请求禁止跟随重定向。
- 导入的录制包不走页面 SDK 路径。

完整规则见[运行路由、直接请求与校准](../replay/execution-routing.md)。

## 录制包

导入时校验格式和版本，只保留合法事件，拒绝带内嵌凭据或非 HTTP(S) 的地址，清空上传路径。导出不包含设置，因为设置里有 AI API Key。

## 本机备份

`~/.page-recorder/library/` 会长期留在磁盘上，所以：

- 目录按 `0700` 创建，文件权限 `0600`。
- 写入时去掉 `settings`，AI API Key 不落到这个目录。
- 发送备份前按默认脱敏设置处理请求、地址和接口覆盖值，不看这条录制自己的开关。
- `scrubBackup` 清掉密码框的值，同样的值出现在请求、接口覆盖值、AI 说明和步骤效果里时换成占位符。
- 恢复时校验 `id`、`savedAt`、事件类型和地址，并清空上传路径。
- 只有来源扩展 ID 等于当前扩展、且原本不是导入的脚本才保持普通权限，其余标记 `imported: true`，这个标记也写进新的备份。
- 每个资料一个目录。其他资料的备份不自动并入，由用户在弹窗里选择。
- 恢复请求只接受发给这个连接、当前不在线的来源，在线资料的备份不能被别的连接取走。

密码框靠步骤标记和字段名识别。名字普通、类型也不是 `password` 的自定义密码框，在关闭 `maskPasswords` 时录到的值可能留在备份里。

详见[脚本库本机备份与恢复](../bridge/library-backup.md)。

## 自动更新

自动更新能改写一个拥有 `<all_urls>` 和 `debugger` 权限的扩展，所以限制了写入范围：

- 新文件只来自桥接所在的 npm 包，更新过程不额外下载代码。
- 只写 `extension` 子命令记录过的目录或默认目录，并要求目录算出的扩展 ID 和连接的扩展一致。
- 跳过带 `.git` 的目录和包根目录，`manifest.json` 名称必须以 `Page Recorder` 开头。
- 技能只更新已安装的副本，跳过符号链接，第一次接管先备份，接管后用户改过的不覆盖。
- 写入中途失败时全部还原，不让目录停在新旧混用的状态。

详见[扩展与技能自动更新](../operations/auto-update.md)。

## 桥接保护

### HTTP

| 威胁 | 防护 |
|---|---|
| 暴露到局域网 | 默认只监听 `127.0.0.1`，非本机地址必须设置 token，否则以退出码 2 拒绝启动 |
| 网页跨站调用 | 校验 `Origin` 和 `Sec-Fetch-Site`，POST 必须是 `application/json` |
| DNS 重绑定 | 校验 `Host` 头的地址和端口 |
| `<script>` 读取脚本 | `Sec-Fetch-Dest: script` 时拒绝，响应带 `nosniff` 和 CORP |
| 口令时序攻击 | 用 `timingSafeEqual` 比较 |
| 请求过大 | 请求体默认 20MB，超限返回 413；MCP 批量最多 20 项 |
| 伪造内部调用 | `/api/ext`、`/api/owners` 要求状态文件里的本机口令，文件权限 `0600` |

### WebSocket

只接受 `chrome-extension://` 来源和合法 `Host`。设置 token 时必须带上，可用 `--extension-id` 或 `PR_EXTENSION_ID` 限定扩展 ID。`instanceId` 首次登记后绑定来源，防止其他扩展冒用。

### 文件读写

- **写**：`get_script` 的 `to_file` 经 HTTP 调用时，要求本机监听且来自 stdio 转发或已设置 token。HTTP 写盘单文件 16MB、累计 64MB。文件写到 `exports` 目录，权限 `0600`，不覆盖已有文件。
- **读**：`import_package` 只读 `.json`，不超过 50MB，报错不带文件内容。经 HTTP 调用时必须设置 token，路径限定在 `exports` 目录内并解析真实路径，防止符号链接逃逸。非本机监听时不能传文件路径。

## 仍然存在的风险

这些是当前设计接受的边界，修改或部署时要清楚：

- **未设 token 时，本机任何进程都能调用桥接。** `Origin` 检查只能挡住浏览器网页，挡不住本机程序。多用户机器或运行不可信程序时应设置 `--token`。
- **AI 工具拥有用户的登录态能力。** 脱敏只保护凭据字段，接口返回的业务数据会交给 AI。
- **AI API Key 存在 `chrome.storage.local`**，代码没有额外加密。
- **脱敏基于字段名和值的形态**，名字普通的自定义令牌可能漏掉。
- **MAIN world 里的页面脚本能看到页面自身的数据和请求**，扩展不防护页面自身。钩子握手后仍接受新的 `init`，页面脚本也能发这条消息，把钩子的遥测端口换成自己的。
- **npm 包是自动更新的信任根。** 更新器不额外校验文件签名，被篡改的包会在桥接启动后写进扩展目录。
- **没有限定扩展 ID 时，WebSocket 接受任意 `chrome-extension://` 来源。** `capabilities` 由扩展自己声明，声明了 `librarySync` 的连接能收到离线来源的恢复提示，并拿到这些备份的内容。需要隔离时设置 `--extension-id` 或 token。

## 相关测试

`test/security-and-bugs.test.mjs` 覆盖注入、ReDoS、脱敏、令牌清除、原型污染、跨源鉴权、XSSI/CSRF、扩展白名单、内部路由鉴权和请求限制。`test/smoke.test.mjs` 覆盖 token 和本机口令。

另见[录制与请求捕获管线](../recording/capture-pipeline.md)和[桥接服务生命周期与连接](../bridge/server-lifecycle.md)。
