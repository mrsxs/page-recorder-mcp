---
type: subsystem
title: 页面回放运行时
description: lib/runtime.js 如何展开参数模板、改写页面请求、定位元素、执行真实或模拟输入、驱动日期和下拉组件，并在页面跳转后从断点继续。
tags: [runtime, replay, element-location, real-input, components]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T01:54:25.069Z
sources:
  - id: openwiki-source-f22365b596e25ba4bf7c6003
    resource: repo://background.js
  - id: openwiki-source-526e70b83767af4ab35c995c
    resource: repo://content/recorder.js
  - id: openwiki-source-7c47ddfa0668cdae5410afcf
    resource: repo://lib/exporter.js
  - id: openwiki-source-7ff5f61fb83168bee1eea6fa
    resource: repo://lib/runtime.js
generated: { by: "claude-code", at: "2026-11-23T01:54:25.069Z" }
---

# 页面回放运行时

`lib/runtime.js` 定义一个函数 `__pageRecorderRuntime(REC, PARAMS, API_PARAMS, CONFIG, hooks)`。它有三种运行形态：

| 形态 | 环境 | 职责 |
|---|---|---|
| 扩展回放 | ISOLATED world | 定位元素并执行步骤，通过 `hooks` 使用真实输入、断点和网络记录 |
| `networkOnly` | 页面 MAIN world | 改写和记录 fetch / XHR，提供组件适配，应答弹窗 |
| 导出脚本 | 控制台、Playwright、CDP | 单份运行时完成回放和接口调用，暴露 `window.__PR__` |

**这个函数必须完全自包含。** 导出器通过 `Function.prototype.toString()` 把它写进脚本，不能引用外部变量或扩展 API，扩展能力只能通过 `hooks` 传入。

## 参数模板

`fillTpl` 递归展开 `{{参数}}`，支持过滤器：

| 过滤器 | 作用 |
|---|---|
| `num` | 转成数字 |
| `opt` | 选项文字换成编码，选项表里没有时报错 |
| `jsonesc:N` | 按嵌套层数做 JSON 字符串转义 |
| `date:格式` | 按格式输出日期 |
| `ts:ms`、`ts:s:end` | 输出时间戳，`end` 表示当天最后一刻 |
| `iso:start`、`iso:end` | 输出 `toISOString` 形式的 UTC 时间 |
| `#序号` | 取一个框里的第几个日期 |

月日顺序分不清时报错，要求写成 `YYYY-MM-DD`，不会猜测。

## 请求改写

回放时 MAIN world 包住 fetch 和 XHR，页面发出请求时：

1. `findApi` 按方法、主机、路径模板、路由参数和请求体操作匹配接口。网关式接口要等 `send(body)` 拿到操作标识后才匹配，避免 `open()` 时误改 URL。
2. `diffOf` 只计算**和录制值不同**的字段，其他字段保持页面现算的值，例如时间戳和签名。
3. `rewriteUrl`、`rewriteBody` 应用修改。支持 JSON、表单、`URLSearchParams`、`FormData`。
4. 记录改写前的值（`entry.pre`），供校准比较。

正在校准的参数关联的字段**不改写**，这样才能看到页面自己发的值。扩展回放每段结束后调用 `netOff`，撤掉改写和记录，用户之后的正常操作不受影响。

## 元素定位

录制时保存多个选择器和上下文：文字、`name`、表单标签、所在弹层标题、表格行、Shadow DOM 宿主链、同源 iframe 链。`locate` 按下面的规则查找：

1. 某个选择器正好命中一个可见元素，且文字和弹层上下文匹配时直接使用。
2. 否则合并所有候选，选择器失效时再按标签和文字补充候选。
3. 用 `scoreOf` 打分：命中选择器数量、文字、稳定 id、`name`、表单标签和弹层标题。
4. 平分时优先最上层弹层，并在日志中写 `ambiguous`，结果里给出警告。

几条防误操作的规则：

- **表格行**：不使用按位置的选择器，按录制时那一行的单元格文字找行。格子里等于输入参数的文字会跟着参数变。**分不清是哪一行时报错**，不会点到别的记录。
- **弹层**：录制时在弹窗里的目标，候选也必须在弹窗里且标题一致，防止弹窗还没出来时点到页面上同名的按钮。等待到后期才放宽，并写入警告。
- **可选步骤**：用 `locateStrict`，标签和文字都要一致，避免“登录”消失后点到同位置的“退出登录”。
- **相近文字**：目标文字包含本次换掉的参数旧值时，才按词相似度匹配，阈值 0.6，只用于表单区域，不用于链接或按钮。

## 执行操作

### 真实输入和回退

默认通过 `chrome.debugger` 发送真实的鼠标键盘事件，事件带 `isTrusted`，悬停菜单、焦点、回车提交都自然生效。回放期间浏览器会显示调试提示条。

`tryReal` 的回退规则很关键：

- 输入**还没发出去**就失败时，回退到模拟事件。
- 输入**已经开始派发**后失败时，标记 `unknown` 并报错，**不再补一次模拟操作**，避免重复提交。

真实输入只在顶层框架使用，子框架用模拟事件。

### 点击

`doClick` 依次等待按钮可用（最多 5 秒）、元素停稳（动画结束、位置不变），再计算可点击坐标：

- 元素已完整显示时**不滚动**，因为有的下拉和日历一滚动就关闭。
- 依次尝试中心和周围的点，只有命中目标或其子元素才点击。
- 被加载遮罩挡住时等待，被弹窗挡住时不点。
- 元素刚好被重新渲染时重新定位一次，并重新判断开关状态。

步骤录有 `toggle` 或 `state` 时，目标已经是录制后的状态就跳过，防止把开关翻回去。

### 值类控件

**日期**（`pickDateInner`）按顺序尝试：

1. 浏览器原生日期框：写标准格式。
2. jQuery UI：调用 `setDate` 和页面的 `onSelect`。
3. 可键入的框：真实键入后按 Tab。不用回车，因为回车可能提交整个表单。layDate 先走面板。
4. 日历面板：打开、翻到目标年月、点日期、需要时点确定。
5. 直接写值。Vue / React 管理的框写 DOM 不会更新组件状态，这时报错而不是假装成功。

**选择项**（`pickChoice`）：

1. 值和录制时相同，重放录到的点击。
2. 否则点开控件，按文字找选项，排除点开前就存在的同名文字。
3. 级联值按 `/`、`>` 拆层逐级点击，下一列没出来时重新点上一级。
4. 可搜索的组件先输入文字过滤。
5. 点击后验证显示值。没选中时重试；多选里误选的相邻项再点一次取消，树形多选不做这步，因为勾父节点会连带子节点。
6. 界面选不中但背后有原生 `<select>` 时，直接设置并通知组件刷新。

**单选**按“文字唯一、值唯一、`#序号`”解析，分不清或不存在时报错。

### 页面组件适配

ISOLATED world 看不到页面的 `jQuery`、`layui`、`__vue__`。`pageOp` 通过随机事件名的 `CustomEvent` 请求 MAIN world 那份运行时执行 `PAGE_OPS`，只传操作名和参数，不传令牌。MAIN 端用 `hasOwn` 校验操作名，回放结束后移除监听。

### 原生弹窗

按录制时的选择应答，匹配依据是类型和文字，不依赖弹出时机。**没录到的 confirm 和 prompt 一律取消**，不替用户确认没见过的操作，结果的 `dialogs` 会标出来。

## 回放循环和断点

`replay` 逐步执行，每步：

1. `mark(i)` 记下当前步。
2. 执行步骤。`runStep` 在**真正动手之前**把断点推进到下一步，这样动作引发跳转时这一步算完成，而等待元素期间页面刷新时会重做这一步。
3. 等待录制时这一步触发的接口。超时只警告，不中断。

断点在扩展回放时通过 `hooks.progress` 发给后台，在导出脚本里存入 `sessionStorage`（30 分钟有效）。跨源跳转时各源的 `sessionStorage` 不互通，所以扩展以收到的最新断点为准。

**可选步骤组**：一个可选步骤被跳过后，紧跟的可选步骤视为同一组，跳转直接跳过，其他步骤只快速检查 300ms。组状态随断点保存，跨框架分段时由后台传递。

导航步骤只允许 `http`、`https`、`file` 协议，拒绝 `javascript:` 这类地址。

## 相关测试

`test/security-and-bugs.test.mjs` 用 `node:vm` 覆盖令牌清除、原型污染、模板不二次展开、请求组装、导航协议、弹窗匹配、实时鉴权和 `PAGE_OPS`。真实页面交互不在自动测试范围内，见[测试、CI 与发布](../operations/testing-and-release.md)。

另见[运行路由、直接请求与校准](./execution-routing.md)、[录制与请求捕获管线](../recording/capture-pipeline.md)、[凭据处理与信任边界](../security/credentials-and-trust.md)。
