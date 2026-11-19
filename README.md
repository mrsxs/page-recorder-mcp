# Page Recorder · 操作与接口录制

Chrome 扩展（Manifest V3）：录制页面操作，抓取接口的请求参数和返回数据，导出成能在浏览器中直接执行的脚本。录制下来的每个接口都会拆成一个独立的工具函数；配合本地桥接服务，Claude Code、Accio 等 AI 工具可以直接在你的浏览器里执行脚本并拿到结果。

## 安装

需要 Node 18+，不用装任何依赖。

```bash
npx -y page-recorder-mcp extension     # 生成浏览器扩展，默认放到 ~/page-recorder-extension（可以跟一个目录参数）
```

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择上面生成的文件夹（从源码用的话，选本仓库根目录）
3. 安装前已打开的页面请刷新一次，否则抓不到首屏请求

以后升级：再跑一次上面的命令，然后在扩展卡片上点「重新加载」。

## 录制

1. 打开目标页面，点扩展图标 →「开始录制」。可以先给录制起个名字，不填也可以，AI 解读后会建议一个
2. 正常操作页面。点击、输入、下拉选择、勾选、回车、滚动、页面跳转都会被记录，fetch / XHR 请求和返回数据会被抓取
3. **Alt+点击**：标记要提取数据的元素（回放后在结果的 `extracted` 中返回）；**Alt+Shift+点击**：提取它所在的整个表格或列表
4. 点页面右下角或弹窗里的「停止」，录制会自动存入**脚本库**

密码输入默认不保存明文，会变成脚本参数，回放前再填。Authorization、Token、Cookie 这类请求头导出时会被隐藏。

**iframe 里的页面也能录**，包括跨域的（比如马帮后台的业务页面都嵌在 `aamz.mabangerp.com` 的 iframe 里）。iframe 里的步骤在时间线上会标「iframe · 域名」。回放时扩展会按录制时的 iframe 地址找到对应的框架，在里面执行。iframe 里发出的接口用 `call_api` 直接调用时，也会在那个 iframe 所在的源里调，自动带上它的登录态。

## 编辑时间线

- **删除步骤**：「时间线」页点「编辑」，点行选择，Shift+点击可以连选一段。勾着「选步骤时带上它触发的请求」时，选中一个步骤会一起选中它触发的请求（比如登录按钮和 `doLogin` 接口）。删掉开头的步骤后，起始页面会改成剩下第一步所在的页面
- **可选步骤**：不是每次都会出现的步骤（比如登录、关广告弹窗）可以设为「可选」：鼠标移到步骤上点「可选」，或在编辑模式里批量「设为可选」。回放时页面上有这个元素就执行，等 3 秒（`CONFIG.optionalTimeout`）还没有就跳过，继续下一步。一个可选步骤被跳过后，紧跟着的可选步骤（登录后续的输入、提交、跳转）会被视为同一组，只快速检查一下

修改会自动同步到脚本库。

回放时还会自动处理两种常见情况：「打开页面」被服务器重定向（比如已登录时登录页直接跳到后台首页），按跳转后的页面继续；要点的元素在鼠标悬停才展开的下拉菜单里，先模拟悬停展开菜单，展开不了就直接触发点击。

## 接口参数：识别和修改

「接口参数」页会列出每个接口识别出的参数：

- **路径参数**：比如 `/api/order/123/submit` 会识别成 `/api/order/{id}/submit`
- **Query 参数**
- **请求体字段**：JSON 会展开成 `item.qty`、`items[0].id` 这样的路径；表单和 multipart 按字段展开

**想换搜索内容等，改页面顶部的「输入参数」就行**：它就是录制时在输入框里填的内容，回放时会填进输入框；接口里关联了它的字段（显示为「= 输入参数「…」」）会跟着变。脚本库卡片上也能直接改参数再运行：「⚡ 直接请求」不操作页面，直接在页面里请求接口；「▶ 回放操作」在页面上重放录制的操作。下面的接口字段一般不用改：手动改了关联字段，就会固定成你填的值，不再跟着输入参数变（会有提示，可以「恢复关联」）。

像 `index.php?mod=stock.list` 这种靠查询参数区分功能的接口，`mod`、`action`、`method`、`route` 等路由参数会算进接口本身：`mod` 不同就是不同的接口，接口名形如 `POST /index.php?mod=stock.list`。

参数可以直接在弹窗里改，也可以改导出脚本顶部的 `API_PARAMS`。回放时，页面发出的对应请求会被自动改写成新值。只改写和录制值不同的字段，删掉某个键就是从请求里移除这个参数。如果某个参数值等于你在输入框里输入的内容，它会自动关联成 `{{参数名}}`，改了输入，接口参数也跟着变。

## AI 解读接口（把每个接口拆成工具）

AI 会给每个接口起函数名（如 `searchProducts`），写标题、用途、参数说明和返回说明，还会标出埋点之类的无关接口，并给整个脚本起名。有三种用法，任选一种：

- **扩展内直接调用**：在「设置」里配置 AI。支持 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、Kimi、OpenRouter、本地 Ollama 等）和 Anthropic Claude，Base URL 可以填中转地址（填到 `/v1` 即可，填完整的 `/chat/completions` 也行）。然后在「接口参数」页点「✨ AI 解读接口」。分析在后台进行，可以关掉弹窗；失败原因会一直显示在按钮下方，点 × 才关闭
- **任意 AI 手动解读**：点「复制提示词」发给任意 AI，再把返回的 JSON 用「粘贴 AI 结果」导回来
- **让 Claude Code 等 Agent 解读**：通过桥接服务调用 `get_recording` 分析，再用 `save_api_docs` 写回（见下文）

## 导出

| 按钮 | 内容 |
|---|---|
| 导出脚本 .js | 可在浏览器执行的回放脚本，头部有自然语言写的步骤、接口说明和响应结构，适合交给 AI |
| 复制说明 | Markdown 格式的步骤、接口、参数、响应结构和示例 |
| 导出 JSON | 原始数据：全部请求和响应、工具定义（JSON Schema） |

### 脚本怎么执行

- **控制台**：打开起始页面（保持登录），按 F12 打开 Console，粘贴后回车
- **Playwright / Puppeteer**：`const result = await page.evaluate(scriptText)`
- **CDP**：`Runtime.evaluate({ expression: scriptText, awaitPromise: true })`

脚本返回：

```js
{
  ok: true, completed: 10, total: 10,
  extracted: { "表格1": [["1","iphone-1","100"], ...] },             // Alt+点击 标记的数据
  responses: [{ step: 5, api: "GET /api/search", status: 200, data: {...} }],  // 各步骤触发的接口数据
  log: [...], error: "..."
}
```

遇到整页跳转时，脚本会中断。新页面加载后再执行一次，会自动从断点继续。执行后还可以用 `window.__PR__`：

```js
__PR__.tools.searchProducts({ q: 'macbook', page: 2 })  // 直接调用接口，自动带登录 Cookie
__PR__.api.list()                                        // 查看全部接口、参数和说明
__PR__.replay({ from: 0 })                               // 重新回放
```

## 让 Claude Code、Accio 等 AI 工具直接执行（本地桥接服务）

```
AI 工具 ──MCP / HTTP──▶ bridge/server.js ◀──WebSocket── 浏览器扩展 ──▶ 在你的 Chrome 中执行（带登录态）
```

启动桥接服务（需要 Node 18+，无需 `npm install`）：

```bash
npx -y page-recorder-mcp            # 或者从源码：node bridge/server.js
```

扩展会在 30 秒内自动连上，弹窗右上角显示「桥接 ●」。

可选参数（也可以用环境变量）：`--port`（`PR_BRIDGE_PORT`，默认 17321）、`--host`（`PR_BRIDGE_HOST`，默认 127.0.0.1）、`--token`（`PR_BRIDGE_TOKEN`，设置后 HTTP 调用要带 `Authorization: Bearer <口令>`）。改了端口的话，扩展「设置」里的桥接地址也要改成 `ws://127.0.0.1:<端口>/ext`。

### 接入 Claude Code（MCP）

```bash
# stdio 方式（推荐；如果桥接服务已经在运行，这个实例会自动转发给它）
claude mcp add page-recorder -- npx -y page-recorder-mcp --stdio

# 或者 HTTP 方式（需要先运行 npx -y page-recorder-mcp）
claude mcp add --transport http page-recorder http://127.0.0.1:17321/mcp
```

### 接入 Accio

在 Accio 里添加自定义 MCP：

```json
{
  "name": "page-recorder",
  "type": "local",
  "enabled": true,
  "command": ["npx"],
  "args": ["-y", "page-recorder-mcp@latest", "--stdio"],
  "timeout": 200000
}
```

新录了脚本以后，在 Accio 里把 page-recorder 断开再连上，工具列表才会更新（通用的 `run_recording`、`call_api` 不受影响）。其他支持 MCP 的工具（Claude Desktop、Cursor 等）用同样的命令或 URL 添加。不支持 MCP 的工具，可以直接调下面的 REST API。

**只给 AI 用你需要的接口**：录制时会抓到很多接口，在「接口参数」页取消勾选不用的「AI 可调用」，MCP 里就只出现勾选的那几个工具。AI 调这些工具时，直接在开着的页面里发请求、拿结果，不操作页面。

### MCP 工具

| 工具 | 作用 |
|---|---|
| `list_recordings` | 列出脚本库：名称、步骤、输入参数、每个接口拆出的工具 |
| `get_recording` | 脚本详情：每个接口的 URL、参数、参数说明、响应结构和示例 |
| `run_recording` | 运行脚本，可改 `params` 和 `api_params`，返回数据。`mode`：`api` 不操作页面、直接请求关联了输入参数的接口；`ui` 回放页面操作；默认 `auto`（能直接请求就直接请求） |
| `call_api` | 不回放页面操作，直接调用某个接口 |
| `get_script` | 获取导出的 JS 源码 |
| `save_api_docs` | 把 AI 对接口的分析写回：命名、函数名、用途、参数说明 |
| `<脚本>__run` | 每个脚本一个，用于整段回放 |
| `<脚本>__<函数名>` | **每个接口一个独立工具**，例如 `product_search__searchProducts` |

脚本库变化时，服务会发出 `tools/list_changed` 通知，AI 工具会自动刷新工具列表。

可以直接对 Claude Code 说：
> 用 page-recorder 看看脚本库，分析「商品搜索下单」每个接口是做什么的，把说明保存回去，然后搜索 macbook 第 2 页给我看结果。

### REST API

```bash
curl http://127.0.0.1:17321/api/recordings                    # 列表
curl http://127.0.0.1:17321/api/recordings/商品搜索下单           # 详情（id 或名称都可以）
curl http://127.0.0.1:17321/api/recordings/商品搜索下单/script    # JS 源码

# 回放：改输入框参数和接口参数
curl -X POST http://127.0.0.1:17321/api/recordings/商品搜索下单/run \
  -H 'content-type: application/json' \
  -d '{"params":{"搜索商品":"macbook"},"apiParams":{"GET /api/search":{"query":{"page":"2"}}}}'

# 调用单个接口
curl -X POST http://127.0.0.1:17321/api/recordings/商品搜索下单/call \
  -H 'content-type: application/json' -d '{"api":"searchProducts","args":{"q":"ipad","page":2}}'
```

`run` 的可选参数：`mode`（`auto` / `api` / `ui`，见上）、`fresh`（复用的标签页先刷新回起始页面）、`newTab`（用全新标签页、跑完关掉）、`keepTab`（配合 `newTab` 保留标签页）、`active`（在前台执行，方便观察）、`timeout`（毫秒，默认 180000）。

**回放返回的数据**：`responses` 是每一步关联的接口返回；`network` 是回放期间这个标签页里所有框架（包括整页跳转后的新页面、跨域 iframe）发出的全部接口及返回（最多 300 条），按时间排列，`frame` 字段标明来自哪个 iframe。直接请求模式下，结果在 `responses` 里。

**页面复用**：直接请求和 `call_api` 会在已经开着的同源页面里发请求，带着浏览器的 Cookie、登录态和录制时的请求头。第一次没有合适的页面时，会在后台打开一个并留着，之后的请求直接复用，不用每次都打开页面。页面回放（`mode: ui`）也会复用这条录制上次的回放标签页。

### 安全

- 服务只监听 `127.0.0.1`。带 `Origin` 头的跨站请求会被拒绝，网页无法偷偷调用它；只有扩展能通过 WebSocket 连进来
- 需要更严格的控制时，设置 `PR_BRIDGE_TOKEN=xxx`，之后 HTTP 调用要带 `Authorization: Bearer xxx`
- 端口可以用 `PR_BRIDGE_PORT` 修改，扩展「设置」里的地址要同步修改
- 脚本在你已登录的浏览器里执行，能做你在页面上能做的一切。请只接入你信任的 AI 工具

## 目录结构

```
manifest.json
background.js        录制状态、脚本库、AI 解读、在标签页中执行、桥接连接
inject/hook.js       页面主环境：拦截 fetch / XHR，抓取请求和响应
content/recorder.js  记录操作、生成元素选择器、显示录制浮层
lib/exporter.js      分析步骤和接口，识别参数，生成脚本、说明和工具定义
lib/runtime.js       回放引擎（原样嵌入导出脚本）：元素定位、模拟操作、请求改写、断点续跑、接口调用
popup/               弹窗界面
bridge/server.js     本地桥接服务（MCP stdio / MCP HTTP / REST / WebSocket，零依赖）
```

## 已知限制

- Shadow DOM 内部和新开的标签页不录制；扩展安装或重新加载前就打开的页面（包括里面的 iframe）要刷新一次才能录
- 导出的控制台脚本不能操作跨域 iframe，遇到 iframe 里的步骤会停下并提示；这类录制请用扩展脚本库的「▶ 运行」或桥接服务的 `run_recording`
- 不抓 WebSocket 和 sendBeacon；文件上传步骤会被跳过
- 控制台脚本遇到跨域整页跳转时，之前已收集的 `responses` 和 `extracted` 不会带到新页面（扩展和桥接回放没有这个问题）
- 签名类参数（时间戳、sign）是页面实时算出来的，回放时页面会重新生成。用 `call_api` 直接调这类接口可能被服务端拒绝，这种情况用 `run_recording` 回放页面操作
