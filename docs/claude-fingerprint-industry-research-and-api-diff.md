# Claude / Claude Code 指纹检测开发文档

> 版本：2026-07-19；本文是实现依据与证据边界，不是“官方直连证明”。

## 1. 调研结论

业界通常把“客户端兼容性”“协议一致性”和“上游来源”分成三层：LiteLLM、OneAPI/New API、APIPro 类网关会暴露统一 OpenAI/Anthropic 接口，并可能做模型别名、供应商路由、重试、限流、缓存和错误包装；Bedrock、Microsoft Foundry、Vertex 等官方云适配器则保留 Claude 能力，但 endpoint、认证、模型 ID、request-id 和流式外壳可以合法不同。因此，响应形状最多证明 Claude-compatible，不能单独证明 Anthropic 官方直连。

主参考资料：

- [Claude Code: Other LLM gateways](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)：Gateway 接收 Claude Code 的 Anthropic Messages 契约；可转发到 Anthropic API、Bedrock、Foundry、Google Cloud 或其他 provider。`/v1/models?limit=1000` 是显式开启发现时使用的可选端点，客户端有超时和重定向失败边界。
- [Claude API: Messages](https://docs.anthropic.com/en/api/messages)：请求/响应的 `message`、`content`、`model`、`stop_reason`、`usage` 和错误 envelope。
- [Claude API: Streaming messages](https://docs.anthropic.com/en/api/messages-streaming)：`message_start`、content block 生命周期、`message_delta`、`message_stop`；服务端工具和 ping/error 可插入事件流。
- [Claude API: Extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)：thinking block 带 `signature`；后续 tool-use 回合必须原样带回完整 thinking block。
- [Claude API: Count tokens](https://docs.anthropic.com/en/api/messages-count-tokens)：独立的 token 估算能力，是否实现不改变 Messages API 来源结论。
- [Claude API: Models](https://docs.anthropic.com/en/api/models-list)：模型发现属于能力接口，不是上游来源凭据。

## 2. Claude Code 与 Claude API 的职责差异

| 维度 | Claude API | Claude Code Gateway | 检测意义 |
|---|---|---|---|
| 主要调用 | `/v1/messages` | 同一 Messages 形状，加客户端会话/代理上下文 | 相同 shape 只能证明兼容 |
| 可选端点 | `/v1/messages/count_tokens` | `/v1/models?limit=1000`、可选 count_tokens | 404 记“不支持”，不扣来源分 |
| 请求头 | `anthropic-version`、认证头、beta | `x-claude-code-session-id`、agent/parent-agent ID、beta | 自发 header 只证明接受契约 |
| Attribution | 普通 Messages 不要求 | Claude Code 可发送 attribution system block | 只证明网关接受客户端语义 |
| thinking | `thinking` + `signature` | 工具回合中继续携带完整 assistant blocks | 跨请求验证强于自报，但失败不单独判非 Claude |
| 流式 | 原始 SSE 生命周期 | Gateway 可透传、重分块或重建 | 比较事件顺序、index、delta 和结束状态 |
| 来源 | API Key/OAuth/组织控制面 | 可路由多个 provider | 只有账单、request-id 回查或云审计能确认来源 |

## 3. 证据分级与业界网关指纹

### 强证据（仍非官方直连）

- 官方正向 thinking signature、官方篡改拒绝控制组稳定通过。
- 候选生成的 signature 被官方基线连续接受，候选篡改样本连续被拒绝。
- thinking + tool_use + tool_result 跨轮 block 顺序、`toolu_`、JSON input 和原样回传均成立。

### 中证据

- Messages 字段、`msg_`/`toolu_`、错误类型、参数边界、SSE 原始生命周期和 usage 结构与同模型官方基线一致。
- 3/5 次重复采样中无混合路由特征切换。

### 弱证据

- 模型自报 Claude、Claude Code headers、attribution、`/v1/models` 成功、`count_tokens` 成功。
- 延迟、自然语言风格、TCP chunk 大小和单次 token 数差异。

### 网关控制面痕迹

响应头族只用于解释访问路径和中转控制面，不参与 `official_origin_confirmed`，也不直接触发 `model_swap_suspected`：

- `X-Apipro-*` → APIPro 类控制面迹象。
- `X-Oneapi-*` → OneAPI/New API 类控制面迹象。
- `X-New-Api-*` / `X-NewAPI-*` → New API 类控制面迹象。
- `Via`、`X-Envoy-*`、`X-Forwarded-*` → 代理/服务网格迹象；通用 `Server` 头只记录名称，不单独触发代理判定。
- `CF-Ray`、`CF-Cache-Status` → Cloudflare 边缘迹象。
- `X-Amzn-*`、`X-Ms-*`、`X-Goog-*` → 云适配器或云边缘迹象；不能仅凭头名断言具体上游。

只保留头名称、家族和证据引用，不保存头值、认证头或完整 signature。

## 4. 检测矩阵

| 探针 | 记录 | 判定用途 |
|---|---|---|
| 双向 signature | 官方控制组、官方→候选、候选→官方、篡改对照、重复次数 | `signature_chain_verified` 的必要条件 |
| Thinking + Tool Use | thinking/signature、`toolu_`、tool name/input、block 顺序 | 协议连续性；不支持则 `not_applicable` |
| 参数/错误差分 | max_tokens、stop、非法类型、未知字段、thinking/tool 冲突、状态/error path | 两个以上独立稳定偏离 → `protocol_reconstruction_suspected` |
| SSE 原始生命周期 | event/index/delta/usage/ping/error/TTFT/结束状态 | 重建和分块证据；TCP chunk 仅弱证据 |
| Usage/Tokenizer | 中英文、Unicode、代码、数字、JSON；usage/cache 字段和比率 | 至少三个显著偏离且有其他硬异常 → tokenizer/usage rewrite |
| 路由重复采样 | message-id、model、signature、error schema、usage keys、header names | 两类以上关联硬特征切换 → `mixed_routing_suspected` |
| 网关 fingerprint | header family、probe evidence refs | 访问路径解释，不提升来源等级 |

## 5. 结果契约与安全边界

`upstream_integrity` 固定返回：

- `classification`: `signature_chain_verified`、`mixed_routing_suspected`、`protocol_reconstruction_suspected`、`model_swap_suspected`、`insufficient_evidence`、`operationally_inconclusive`。
- `confidence`: `low | medium | high`。
- `official_origin_confirmed`: 当前固定为 `false`。
- `probe_matrix`、`limitations` 和 `gateway_fingerprint`。

认证失败、403、429、余额/配额、超时和 5xx 只进入运营异常；模型不可比、缺少官方基线或 thinking 不支持时不强行判换模。透明转发无法仅靠 API 响应区分 API Key、Claude.ai OAuth 和无改写代理。

## 6. 分阶段开发与验收

### 已完成

1. 标准/深度模式和 3/5 次重复配置。
2. 双向 signature、tool loop、参数错误、SSE、usage/tokenizer、路由重复采样。
3. `anthropic_endpoint_configured` 文案和透明转发限制。
4. 网关头族聚合：仅名称/家族/证据引用，响应中不保存敏感值。

### 下一阶段

1. 为每个深度探针增加显式预算估算、耗时上限和前端进度阶段。
2. 为 Bedrock/Foundry/Vertex 增加 provider-specific reference band，避免把合法云差异当协议重建。
3. 增加可选的 request-id 控制面回查接口；接入前仍保持 `official_origin_confirmed=false`。
4. 为历史结果增加网关 fingerprint 趋势视图，区分“控制面变更”和“模型协议变更”。

验收要求：后端/前端全量测试、生产构建、敏感字段扫描；测试必须证明 gateway headers、`/v1/models` 单独成功、count_tokens 404 和 attribution 不会提升上游完整性等级。
