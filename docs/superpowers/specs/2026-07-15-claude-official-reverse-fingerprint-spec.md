# Claude 官方、官方云、Gateway/逆向与换模指纹检测 Spec

日期：2026-07-15

## 1. 目标与结论边界

本功能用于回答两个不同问题：

1. 渠道是否与 Claude Messages API 和 Claude/ClaudeCode 行为高度一致？
2. 渠道来源是否能被证明为 Anthropic 官方直连或官方云资源？

两者不能混为一谈。第三方中转可以仿造 `msg_`、`toolu_`、错误 JSON、SSE 事件和模型自报，也可以真实转发 Anthropic/Bedrock/Foundry 上游。因此：

- 非官方 host 检测通过，只能写“Claude-compatible”“官转高一致性”或“ClaudeCode 链路可用”。
- 只有官方域名、账号/账单、云资源、IAM/审计日志和可回查 request id 等控制面证据，才能支撑“官方直连/官方云”来源结论。
- 多项独立异常经重复采样后，才写“疑似参数改写”“疑似换模”或“likely non-Claude”。

## 2. 官方资料基线

截至 2026-07-15，官方文档确认：

- Messages 流式响应使用 SSE，关键生命周期为 `message_start`、每个 block 的 `content_block_start/delta/stop`、一个或多个 `message_delta`、最终 `message_stop`；`ping` 和流内 `error` 可穿插。
- 工具调用使用 `tool_use` block，client tool 常以 `stop_reason=tool_use` 结束，并通过 `tool_result` 继续；示例工具 id 使用 `toolu_`。
- thinking 流式包含 `thinking_delta`，其后在 block 结束前发送 `signature_delta`；signature 用于 thinking block 完整性与多轮连续性。
- Opus 4.7/4.8 只支持 `thinking.type=adaptive`；手动 `enabled + budget_tokens` 返回 400。`output_config.effort` 用于软控制 thinking 深度。
- Opus 4.7/4.8 等新模型拒绝非默认 `temperature`、`top_p`、`top_k`，与 thinking 是否开启无关。
- 官方错误体有顶层 `error.type/message` 和 `request_id`；每个响应有 request-id header。Bedrock 还同时存在 AWS request id 和 Anthropic request id。
- Claude Code 官方支持 Anthropic 直连，也支持 Bedrock、Google Cloud、Microsoft Foundry，以及通过 `ANTHROPIC_BASE_URL` 等配置 LLM Gateway。自定义 Base URL 本身不是假货证据。
- Claude Code 与 Anthropic 直连都使用 Messages API；透明网关可以把 message、usage、SSE、tool/thinking 原样转发，因此普通响应完全相同是协议设计允许的结果。
- Anthropic-format Claude Code 网关的核心契约包括 `/v1/messages`，可选 `/v1/messages/count_tokens`，以及启用发现后请求 `GET /v1/models?limit=1000`。
- Claude Code 请求携带 `x-claude-code-session-id`，子代理场景可携带 agent/parent-agent id，并把 `anthropic-beta` 当开放列表透传。能力 body 字段和 beta header 必须成对转发。
- Claude Code 会在 system 数组首项加入包含客户端版本和会话 fingerprint 的 attribution block。`api.anthropic.com` 只在该 block 保持首项且独立时剥离；其他上游会收到它。该行为只能作为组合证据，不能靠模型回显形成密码学证明。
- 自定义 Base URL 默认关闭 fine-grained tool streaming；上游错误文案若被网关包裹，Claude Code 基于错误文本的自动降级/重试会失效。

官方来源：

- [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview)
- [Claude API errors](https://platform.claude.com/docs/en/api/errors)
- [Claude Code third-party integrations](https://code.claude.com/docs/en/third-party-integrations)
- [Claude Code Gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars.md)
- [Anthropic beta headers](https://platform.claude.com/docs/en/api/beta-headers)

## 3. 四级证据模型

| 层级 | 权重 | 可检测信号 | 结论边界 |
|---|---:|---|---|
| L1 来源与控制面 | 最高 | 官方域名、云资源 ID、账号账单、IAM/CloudTrail/Azure Monitor、TLS、request id 回查 | 唯一能直接支撑来源结论；通常需要资源所有者配合 |
| L2 跨请求连续性 | 高 | Thinking signature 原样回传、篡改 signature 的原生拒绝、工具调用跨轮连续性 | 能发现转换/裁剪；失败也可能是合法能力差异 |
| L3 协议一致性 | 中 | message/usage/stop reason、SSE 生命周期、tool_use、参数边界、错误 schema | 可被仿造，只证明 Claude-compatible 程度 |
| L4 行为与自报 | 低 | 身份回答、风格、安全、能力、上下文、重复性、延迟 | 易受提示词/版本/路由影响，不能单独定性 |

## 4. 渠道差异矩阵

| 渠道 | 正常差异 | 高价值证据 | 主要风险 |
|---|---|---|---|
| Anthropic 官方直连 | `api.anthropic.com/v1/messages`，Anthropic 模型名和 request id | 官方账户、账单与 request id 可回查；原生 SSE/tool/thinking/server tool | 官方域名却返回其他协议族或控制面不可回查 |
| AWS Bedrock | SigV4、AWS model id/ARN、AWS request id；封装和模型别名可不同 | IAM、CloudTrail、region/model access，外加 Anthropic request id | 把合法云差异误判为假货，或声称 Bedrock 却无 AWS 控制面证据 |
| Microsoft Foundry / Google Cloud | Azure/GCP 认证、资源和 endpoint 不同；能力上线节奏可不同 | RBAC/Azure Monitor 或 IAM/Cloud Audit Logs | 用 Anthropic 直连逐字段标准误伤官方云 |
| LLM Gateway / 逆向中转 | 自定义 host；可能真实透传、部分转换或多上游路由 | 多轮 signature、参数透传、SSE、错误边界、重复性联合结果 | header 裁剪、错误改写、模型别名、OpenAI fallback、缓存/串线、换模 |
| 非 Claude 模型伪装 | 可能自报 Claude 并伪造字段 | 多模块、重复、多基线联合偏离 | 单题或单字段误判；应使用负样本校准 |

## 5. 探针清单与参数

### 5.1 核心协议

| 探针 | 请求参数 | 通过条件 | 典型异常 |
|---|---|---|---|
| response_schema | 非流式，短回复 | `type=message`、Claude family id、model/usage/stop_reason 可解释 | OpenAI shape、usage 缺失、模型名不一致 |
| stream_lifecycle | `stream=true` | 首次关键事件顺序符合官方 SSE 生命周期 | 事件缺失、顺序重组、`chat.completion.chunk` |
| max_tokens | `max_tokens=1` | `stop_reason=max_tokens` 且输出受限 | 上游吞参或重写限制 |
| stop_sequences | `temperature=0`、自定义 stop | stop reason/sequence 与输出一致 | stop 未执行或 stop 文本泄漏 |
| invalid_request | 构造确定无效字段 | 官方族错误 schema 和 4xx | 无效字段被吞、被修正或返回 200 |
| usage_tokens | 短请求 | input/output token 字段存在且合理 | usage 缺失或固定伪造 |

### 5.2 工具、结构化输出与 ClaudeCode

| 探针 | 参数 | 目的 | 权重 |
|---|---|---|---:|
| tool_use_shape | 自定义 `input_schema`，要求指定参数 | 检查 `tool_use`、`toolu_`、name/input/schema | 核心协议 |
| strict_json_schema | 固定 JSON/枚举/nonce | 检查格式遵循，防止只看自然语言 | supporting |
| thinking_signature | `thinking.type=adaptive`、`output_config.effort=medium` | 检查 thinking block/signature | ClaudeCode 专项 |
| signature_interop | 官方/可信 source 生成 signature，relay 原样续接 | 检查跨渠道原生 thinking 连续性 | 高价值专项 |
| invalid thinking/output_config | 非法 display/effort/format | 观察字段是否透传、吞参或改写 | weak，不直接判真伪 |

### 5.3 行为、稳定性与能力参考

- 身份自然问答：只作 weak signal；明确泄露其他厂商身份才标记异常。
- nonce 双请求：检测缓存复用、请求串线和 replay。
- 上下文 needle：检测上下文裁剪或污染。
- 多模态与 Web Search：只作能力参考。server-side Web Search 以正式 tool block、结果引用或 usage 次数为成功证据。
- 延迟/TTFT/token 分布：至少三次采样，与同区域官方参考带比较；单次慢不等于假货。

## 6. 判定规则

1. 先处理运营失败：401/403、余额、配额、429、5xx、连接超时不进入真伪核心分。
2. 先判协议族：OpenAI/Gemini shape 是强异常；Claude shape 只是兼容证据。
3. 再判硬边界：max tokens、stop、invalid request、tool schema、SSE。
4. 再判跨请求连续性：signature interop、nonce、上下文。
5. 最后看行为和能力，且与 Anthropic gold + 官方云参考带比较。
6. 至少三次重复；异常若偶发，标记混路由/不稳定风险，不直接宣判换模。

### 6.1 访问路径独立分类

访问路径与 Claude/ClaudeCode 得分分开计算，不用可选网关能力缺失惩罚模型兼容性：

| 分类 | 条件 | 允许结论 |
|---|---|---|
| `anthropic_api_direct` | 目标为 `api.anthropic.com` | 官方域名直连；来源强度仍可用账单和 request id 回查补强 |
| `claude_code_gateway_like` | 自定义 host，至少两项 Claude Code 契约成立，如 client headers、attribution、count_tokens、model discovery | Claude Code 网关兼容，不证明上游是官方 API、OAuth 还是其他 Claude 渠道 |
| `translated_gateway` | OpenAI/Gemini shape、fallback、SSE/error 重建或模型字段改写 | 存在协议翻译/重建痕迹，需进一步检查换模和能力退化 |
| `transparent_unresolved` | 自定义 host 仅表现为普通 Messages 高一致，缺少独立网关或来源证据 | response-only 无法区分透明 API/OAuth 转发和其他无改写代理，禁止标成官方直连 |

响应头只保存名称，不保存认证值。`x-apipro-*`、`x-oneapi-*`、`via` 等中间层控制面头属于网关存在证据，但不能单独证明其上游模型。

建议结论词：

- `official_direct_confirmed`：仅当 L1 来源证据已核验。
- `official_cloud_confirmed`：云控制面与资源证据已核验。
- `claude_compatible_high_consistency`：L2/L3 高一致，但无 L1 来源证明。
- `usable_with_gateway_traces`：核心通过，存在可解释的代理痕迹。
- `suspected_parameter_rewrite`：多个参数/错误边界显示吞参或改写。
- `suspected_model_swap`：协议、能力、稳定性多层偏离且重复出现。
- `likely_non_claude`：多项独立强证据持续低于官方与官方云参考带。

## 7. 安全与留证

- API Key 只存在于本次运行内存，不入库、不进日志、不进报告。
- 请求快照只保留 prompt、模型和非敏感参数；认证头和 secret 字段递归脱敏。
- 保存每个探针的 request id、message id、endpoint、协议、HTTP、错误类型、SSE 列表、usage key 和判定原因。
- 原始响应是证据，不是来源证明；所有报告必须注明“兼容性高不等于官方来源已确认”。
