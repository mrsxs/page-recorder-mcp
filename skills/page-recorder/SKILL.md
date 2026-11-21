---
name: page-recorder
description: 用 page-recorder（mcp__page-recorder__* 工具）的录制脚本查数据、调接口时先读。按「摸清接口 → 在页面里改参数直接请求 → 被拒时让页面自己带签名发」的顺序选请求方式，并把结论写回接口说明。
---

# page-recorder：先摸清接口，再在页面里改参数请求

录制脚本的接口都在用户自己已登录的浏览器里执行，有两种发法：

- **直接请求**（`call_api`，或 `<脚本>__<接口>` 工具）：不操作页面，在开着的那个页面里按你给的参数发请求，带浏览器 Cookie，签名、令牌类请求头用页面最近一次请求同一接口时的值（结果里 `liveHeaders` 列出用了哪些）。快，参数随便改。
- **页面自己发**（`run_recording`，`mode: "ui"`）：回放录制的页面操作，页面自己组请求、现算签名。`api_params` 在请求发出前改接口参数，`params` 改输入框、日期、下拉。慢，签名一定有效。

`run_recording` 不传 `mode` 时会先直接请求、被拒就整段回放，并且之后一天都走回放。按下面的步骤明确传 `mode`，每一步都由你决定用哪种发法。

## 1. 摸清接口

1. `list_recordings` 找到脚本。脚本库大时它只给概要，接口也不会逐个列成工具：用 `search_apis` 按关键词找接口，拿返回的 `recording_id` 和 `api` 去 `call_api`。
2. `get_recording`：内容多时返回概要（步骤、参数、接口目录 `apis[i]`）和 `result_id`。
3. 对目录里像数据来源的接口，用 `read_result`（`path: "apis[i]"`，`fields: ["url","description","params","paramNotes","responseSchema","responseSample"]`）逐个看。

完成标准：能写出这三件事，写不出就接着看接口——
- 要的数据来自哪个接口（`fn`）；
- 要改哪些参数、合法取值（日期格式、分页、排序、店铺 / 站点 id 等）；
- 返回里数据所在路径、要哪些字段、总数在哪（之后当 `result_path` / `result_fields` 用）。

接口还没有说明（`description` 为空、`fn` 是自动起的名）时，用 `save_api_docs` 把这三件事写回，下次就能按语义名直接调用。

## 2. 在页面里改参数直接请求

用 `call_api`（或这个接口自己的工具）带改好的参数，同时带 `result_path` / `result_fields` 只取要的部分。先请求一小页，确认结构和第 1 步的判断一致，再拉全量：能调大 `pageSize` 就调大，否则按分页字段逐页请求。

返回正常、业务码和录制时一致：之后换参数都这样直接请求。

## 3. 被拒时让页面自己发

直接请求返回 401 / 403、`rejected: true`，或业务返回码和录制时不同（错误里常见 sign、签名、token、风控），说明这个接口要页面现算签名。依次：

1. **页面发一次**：`run_recording`，`mode: "ui"`，`api_params` 写上这次要改的参数（键是接口目录里的 `name`，按 `query` / `body` / `path` 分），例如 `{"POST /sbn/new_goods/get_skc_diagnose_list": {"body": {"pageIndex": 2}}}`，复用开着的标签页（不传 `new_tab`）。页面自己发请求、按你的参数改写，结果里就有数据；同时那个页面记下了最新的签名头。
2. **同一页面再直接请求**：紧接着换个参数 `call_api` 一次。通过：签名能复用一段时间，回到第 2 步的做法，过期被拒时再做一次第 1 步。
3. **签名每次现算**：还被拒，就每次都让页面自己发——
   - 改 `api_params` 的结果正确：每次换参数都用 `run_recording` + `mode: "ui"` + `api_params`；
   - 改 `api_params` 也被拒（签名覆盖了参数）：用 `params` 改页面上的输入框、日期、下拉，让页面按新条件组请求；要改的条件不在 `params` 里时，告诉用户要重新录制哪个操作。
4. **写回结论**：用 `save_api_docs` 把这个接口的请求方式写进它的 `description`，例如「要页面现算签名，直接请求 403；用 run_recording mode=ui + api_params 改 pageIndex / pageSize」。下次按结论直接选发法。

## 结果太大

调用时带 `result_path` / `result_fields` / `result_limit`；拿到 `result_id` 后用 `read_result` 翻页、换字段，不会重复请求接口。`result_id` 只在当前这轮对话里有效（有的 AI 工具每条消息都重启 MCP），过期了就重新调用并直接带 `result_path`。
