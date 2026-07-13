# Claude 指纹探针详情与每日历史设计

## 背景

「Claude 指纹」页面已经能够执行并保存一组 Claude/ClaudeCode 诊断探针，但当前存在四个直接影响判断和复审的问题：

1. Web Search 是能力参考探针，却可能把官方正常支持联网的结果理解为“不符合预期拒绝”。
2. 警告行只展示截断的证据摘要和标签，无法直接看清判定原因、上游错误和请求上下文。
3. 历史记录是平铺卡片，不能按日期快速查看每天执行了多少次、每次有哪些警告。
4. 页面缺少用户期望的自然身份问答探针，例如“你是谁”和“你好，请介绍一下你自己”。

本次修改只聚焦 `/claude-code-check` 对应的「Claude 指纹」页面及其专用后端接口，不扩展自动巡检页面，也不改变手动测评任务列表。

## 目标

- 正确识别 Anthropic server-side Web Search 成功证据，避免官方渠道被误判为不支持联网。
- 每个失败、警告或跳过探针都能展示完整、可追踪且已脱敏的具体原因。
- 在现有历史证据中按天筛选和分组查看检测情况。
- 增加自然语言身份探针，同时继续把模型自报身份视为低权重辅助信号。
- 保持运行时 API Key 不落库，不在响应、历史、日志或截图中暴露凭据。

## 非目标

- 不新建巡检、队列或告警系统。
- 不新增数据库表或引入 Alembic。
- 不把 Web Search、图片 URL、document block 或 Thinking Signature 支持情况提升为 Claude 真伪核心结论。
- 不使用模型自报身份覆盖 message id、协议结构、usage、tool use 等硬证据。

## 方案

采用现有 `ClaudeCodeEvidence`、`result_payload` 和 Claude 指纹历史接口作为唯一数据源。后端为探针结果补齐统一诊断字段，前端在现有分组表格中增加展开详情，并把历史抽屉升级为按天筛选和分组的记录视图。无需数据库结构迁移；旧历史记录仍可展示已有字段，新记录获得完整诊断数据。

## Web Search 判定

`web_search_reference` 继续使用官方有效的 `web_search_20260318` server tool。判定顺序如下：

1. 原始响应或 usage 中出现任意正式证据时判为 `pass`：
   - `server_tool_use` 且 `name=web_search`
   - `web_search_tool_result`
   - `web_search_result_location`
   - `usage.server_tool_use.web_search_requests > 0`
2. 已发起 Web Search，但工具返回 `web_search_tool_result_error` 时判为 `warning`，原因必须包含工具错误码或消息；该结果不计入 Claude 真伪核心失败。
3. 上游明确返回 unsupported/not available，或模型明确说明当前环境没有联网工具时判为 `skipped`，标签为能力不支持/不可用；该结果不计入 Claude 真伪核心失败。
4. 没有任何 server tool 证据、错误或明确不可用说明时判为 `warning`，标签为 `web_search_evidence_missing`，提示无法证明真实联网，而不是声称渠道非 Claude。
5. 超时、限流、额度、连接失败等运营错误保留原始原因并判为 `warning`，不得转换成“不支持联网”。

Web Search 分组标题和说明保持“能力参考”，分组警告不改变 Claude 核心得分和分类。

## 统一探针诊断数据

`ClaudeCodeProbeResultRead` 与运行中的 `ClaudeCodeJobProbeRead` 增加以下可选字段：

- `reason`: 面向复审者的最终判定原因，必须说明观察到了什么以及为何得到当前状态。
- `label_explanations`: 当前标签及中文解释，不要求前端自行猜测。
- `http_status`: 上游 HTTP 状态。
- `error_type`: 归一化错误类型。
- `error_detail`: 已脱敏的完整上游错误文本；不使用当前表格的 1200 字符摘要代替。
- `response_excerpt`: 已脱敏的响应内容摘要，默认限制在适合页面展示的长度。
- `request_snapshot`: 该探针实际使用的非敏感请求信息，包括 prompt、system prompt、工具名、thinking/stream/max_tokens 等参数；必须移除认证头、API Key、secret 和 credential 字段。
- `raw_evidence`: 与判定直接相关的结构化证据，例如 Web Search block 类型、使用次数、stop reason、usage keys 和协议 profile；不得包含凭据。

兼容规则：所有新字段均可选。读取旧历史时，后端或前端使用现有 `evidence_excerpt`、`labels` 和 `detail` 生成回退说明，不修改旧 JSON 数据。

## 页面探针详情

保留当前按“ClaudeCode 兼容指纹、基础结构、行为、Thinking Signature、多模态、Web”分组的卡片和表格。每个探针行增加“查看详情”入口，展开内容按以下顺序显示：

1. 判定原因和标签解释。
2. HTTP 状态、错误类型、完整上游错误。
3. 脱敏请求快照。
4. 结构化原始证据与响应摘要。
5. run id、result id、message id、request id、协议、endpoint 和耗时。

行内“证据摘要”只承担快速浏览；警告和失败不能只依靠 tooltip 展示原因。运行中表格和历史结果表格使用同一个详情组件，避免实时结果与历史结果口径不同。

分组状态规则：

- 核心探针失败可使分组失败并影响 Claude 基础判断。
- `reference`、多模态、Web 和普通 Claude 不强制支持的 Signature 探针失败只显示警告或跳过。
- 分组标题的通过/失败/警告/跳过数量必须与行状态一致，不能出现“分组警告但警告数为 0”。

## 每日历史

历史抽屉继续使用 `/api/claude-code-history`，接口增加可选的 `from`、`to` 查询参数，返回兼容的历史条目列表。前端新增：

- 日期选择器，默认显示最近 7 天，可选择单日或日期范围。
- 按用户本地日期分组，每组标题显示日期、检测次数、通过/警告/失败探针总数。
- 每条记录显示渠道、模型、分类、得分、风险、执行时间和警告/失败数量。
- 点击记录后在主区域加载完整历史结果，并保留所选日期和筛选条件。
- 现有渠道/URL/模型搜索、风险筛选和“当前渠道”筛选继续可用。
- 空状态分别区分“当天没有检测”和“筛选条件没有匹配记录”。

后端日期过滤使用 UTC 时间边界；前端把用户选择的本地日期转换为 ISO 时间范围，避免跨时区漏掉当天记录。

## 身份探针

在 Claude 指纹探针配置中增加两个自然问答探针：

1. `identity_direct`: “你是谁？由哪家公司开发？请简短回答。”
2. `identity_greeting`: “你好，请简单介绍一下你自己。”

判定要求：

- 明确自报 Claude/Anthropic 可作为通过证据。
- 明确自报 OpenAI、ChatGPT、GPT、Gemini 等其他身份时产生 `identity_mismatch` 警告。
- 含糊回答“我是 AI 助手”时记录 `identity_uncertain`，不直接失败。
- 两项 severity 均为 `weak`，归入行为验证分组；自报结果最多形成辅助警告，不单独推翻硬协议证据。
- mock 模式保持确定性：Claude/官方/候选 Claude 样本返回 Claude/Anthropic，negative 样本返回非 Claude 身份。

## 数据流

1. `_claude_code_probe_configs` 定义探针目标、请求和评分意图。
2. `create_claude_code_test` 调用渠道并得到 normalized response。
3. `_claude_code_probe_payload` 统一生成状态、原因、错误、请求快照和结构化证据。
4. job 进度接口原样传递同一探针 payload，支持运行中展开详情。
5. 完成后 `create_claude_code_evidence` 保存已脱敏的 result payload。
6. 历史列表按日期过滤并返回概要；历史详情返回同一 result payload。
7. 前端使用共享详情组件展示实时结果和历史结果。

## 错误与安全处理

- `error_detail` 和 `request_snapshot` 在进入 API 响应和数据库前调用现有脱敏逻辑。
- 不保存 API Key、Authorization、x-api-key、cookie、secret_ref 展开值或运行时 credential。
- 对无法分类的错误保留原始已脱敏文本，并使用 `unknown_upstream_error`，不得伪装成“能力不支持”。
- Web Search 的 401/403、429、5xx、连接错误和超时分别保留其运营含义。
- 若完整错误文本过长，数据库保存脱敏后的完整错误，页面默认折叠并允许展开/复制；列表摘要仍限制长度。

## 测试策略

后端测试覆盖：

- Web Search 正常 server tool 响应判通过。
- Web Search tool result error、明确不支持、模型声明无联网、缺少证据和运营错误分别得到正确状态与原因。
- 探针 payload 完整包含原因、标签解释、HTTP/错误、请求快照和结构化证据，且凭据被移除。
- 两个身份探针存在，自报 Claude、非 Claude 和含糊身份分别产生预期结果。
- 历史接口 `from`/`to` 边界正确且不破坏无参数调用。
- 旧历史 payload 缺少新字段时仍可读取。

前端测试覆盖：

- 警告/失败行可以展开并看到完整判定原因和错误。
- 实时 job 与历史结果复用相同详情展示。
- 历史按日期分组、范围过滤、每日统计和空状态正确。
- Web Search 不支持显示为能力跳过/警告，不显示为 Claude 真伪失败。
- 身份探针在行为分组中显示且使用弱权重。

最终验证运行后端 pytest、前端测试和生产构建，并在浏览器中检查 Claude 指纹页面的桌面宽度、横向表格、展开详情和历史抽屉。

## 完成标准

- 官方 Web Search 成功证据在 Claude 指纹页面显示“通过”，不再显示“不支持联网”。
- 每条警告都能在页面中看到明确原因和完整已脱敏错误，不依赖截断 tooltip。
- 用户能选择某一天并查看当天所有 Claude 指纹检测及其探针统计。
- 页面包含“你是谁”和“你好”两类自然身份探针，且身份自报保持弱权重。
- 新旧历史可读，API Key 从未进入数据库或返回 payload。
