# Claude Code 与 Claude 官方 API 参数及响应差异调研

> 调研日期：2026-07-19
> 适用对象：Claude 渠道兼容性、Claude Code 网关兼容性、协议纯度与上游完整性检测
> 事实来源：以 Anthropic 官方 Claude Code 文档和 Claude Platform API 文档为主；本文不把规划文档或第三方网关实现当作官方协议事实。

## 1. 结论摘要

Claude Code 不是一个“参数名不同的 `/v1/messages` 客户端”，而是建立在 Claude Messages API 之上的完整 agent runtime。它负责会话、工具循环、权限、文件系统、MCP、子代理、重试、预算、上下文压缩和结果聚合；Claude 官方 Messages API 只处理一轮无状态的模型请求。

因此需要分清三个接口面：

1. **Claude Code CLI / Agent SDK 输入接口**：`--max-turns`、`--max-budget-usd`、`--permission-mode`、`--tools`、`--json-schema`、`--resume` 等客户端参数。
2. **Claude Code 发往上游或网关的 Messages 协议**：`POST /v1/messages`、可选 `POST /v1/messages/count_tokens`、Claude Code 请求头、attribution system block、beta 与 body 字段配对。
3. **Anthropic 官方 Messages API**：`model`、`max_tokens`、`messages`、`system`、`thinking`、`output_config`、`tools`、`tool_choice`、采样参数、原生 Message/SSE/error envelope。

最重要的判断如下：

- Claude Code 的大部分 CLI 参数**不会作为同名字段发送给 Messages API**，而是在客户端改变循环、提示词、工具列表、权限和输出包装。
- Claude Code 的 `json` / `stream-json` 是**客户端输出协议**；它们不是 `/v1/messages` 的非流式 Message JSON 或原始 SSE。
- Claude Code 的 `result.stop_reason` 和 `terminal_reason` 是**agent run 终止语义**；不能直接等同于单次 API Message 的 `stop_reason`。
- Claude Code 的聚合 `usage`、`modelUsage`、`total_cost_usd` 覆盖多轮和多模型调用；官方 API `usage` 只对应单次 Message 请求，且 API 本身不返回 `total_cost_usd`。
- Claude Code 发出的请求仍使用 Anthropic Messages 格式，但增加会话/agent 请求头、attribution system block，以及随版本演进的 beta header 与字段组合。
- Claude Code 网关必须把 `anthropic-version`、`anthropic-beta` 和 Anthropic 格式 body 当作开放集合转发。固定 allowlist、改写 system 数组、重包错误或缓冲 SSE 都会造成可观测差异。
- `x-claude-code-session-id`、attribution、`/v1/models` 或 `count_tokens` 成功只证明 Claude Code 契约兼容，**不能单独证明 Anthropic 官方直连**。

## 2. 比较边界

### 2.1 Claude 官方 Messages API

核心端点是 `POST /v1/messages`。每次请求显式传入完整上下文，服务端返回下一条 assistant Message。多轮对话由调用方把历史 `messages` 再次提交，因此 API 本身是无状态的。

当前文档列出的顶层 body 参数包括：

| 类别 | 参数 |
|---|---|
| 必填 | `model`、`max_tokens`、`messages` |
| 提示与输出 | `system`、`stop_sequences`、`output_config` |
| 推理 | `thinking`、`output_config.effort` |
| 工具 | `tools`、`tool_choice` |
| 采样 | `temperature`、`top_p`、`top_k` |
| 传输与服务 | `stream`、`service_tier`、`inference_geo` |
| 缓存与服务端资源复用 | `cache_control`、`container` |
| 归因 | `metadata.user_id` |

### 2.2 Claude Code CLI / Agent SDK

Claude Code 输入的是一个**任务或会话**，一次运行可能产生多次 Messages API 调用：模型提出工具调用，客户端执行工具，把 `tool_result` 回传，再继续请求，直至任务完成、达到 turn/cost 限制、被权限或 hook 阻止，或出现 API/运行时错误。

CLI 的主要参数族包括：

- 会话：`--continue`、`--resume`、`--fork-session`、`--session-id`、`--no-session-persistence`。
- agent 循环：`--max-turns`、`--max-budget-usd`、`--fallback-model`、`--advisor`、`--agent`、`--agents`。
- 权限与工具：`--permission-mode`、`--allowedTools`、`--disallowedTools`、`--tools`、`--mcp-config`、`--strict-mcp-config`。
- 提示词：`--system-prompt`、`--append-system-prompt` 及对应 file 版本。
- 输入输出：`--input-format`、`--output-format`、`--json-schema`、`--include-partial-messages`、`--verbose`。
- 运行环境：`--add-dir`、`--worktree`、`--bare`、`--safe-mode`、`--settings`、`--plugin-dir`。
- API 能力选择：`--model`、`--effort`、`--betas`。

这些参数中，只有少数能较直接映射到一个 API 字段；多数由 Claude Code 在本地消费。

### 2.3 Claude Code Gateway Protocol

当使用 `ANTHROPIC_BASE_URL` 时，Claude Code 把目标当作 Anthropic Messages 格式网关。官方协议要求或说明：

- 推理：`POST /v1/messages?beta=true`，网关按 path 匹配，不要要求完整 URL 完全相等。
- token 计数：`POST /v1/messages/count_tokens`，可选；缺失时 Claude Code 本地估算上下文占用。
- 模型发现：启用 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 后请求 `GET /v1/models?limit=1000`。
- 启动流量：可能出现可拒绝的 `HEAD /` 连通性探针。
- 响应必须实时传递 SSE；把完整响应缓存完再转发会卡住客户端。

## 3. 请求参数差异总表

### 3.1 可近似映射的参数

| Claude Code | Messages API | 一致性 | 说明 |
|---|---|---:|---|
| `--model` / `ANTHROPIC_MODEL` | `model` | 高 | Claude Code 接受 alias 或完整模型 ID，还可能经过默认模型、fallback 和网关映射；线上 body 中的具体值不一定等于用户输入字符串。 |
| `--effort` / `CLAUDE_CODE_EFFORT_LEVEL` | `output_config.effort` | 中高 | 支持级别依模型而变；Claude Code 还会结合模型识别和 adaptive thinking 策略。API 的 effort 是单请求软提示，CLI effort 是会话默认。 |
| `--betas` | `anthropic-beta` header | 高 | 只适用于 API key 用户；Claude Code 还会自动加入自身所需 beta，不能把 `--betas` 当作完整 header 列表。 |
| `--system-prompt` | `system` | 中 | CLI 替换默认 Claude Code system prompt；API 直接把调用方给定的顶层 system 送入单次请求。 |
| `--append-system-prompt` | `system` 的组合结果 | 中 | Claude Code 先保留默认 coding/tool/safety prompt，再追加内容；API 没有 append 参数，调用方自己拼接。 |
| `--json-schema` | `output_config.format` | 中 | 两者目标相近但执行面不同。Claude Code 会完成 agent workflow、客户端校验和重试，并把结果放在 `structured_output`；API 直接约束单次模型最终输出。 |
| `--tools` | `tools` | 低到中 | CLI 参数是 Claude Code 内建工具可见性过滤器；API `tools` 是调用方提供的 tool schema 数组。名称相似但不是同一个数据结构。 |
| `MAX_THINKING_TOKENS` | 旧式 `thinking.budget_tokens` | 中 | 只在固定 thinking 模式生效；adaptive 模型上通常被忽略，除非显式禁用 adaptive thinking。 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `max_tokens` | 中 | 它设置 Claude Code 多数上游请求的输出上限，并影响 auto-compaction；不是 CLI 每次都原样透传的公开固定 body 契约。 |

### 3.2 Claude Code 有、Messages API 没有同名语义的参数

| Claude Code 参数 | 客户端实际职责 | 为什么不能直传为 API 参数 |
|---|---|---|
| `--max-turns` | 限制 agent loop 的模型回合数 | API `max_tokens` 限制一轮输出 token，不限制工具循环轮数。 |
| `--max-budget-usd` | 按客户端成本估算终止整个运行 | Messages API 没有美元预算参数，也不返回美元成本。 |
| `--permission-mode` | 控制本地工具执行是否询问、拒绝或自动批准 | 模型 API 不负责本机权限。 |
| `--allowedTools` / `--disallowedTools` | Claude Code permission rules | 与 API `tool_choice` 不同；前者是客户端授权策略，后者是模型是否必须/可以选工具。 |
| `--continue` / `--resume` / `--fork-session` | 从本地持久化 transcript 恢复或分叉会话 | Messages API 无 server-side conversation/session 参数；调用方重发历史。 |
| `--session-id` | 指定 Claude Code 会话 UUID | 不等于 API response `message.id`，也不是 Messages body 字段。 |
| `--output-format` | 控制 Claude Code stdout 包装 | API 非流式固定返回 Message，流式固定使用 SSE。 |
| `--input-format stream-json` | 允许向正在运行的 agent 输入 NDJSON 消息 | API 输入是一个 HTTP JSON body，不是 Claude Code 控制流。 |
| `--include-partial-messages` | 在 Claude Code stream-json 中嵌入原始 API partial events | API 只需 `stream: true` 即直接返回 SSE。 |
| `--fallback-model` | 客户端在过载/不可用时换模型 | 官方 API 单次请求不接受 fallback chain。 |
| `--advisor` | 增加 Claude Code advisor 工具/模型 | 不是 Messages API 通用参数；可能导致额外模型请求。 |
| `--agents` / `--agent` | 配置子代理与它们的 system prompt、tools、model | API 没有子代理编排概念。 |
| `--mcp-config` | 启动外部 MCP servers 并把能力转成 Claude Code 工具 | API 只看到最终发送的工具定义或 tool reference。 |
| `--settings` / `--plugin-dir` / `--bare` / `--safe-mode` | 控制本地配置发现和 runtime | 不属于模型推理请求。 |
| `--worktree` / `--add-dir` | 控制本地文件系统作用域 | API 不访问用户文件系统。 |

### 3.3 Messages API 有、Claude Code CLI 不直接暴露的参数

Claude Code 通常自行管理这些值，或者只通过环境变量、settings、内部策略和版本能力间接影响：

| API 参数 | Claude Code 情况 | 检测意义 |
|---|---|---|
| `messages` | 由 transcript、工具结果、压缩摘要、synthetic/user 消息自动构造 | 不能拿 CLI prompt 直接与 body 的最后一条 user 文本做逐字等价比较。 |
| `max_tokens` | 由模型默认、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、thinking 和上下文策略控制 | 应记录线上请求值，而不是只记录 CLI 配置。 |
| `temperature` / `top_p` / `top_k` | CLI 没有对应常规 flag | Claude Code 和直接 API 做行为对比时，不能假设采样参数相同；需要抓取或在可控网关记录请求。 |
| `stop_sequences` | CLI 没有通用直接 flag | Claude Code 的 run 停止主要由 agent loop 和客户端状态机决定。 |
| `tool_choice` | CLI 不直接暴露为同名参数 | `--tools`/权限不能替代 `tool_choice` 的协议测试。 |
| `service_tier` | 通常由认证/计划/fast mode 与内部策略决定 | Claude Code 输出可能报告 service tier，但用户没有等价的常规 CLI body 参数。 |
| `inference_geo` | CLI 无一一对应 flag | API response usage 可带 inference geo；Claude Code 聚合时应按请求或模型统计理解。 |
| `metadata.user_id` | CLI 无通用 flag | Claude Code 有自己的 session/agent headers，不等于 API abuse metadata。 |
| `container` | 由 server tool/code execution 场景管理 | Claude Code 的本地 Bash 工作目录不等于 API container。 |
| `cache_control` | Claude Code 自动管理 prompt caching 和断点 | 网关改写 block 顺序或合并内容可能改变缓存命中。 |
| `thinking.display` | CLI 无常规直接 flag | 新模型默认可能为 `omitted`，看到空 thinking + signature 不能判定没有思考。 |

## 4. Thinking、Effort 与采样参数的不一致

这是最容易因模型版本变化而误判的部分。

### 4.1 当前官方模型规则

- Opus 4.8、Opus 4.7、Sonnet 5 使用 adaptive thinking；手动 `thinking: {type: "enabled", budget_tokens: N}` 会返回 400。Sonnet 5 默认开启 adaptive thinking，Opus 4.8 / 4.7 需要在请求中显式设置 `thinking: {type: "adaptive"}`。
- Opus 4.6、Sonnet 4.6 推荐 `thinking: {type: "adaptive"}` + `output_config.effort`；旧 `enabled + budget_tokens` 仍可用但已弃用。
- 更早的部分 Claude 4 模型仍使用 `enabled + budget_tokens`，不支持 adaptive。
- adaptive thinking 会自动启用 interleaved thinking；默认 `high` effort 下模型几乎总会思考，低 effort 对简单问题可能跳过 thinking block。
- `effort` 是软信号，影响文本、工具调用参数和 thinking 的全部 token 消耗，不是严格 token cap。

### 4.2 Claude Code 的转换行为

Claude Code Gateway Protocol 明确说明：

- 对 Claude 4.6 及以后模型，Claude Code 会发送 `thinking: {"type":"adaptive"}`。
- 对不认识的网关模型 alias，Claude Code 倾向把它当作当前模型并发送 adaptive 字段。
- 如果 alias 实际映射到不支持 adaptive 的旧模型，上游会返回指向 `thinking` 或 `adaptive` 的 400。
- Opus 4.6 / Sonnet 4.6 可通过 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 退回固定预算；Opus 4.7 及以后不受该开关影响。
- `MAX_THINKING_TOKENS=0` 在 Anthropic API 上表示尽量关闭 thinking；第三方 provider 路径可能只是不发送 `thinking`，adaptive 模型仍可能思考。

因此，对第三方 Claude Code 网关做纯度检测时，以下结果都需要区分：

1. **原生接受**：adaptive + effort 正常工作。
2. **上游模型版本不匹配**：返回与 thinking/adaptive 相关的原生 400。
3. **网关吞参**：请求成功但没有预期参数行为或错误。
4. **网关翻译**：把 adaptive 转为私有 reasoning 参数，响应可用但协议已重建。
5. **错误重包**：状态码保留，但错误 envelope/文本改变，导致 Claude Code 自动降级逻辑失效。

### 4.3 Thinking 与工具的组合约束

直接 API 的扩展 thinking 与 tools 组合时：

- 只支持 `tool_choice: {type: "auto"}` 或 `{type: "none"}`。
- `any` 或指定 `{type: "tool", name: ...}` 会因强制工具调用与 thinking 冲突而报错。
- 工具回合必须把上一条 assistant 中所有 `thinking` 和 `redacted_thinking` blocks **完整、未修改、顺序不变**地传回。
- `display: "omitted"` 时 thinking 文本可以为空，但 signature 仍需原样回传。
- 篡改、重排、过滤或重建 thinking block 会返回 400 `invalid_request_error`。

Claude Code 会自动管理这条链，因此其成功运行不表示普通 API 调用方可以丢弃 thinking blocks。反过来，网关若过滤 thinking、signature 或重排 blocks，会表现为跨工具回合失败。

## 5. 请求头、认证与路径差异

### 5.1 Anthropic 官方 API 的基本请求

直连通常使用：

```http
POST /v1/messages
x-api-key: ...
anthropic-version: 2023-06-01
content-type: application/json
anthropic-beta: ...   # 使用 beta 能力时
```

官方 API 的每个响应都有 `request-id` header；错误 body 同时带 `request_id`。

### 5.2 Claude Code 发给 Anthropic-format 网关的额外头

| Header | 处理方式 | 含义 |
|---|---|---|
| `Authorization` / `x-api-key` | 网关可消费 | 开发者的网关凭证，具体取决于 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 helper。 |
| `anthropic-version` | 原样转发 | 当前官方文档值为 `2023-06-01`。 |
| `anthropic-beta` | 原样转发 | 能力集合随 Claude Code 版本增长；使用 claude.ai OAuth 时还带上游要求的 OAuth capability。 |
| `x-claude-code-session-id` | 可消费 | 聚合同一 Claude Code 会话请求。 |
| `x-claude-code-agent-id` | 可消费 | 仅子代理请求存在；用于 agent 级归因。 |
| `x-claude-code-parent-agent-id` | 可消费 | 嵌套 agent 的父级标识。 |
| `anthropic-workspace-id` | 特定路径原样转发 | Claude Platform on AWS 要求。 |
| `ANTHROPIC_CUSTOM_HEADERS` 生成的头 | 依部署策略 | 用户自定义，不应被误认为 Claude Code 固定指纹。 |

`ANTHROPIC_API_KEY` 被放入 `X-Api-Key`。`ANTHROPIC_AUTH_TOKEN` 会以前缀 `Bearer` 的 `Authorization` 发送。二者的存在还会改变 Claude subscription 是否参与计费。

### 5.3 Claude Code attribution system block

Claude Code 会在 system prompt 最前面加一个短 attribution block，包含客户端版本和会话指纹。

- `api.anthropic.com` 只会在它保持为**第一个、独立、未修改的 system block**时剥离该 block，因此不影响一方 prompt cache。
- 网关若在前面插入 system block、重排数组、把 system 数组合并为字符串，剥离就会失效。
- 如果把 attribution 与真实 system prompt 合并进一个 block，官方端点可能把合并后的整个 block 当 attribution 丢弃，造成真实指令丢失。
- 无法原样保留时，应在客户端用 `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 关闭，而不是由网关随意改写。

这意味着 Claude Code 请求的 `system` 往往与直接 API 调用者手写的 `system` 不同；不能只比较最终回答并假设输入相同。

## 6. 非流式响应结构差异

### 6.1 官方 Messages API Message

单次非流式成功响应的顶层核心结构为：

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "claude-...",
  "content": [
    {"type": "text", "text": "..."}
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 100,
    "output_tokens": 20,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "service_tier": "standard"
  }
}
```

实际 `content` 还可能包含 `thinking`、`redacted_thinking`、`tool_use`、server tool use/result、引用、拒绝等 blocks。当前 `stop_reason` 包括：

- `end_turn`
- `max_tokens`
- `stop_sequence`
- `tool_use`
- `pause_turn`
- `refusal`

### 6.2 Claude Code `--output-format json`

Claude Code 返回的是整个 agent run 的结果 envelope，而不是原生 Message：

```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "...",
  "duration_ms": 12345,
  "duration_api_ms": 9000,
  "is_error": false,
  "num_turns": 4,
  "result": "最终文本",
  "stop_reason": "...",
  "terminal_reason": "completed",
  "total_cost_usd": 0.123,
  "usage": {...},
  "modelUsage": {...},
  "permission_denials": [],
  "structured_output": {...}
}
```

差异要点：

| 维度 | Messages API | Claude Code result |
|---|---|---|
| 粒度 | 单次模型请求 | 完整 agent 运行，可能多轮、多模型、多 agent |
| 主要文本 | `content[]` 中的 text block | `result` 字符串 |
| 会话标识 | 无服务端 conversation ID；只有 `message.id` | `session_id`，可用于 resume |
| 回合数 | 无 | `num_turns` |
| 时延 | API 不在 body 给完整客户端运行时 | `duration_ms`、`duration_api_ms`、TTFT 字段 |
| 成本 | token usage，无美元总价 | `total_cost_usd`，客户端估算；另有 per-model breakdown |
| 错误 | HTTP 状态 + error envelope | `subtype`、`is_error`、`errors`、`terminal_reason`，并可能保留 `api_error_status` |
| 权限结果 | 无 | `permission_denials` |
| 结构化输出 | text block 符合 `output_config.format` | 聚合/校验后放在 `structured_output` |

### 6.3 Claude Code assistant message 是包裹后的原生 Message

在 Agent SDK / stream-json 中，完整 assistant 事件形如：

```ts
{
  type: "assistant",
  uuid: "...",
  session_id: "...",
  message: BetaMessage,
  parent_tool_use_id: null,
  error?: "rate_limit" | "overloaded" | "invalid_request" | ...
}
```

其中 `message` 才是包含 `id`、`content`、`model`、`stop_reason`、`usage` 的 Anthropic Message。检测工具如果把外层 `type: "assistant"` 当成 API message `type: "message"` 的不一致，会产生误报。

同一 API turn 还可能产生多个共享相同 `message.id` 的 Claude Code assistant messages，外层 `uuid` 和 `timestamp` 不同。因此：

- `uuid` 是 Claude Code transcript/event 标识，不是 Anthropic message id。
- `session_id` 是 Claude Code 会话标识，不是 Anthropic request id。
- `parent_tool_use_id` 是子代理归属，不是当前 Message 的 stop/tool id。

## 7. 流式响应差异

### 7.1 官方 API 原始 SSE

`stream: true` 时，官方生命周期为：

1. `message_start`
2. 每个 block 的 `content_block_start`
3. 一个或多个 `content_block_delta`
4. `content_block_stop`
5. 一个或多个 `message_delta`
6. `message_stop`

期间可以插入任意数量 `ping`，也可能在 HTTP 200 之后收到 `event: error`。主要 delta 类型包括：

- `text_delta`
- `input_json_delta`
- `thinking_delta`
- `signature_delta`
- 引用等新增 delta

`message_delta.usage` 是累计值；消费者必须容忍未来增加未知事件类型。

### 7.2 Claude Code `stream-json`

Claude Code 输出的是 NDJSON 事件总线，而不是裸 SSE。可能包含：

- `system/init`
- `assistant`
- `user` / tool result / replay
- `stream_event`，其 `event` 内部才是原始 `BetaRawMessageStreamEvent`
- hooks、tool progress、task、rate limit、API retry、compaction、notification 等 Claude Code 事件
- 最后一条 `result`

只有同时使用：

```bash
claude -p --output-format stream-json --verbose --include-partial-messages "..."
```

才会收到 token 级 partial message；其结构为：

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {"type": "text_delta", "text": "..."}
  },
  "session_id": "...",
  "uuid": "...",
  "parent_tool_use_id": null
}
```

所以正确对比方式是提取 `event` 再与 API SSE data 比较，而不是拿整个 NDJSON 对象比较。

另外：

- Claude Code 会在 API 可重试失败前发 `system/api_retry`，然后自动重试。
- 子代理默认只转发其 `tool_use` / `tool_result`；要看到其 text/thinking，需要 `--forward-subagent-text`。
- stream-json 最后一行是聚合 `result`，API 原始 SSE 最终是 `message_stop`，没有 Claude Code result envelope。
- 网关缓冲 SSE 会显著增加 Claude Code 的可见 TTFT，即便最终 JSON 内容完全一致。

## 8. Usage 与成本响应差异

### 8.1 官方 API usage

单请求 `usage` 当前可包含：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `cache_creation` 的 5m / 1h breakdown
- `output_tokens_details.thinking_tokens`
- `server_tool_use.web_search_requests`
- `server_tool_use.web_fetch_requests`
- `service_tier`
- `inference_geo`

官方说明，总输入量是 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。可见文本与 token 数不一一对应，空文本也可能有非零 output tokens。

### 8.2 Claude Code 聚合 usage

Claude Code result 的 `usage` 是运行级聚合，`modelUsage` 是按模型的统计，并可能覆盖：

- 主 agent 多次请求
- fallback 模型
- advisor
- 子代理
- 工具循环
- prompt cache

`total_cost_usd` 和每模型 `costUSD` 是客户端估算，不应视为上游账单字段。官方 Agent SDK 文档还提醒：顶层 `usage.output_tokens` 不包含完整子代理树的全部 token，若要整个树的核算应看 `modelUsage`。

检测平台应保存三层指标：

1. 原始单请求 API usage。
2. Claude Code run 聚合 usage。
3. 估算成本及其算法/版本。

不可用 Claude Code 聚合 token 与一次直连 API 的 token 做直接比例判定；即使 prompt 文本相同，Claude Code 还注入 system prompt、tools、缓存断点和历史上下文。

## 9. 错误响应与重试差异

### 9.1 官方 API 错误

非流式错误形如：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "..."
  },
  "request_id": "req_..."
}
```

主要 HTTP 对应包括：400 invalid request、401 authentication、402 billing、403 permission、404 not found、409 conflict、413 request too large、429 rate limit、500 API error、504 timeout、529 overloaded。流式连接建立后还可能在 HTTP 200 内收到 SSE error event。

### 9.2 Claude Code 错误

Claude Code 可能把失败表示为：

- assistant wrapper 上的 `error`: `authentication_failed`、`billing_error`、`rate_limit`、`overloaded`、`invalid_request`、`model_not_found`、`server_error`、`max_output_tokens` 等。
- result `subtype`: `error_max_turns`、`error_during_execution`、`error_max_budget_usd`、`error_max_structured_output_retries`。
- `api_error_status`: 终止运行的上游 HTTP 状态。
- `terminal_reason`: `max_turns`、`budget_exhausted`、`hook_stopped`、`prompt_too_long`、`api_error`、`malformed_tool_use_exhausted` 等更细的 agent runtime 原因。
- `permission_denials` 或 `deferred_tool_use`: 本地权限流程，并非上游 API 错误。

### 9.3 网关为何必须保留错误 body

Claude Code 会对部分上游拒绝自动重试，并在当前会话关闭被拒绝能力。官方协议明确提到 thinking 字段、thinking signature、mid-conversation system message 等拒绝可触发恢复逻辑，而 context management 和部分 tool schema 400 不会自动恢复。

该重试逻辑会匹配上游错误文案。因此网关如果：

- 把错误改成统一 `{code, msg}`；
- 只保留 HTTP status，丢掉原始 message；
- 把 400 改成 500；
- 把流内 error 改成正常 `message_stop`；

就会改变 Claude Code 的行为，即使最后人工看起来“仍返回了错误”。错误 envelope 和文案稳定性应作为 Claude Code 兼容性测试的重要维度，但它仍不能单独证明上游来源。

## 10. Token Count 与 Model Discovery 差异

### 10.1 `/v1/messages/count_tokens`

- 官方 API 提供独立 token counting endpoint，接受与 Message 类似的 messages/tools/images/documents 输入。
- 对 Claude Code 网关它是可选能力；404/未实现时客户端会本地估算上下文。
- 因此 count_tokens 不可用是能力缺失，不应直接记为非 Claude 或模型替换。
- 精确计数与本地估算的偏差可以作为 tokenizer/请求重写的辅助证据，但必须配合原始请求、缓存字段和模型版本。

### 10.2 `/v1/models?limit=1000`

Claude Code 的 gateway model discovery：

- 默认关闭，需 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`。
- 仅 `ANTHROPIC_BASE_URL` 的 Anthropic Messages 格式网关使用。
- 3 秒超时，重定向直接视为失败，避免凭证泄漏到跳转目标。
- 只读取 `data[].id` 和可选 `display_name`。
- 忽略不以 `claude` 或 `anthropic` 开头的 id。
- 失败后使用缓存或内置模型列表。

所以 `/v1/models` 成功只是网关发现能力，不是推理上游证明；失败也不代表 `/v1/messages` 不兼容。

## 11. 直接 API 与 Claude Code 做对照实验的正确方法

### 11.1 不应使用的对比

- 同一个自然语言 prompt，比较 Claude Code 最终 `result` 和一次 API text，要求逐字一致。
- 把 Claude Code `session_id` 与 API `msg_...` 或 `req_...` 比较。
- 把 Claude Code stream-json 的外层事件序列与 API SSE event name 比较。
- 把 `--max-turns` 当 `max_tokens`。
- 把 `--tools` 当 `tool_choice`。
- 把 Claude Code `total_cost_usd` 当上游返回字段。
- 看到 `x-claude-code-session-id` 就断言官方 Claude Code 上游。
- `/v1/models` 或 count_tokens 404 就降低 Claude 模型真实性分。

### 11.2 推荐的可比实验

要比较 Claude Code 通道与官方 API，至少控制：

1. 相同具体模型 ID，而不是只用 `sonnet`/`opus` alias。
2. 相同 system prompt；Claude Code 可用 `--system-prompt` 或 Agent SDK 自定义 prompt，必要时关闭 attribution。
3. 相同工具 schema；Claude Code 内建工具与 MCP 工具需转换成可记录的最终 API tools。
4. 相同 thinking 模式和 effort；按模型版本选择 adaptive 或 fixed budget。
5. 相同 `max_tokens`，并记录 Claude Code 实际线上 body，而非只记录环境变量。
6. 相同历史消息和 thinking/tool blocks。
7. 相同 beta header 能力集合。
8. 分别比较每个上游 Message，而不是只比较整个 agent run。

最理想的方法是在受控网关记录脱敏后的：

- endpoint/path 和 query；
- header 名称及非敏感 capability 值；
- body 字段名、模型、参数和值的哈希/安全摘要；
- SSE 原始 event/type/index；
- response Message、error 和 request-id；
- Claude Code 外层 session/result 事件。

## 12. 面向本项目的检测规则建议

### 12.1 评分分层

建议继续把结论拆成三层：

| 层 | 评估对象 | 可用证据 | 不应得出的结论 |
|---|---|---|---|
| Claude / Messages 兼容性 | 单次上游模型协议与行为 | Message schema、SSE、thinking、tool use、usage、参数错误 | 不能证明官方直连 |
| Claude Code 兼容性 | 客户端到网关的完整 contract | session/agent headers、attribution、beta/body 配对、实时 SSE、错误透传、count_tokens | 不能证明上游一定是 Anthropic |
| 上游完整性 | 是否稳定接近可核验官方基线 | 双向 signature、篡改对照、request-id 控制面、账单/云审计、重复差分 | 透明转发仍可能无法仅靠响应识别凭证来源 |

### 12.2 可直接新增或强化的探针

| 探针 | 操作 | 预期/判定 |
|---|---|---|
| CLI/API envelope 分离 | 同时保存 Claude Code 外层 event 和内层 `message` | 防止把 wrapper 差异判为协议错误。 |
| Attribution 位置探针 | 记录 system block 数量、首 block 类型和顺序摘要 | 重排/合并提示 gateway 改写；不要存完整 system secret。 |
| Open-list forward 探针 | 发送安全的受支持 beta + 配套字段 | header/body 一半被剥离通常出现原生 400。 |
| Adaptive alias 探针 | 用网关 alias 与显式官方模型 ID 各跑一次 | alias 独有 adaptive 400 表示模型映射/能力声明异常。 |
| Error pass-through 探针 | 构造无害非法参数与 thinking signature 篡改对照 | 对比状态、type、message path、request-id；重包归为 gateway trace。 |
| SSE buffer 探针 | 比较 message_start TTFT、首 text delta、总时延 | 最终内容一致但 TTFT 接近总时延，提示缓冲。 |
| Token count 降级探针 | count_tokens 可用/404 两组运行 | 只影响计数精度和 UX，不降基础 Claude 分。 |
| Model discovery 探针 | 显式启用后请求 `/v1/models?limit=1000` | 记录 capability；redirect/timeout/过滤行为单独分类。 |
| Run/API usage 分层 | 保存 request usage、run usage、modelUsage、估算成本 | 防止跨粒度误比。 |
| Tool permission 对照 | 同 tool schema，改变 Claude Code permission mode | 模型 `tool_use` 与客户端是否执行要分别评分。 |

### 12.3 建议标签

现有标签之外，可以考虑增加：

- `claude_code_wrapper_confused_with_api_message`：检测器输入层级错误，属于自身诊断标签。
- `claude_code_attribution_rewritten`：system attribution 被移动、合并或删除。
- `beta_body_pair_stripped`：beta header 与配套 body 字段只保留一侧。
- `upstream_error_rewrapped`：状态或 error body 未原样透传，可能破坏 Claude Code 自动恢复。
- `stream_buffered_by_gateway`：事件内容合法但实时性被缓冲破坏。
- `gateway_model_alias_capability_mismatch`：alias 触发不匹配的 adaptive/effort/tool 能力。
- `client_usage_not_comparable`：比较了 run 聚合 usage 与单请求 usage，应跳过真实性评分。

### 12.4 已实现的 `gateway_contract` 结果

本项目把 Claude Code 网关契约评估放在 `upstream_integrity.gateway_contract`，与 `gateway_fingerprint` 和上游来源分类并列：

```json
{
  "status": "pass | warning | insufficient_evidence",
  "labels": [],
  "checks": [],
  "evidence_refs": [],
  "attribution_observation": "sent_unverified | not_observed",
  "usage_scope": "single_request",
  "official_origin_confirmed": false,
  "interpretation": "..."
}
```

当前实现检测 `upstream_error_rewrapped`、`stream_buffered_by_gateway` 和 `gateway_model_alias_capability_mismatch`。Attribution 只确认客户端发送位置，不宣称网关已原样保持；usage scope 明确为单请求，避免与 Claude Code agent run 聚合值误比。

## 13. 示例：同一个任务在三层中的数据形态

用户运行：

```bash
claude -p --model claude-opus-4-8 --effort medium \
  --output-format stream-json --verbose --include-partial-messages \
  "检查项目并给出 JSON 结论"
```

Claude Code 客户端层配置可能包括：

```json
{
  "session_id": "uuid",
  "model": "claude-opus-4-8",
  "effort": "medium",
  "output_format": "stream-json",
  "tools": ["Read", "Glob", "Grep"],
  "permission_mode": "default"
}
```

某一轮上游 Messages body 更接近：

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 32000,
  "thinking": {"type": "adaptive"},
  "output_config": {"effort": "medium"},
  "system": [
    {"type": "text", "text": "<Claude Code attribution>"},
    {"type": "text", "text": "<Claude Code system prompt>"}
  ],
  "messages": [
    {"role": "user", "content": "检查项目并给出 JSON 结论"}
  ],
  "tools": [
    {"name": "Read", "description": "...", "input_schema": {}}
  ],
  "stream": true
}
```

网关还能看到：

```http
anthropic-version: 2023-06-01
anthropic-beta: <open capability list>
x-claude-code-session-id: <uuid>
```

而 stdout 是多行 Claude Code 事件：

```jsonl
{"type":"system","subtype":"init","session_id":"...","model":"claude-opus-4-8"}
{"type":"stream_event","event":{"type":"message_start",...},"session_id":"..."}
{"type":"stream_event","event":{"type":"content_block_delta",...},"session_id":"..."}
{"type":"assistant","message":{"id":"msg_...","type":"message",...},"session_id":"..."}
{"type":"result","subtype":"success","session_id":"...","num_turns":3,"total_cost_usd":0.12,...}
```

这四种对象都是真实且合理的，但不能混在同一 schema 断言中。

## 14. 局限与时效性

- Claude Code 是高频发布客户端，header、beta、body 字段和事件类型是开放集合。网关和检测器都不应写死未知字段拒绝策略。
- 官方文档会随当前模型更新。本文引用的 Sonnet 5、Opus 4.8 等规则是 2026-07-19 的快照；执行测试时仍应记录模型 ID 与 Claude Code 版本。
- Claude Code 使用订阅 OAuth、Console API key、Anthropic-format gateway、Bedrock、Google Cloud、Foundry、Claude Platform on AWS 时，认证和外层协议会合法不同。
- 响应结构高度一致只能证明协议兼容。第三方网关可以转发、重建或模拟这些字段；官方来源仍需 request-id 回查、账单或云审计等控制面证据。
- 行为输出受 Claude Code system prompt、工具、缓存、上下文压缩和多轮循环影响，不能把自然语言差异直接归因于底层模型替换。

## 15. 官方来源

### Claude Code

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Run Claude Code programmatically / headless mode](https://code.claude.com/docs/en/headless)
- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)
- [Gateway overview](https://code.claude.com/docs/en/gateways)
- [Environment variables](https://code.claude.com/docs/en/env-vars)

### Claude Platform API

- [Create a Message](https://platform.claude.com/docs/en/api/messages/create)
- [Count tokens in a Message](https://platform.claude.com/docs/en/api/messages/count_tokens)
- [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Claude API errors](https://platform.claude.com/docs/en/api/errors)
- [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
