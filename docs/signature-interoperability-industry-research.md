# Thinking Signature 互通检测：行业方案调研与项目建议

> 调研日期：2026-07-22  
> 适用范围：Claude Thinking Signature、多轮推理状态透传、第三方 Gateway/Relay 检测  
> 结论性质：协议完整性与链路兼容性评估，不是官方来源或模型真实性的密码学证明

## 1. 结论摘要

Thinking Signature 检测不应只跑“待测渠道 -> 待测渠道”，也不应只跑单向“官方 -> 待测渠道”。推荐采用下面的最小闭环：

1. **官方自检控制组**：官方生成 signature，官方继续请求；同时验证篡改后官方会拒绝。
2. **待测渠道自检**：待测渠道生成 signature，再由自身继续请求；用于判断其基本多轮能力，但证据较弱。
3. **官方 -> 待测渠道**：验证待测链路能否接收官方生成的完整 thinking block。
4. **待测渠道 -> 官方**：验证待测渠道返回的 thinking block 能否被可比的官方基线接受。
5. **双侧篡改负对照**：官方和待测渠道分别接收被篡改的 thinking block，确认是否出现原生拒绝，而不是静默删除、重新生成或绕过校验。
6. **Thinking + Tool Use 连续性**：在 tool loop 中原样回传完整 thinking、redacted thinking 和 tool-use block，防止只验证普通多轮而漏掉真实 Agent 场景。

其中，**待测渠道自检通过只能证明“自己生成、自己接受”**，可能是渠道自行签名、自行缓存或根本未校验，因此不能作为高权重真实性证据。价值最高的是：官方控制组有效、双向正向互通、双侧篡改拒绝、重复采样稳定，并且没有协议翻译或自动降级掩盖失败。

## 2. Signature 到底证明什么

Anthropic 官方文档说明，extended thinking 响应中的 `signature` 携带加密的完整 thinking 状态。多轮或工具调用继续请求时，客户端需要原样回传完整 thinking block；若 thinking block 被修改，API 会返回 `400 invalid_request_error`。流式模式下，signature 通过 block 结束前的 `signature_delta` 返回。

因此，signature 能提供的是：

- thinking block 在跨请求过程中是否被完整保留；
- relay 是否裁剪、重建、丢失或错误转换了 thinking 数据；
- tool loop 是否维持了 Claude 所要求的连续 assistant turn；
- 候选响应是否至少能被某个可比 Claude 验证端继续使用；
- 篡改内容是否被验证端识别并拒绝。

它不能单独证明：

- 请求一定直达 `api.anthropic.com`；
- 第三方渠道使用的是 API Key、Claude.ai OAuth、Bedrock、Vertex 还是其他上游；
- 第三方没有透明转发官方响应；
- signature 一定在所有 Claude 官方云、模型版本和协议封装之间通用；
- 单次通过能够排除混合路由、缓存回放或偶发换模。

## 3. 市面技术方案

### 3.1 Anthropic 原生 Messages API

官方机制：

- thinking block 包含 `thinking` 和 `signature`；新模型也可能返回空 thinking 文本但保留 signature。
- 多轮继续时，thinking block 必须完整、原样回传。
- tool use 场景必须回传最近 assistant turn 的完整 thinking blocks。
- 连续 thinking blocks 不能修改、删除或重排；篡改后返回包含 thinking/signature 信息的 400 错误。
- SSE 中先返回 `thinking_delta`，再在 block 结束前返回 `signature_delta`；`display="omitted"` 时可能只有 signature delta。
- 不同模型对历史 thinking block 的保留范围不同，因此检测必须锁定模型族和 thinking 协议。

适合检测：原生 Claude Messages 链路、透明 Anthropic Gateway、Claude Code Gateway。

主要误区：把“官方能够继续解密某个 signature”直接解释为“该 URL 是官方直连”。透明代理完整转发时也会通过。

### 3.2 Amazon Bedrock Converse / InvokeModel

AWS `ReasoningTextBlock` 包含 `text` 和可选 `signature`。AWS 明确要求：多轮回传 reasoning block 时，text 和 signature 均需保持不变。`ReasoningContentBlock` 还可能包含由模型提供方加密的 `redactedContent`。

Bedrock 与 Anthropic 直连接口可能存在以下合法差异：

- AWS SigV4/IAM 鉴权；
- Converse、InvokeModel 或 Messages API 不同外壳；
- AWS model ID、inference profile 和 region 路由；
- AWS request ID 与 Anthropic request ID 并存；
- 验证错误可能是 AWS/Pydantic 风格，而不是 Anthropic 标准错误体。

因此，Bedrock 应拥有独立参考带。Bedrock 自检通过是官方云协议证据，但“Bedrock signature -> Anthropic Direct”是否可移植不能在缺少官方保证时作为硬性通过条件。

### 3.3 Google Gemini Thought Signatures

Gemini 也提供加密的 thought signature，用于多轮和函数调用中的推理连续性。Google 文档要求完整重发所有 thought blocks，不能删除或修改；使用 stateful Interactions API 时，服务端可以通过 `previous_interaction_id` 自动维护状态。

这说明“签名推理状态”已成为多家模型 API 的通用工程模式，但 Gemini signature 与 Claude signature 属于不同协议域，不能交叉验证。项目应避免看到 `signature` 字段就判为 Claude。

### 3.4 OpenAI Responses API 的加密 reasoning state

OpenAI Responses API 使用 reasoning item、`previous_response_id` 和 stateless 模式下的 `encrypted_content` 维持推理连续性。工具调用后建议原样回传相关 reasoning items；手工重放时需保留完整 output item 和阶段字段。

这与 Claude thinking signature 的目标相似，但不是相同格式，也不具备互通意义。它更适合作为负样本：如果“Claude 兼容渠道”返回 `rs_` reasoning item、`encrypted_content` 或 Responses API 结构，应标记协议翻译或换协议，而不是 Signature 通过。

### 3.5 OpenRouter 等多提供商聚合层

OpenRouter 使用统一的 `reasoning_details` 数组承载不同供应商的推理状态，并建议在后续请求中回传完整 reasoning block。其优势是统一接入，风险是：

- 同一模型别名可能路由到不同 provider；
- provider-specific signature 需要在统一格式与原始格式间转换；
- fallback 后可能出现 signature 域不一致；
- 只回传纯文本 reasoning 会丢失加密状态；
- 网关可能在流式 delta 中重建 reasoning details。

检测时必须记录实际 provider、路由策略和重复采样结果；不能把某一次互通失败直接定为非 Claude。

### 3.6 LiteLLM 等协议转换网关

LiteLLM 会统一输出 `reasoning_content`，并为 Anthropic 额外保留 `thinking_blocks`。其公开文档明确指出：传统 OpenAI-compatible client 通常没有 `thinking_blocks` 字段，客户端重建 assistant message 时会丢失 signature，从而导致 Anthropic tool loop 返回 400。

常见兼容策略包括：

- 原样保存并回传 `thinking_blocks`；
- thinking block 缺失时，自动移除下一请求的 thinking 参数；
- 遇到无效 signature 时，剥离 thinking block 后限次重试；
- 切换到非 Anthropic provider 时直接丢弃 thinking blocks。

这些“自愈”策略对业务可用性有帮助，但会干扰检测：最终 HTTP 200 可能只是网关删除 thinking 后重试成功，并不代表 signature 互通。检测器必须关闭自动修复，或通过原始 trace 识别首个 400、二次请求、thinking 参数消失和 block 被剥离。

### 3.7 Cloudflare AI Gateway 等 Provider-native 代理

Cloudflare 等网关同时提供 provider-native Anthropic endpoint 和 OpenAI-compatible endpoint。Provider-native 模式可以只替换 Base URL，并尽量保留 Anthropic Messages 请求形状；OpenAI-compatible 模式则需要做协议转换。

这两种链路的 Signature 结论不同：

- provider-native 透明代理通过双向互通是合理结果，只能说明链路完整；
- OpenAI-compatible 端点如果无法保存 thinking block，应显示“协议翻译导致 Signature 不可验证”；
- 无论哪种模式，单靠响应都不能证明上游来源。

## 4. 推荐检测矩阵

设：

- `A`：可比的官方或可信参考渠道；
- `C`：待测候选渠道；
- `S(X)`：由渠道 X 生成的完整 thinking block；
- `T(S)`：只修改 signature 最后若干字节后的篡改 block；
- 每一项默认重复 3 次，深度模式可运行 5 次。

| 编号 | 请求 | 预期 | 证据作用 | 失败解释 |
|---|---|---|---|---|
| M1 | `A -> A`，回传 `S(A)` | 接受 | 官方正向控制组 | 官方基线、模型或参数不可用时整组无效 |
| M2 | `A -> A`，回传 `T(S(A))` | 原生 4xx 拒绝 | 官方篡改负对照 | 若不拒绝，不能证明本轮测试真的触发 signature 校验 |
| M3 | `C -> C`，回传 `S(C)` | 接受 | 候选自洽能力 | 通过仅为弱证据；失败说明候选自身多轮链路不完整 |
| M4 | `C -> C`，回传 `T(S(C))` | 拒绝 | 候选是否真正校验 | 接受可能表示忽略、重签、缓存或绕过校验 |
| M5 | `A -> C`，回传 `S(A)` | 接受 | 官方到候选的正向互通 | 失败可能是裁剪、协议翻译、模型不兼容或签名域不同 |
| M6 | `A -> C`，回传 `T(S(A))` | 拒绝 | 候选侧篡改识别 | 若返回 200，需检查是否删除 thinking 后重试 |
| M7 | `C -> A`，回传 `S(C)` | 接受 | 候选生成物的反向验证 | 仅在 A/C 模型和签名域可比时为强证据 |
| M8 | `C -> A`，回传 `T(S(C))` | 拒绝 | 官方验证候选签名的负对照 | 官方拒绝原始和篡改样本时，应判“不可验证”而非伪造 |
| M9 | `A/C` thinking + tool loop | 完整继续 | Agent 实际使用场景 | 普通多轮通过但 tool loop 失败，常见于客户端丢 block |
| M10 | SSE signature delta | 顺序和拼接正确 | 流式透传完整性 | 事件重建、缺失或缓冲应独立标记 |

### 4.1 可比性前置条件

执行 M5-M8 前必须检查：

- 模型家族和具体版本是否相同或被官方声明兼容；
- thinking 协议是否一致，例如 legacy `enabled + budget_tokens` 与 adaptive thinking；
- `display=summarized/omitted` 差异是否被正确归一化；
- Anthropic Direct、Bedrock、Vertex、Foundry 是否有证据表明共享可验证签名域；
- relay 是否为 provider-native Anthropic Messages，而不是 OpenAI-compatible 翻译接口；
- 是否关闭了网关 fallback、自动 strip-and-retry、缓存和模型自动降级。

若这些条件不满足，跨渠道失败应记为 `not_comparable` 或 `operationally_inconclusive`，不能直接标记 `suspected_model_swap`。

## 5. 判定规则建议

### 5.1 结果状态

建议每个矩阵项使用：

- `pass`：结果与该项预期一致；
- `fail`：请求完成，但出现明确协议矛盾；
- `warning`：存在代理重试、错误改写、流式重建等干扰；
- `not_comparable`：模型、provider 或 signature 域不可比；
- `not_applicable`：模型不支持 thinking/signature；
- `operational_error`：鉴权、余额、429、5xx、超时或网络失败。

### 5.2 聚合结论

| 条件 | 建议结论 |
|---|---|
| M1/M2 有效，M5-M8 全部稳定通过 | `signature_chain_verified`：Claude signature 链路已验证，不等于官方直连 |
| M3 通过，但 M5/M7 均不可验证 | `self_consistent_only`：仅候选自洽，证据弱 |
| 原始样本和篡改样本都被候选接受 | `signature_validation_bypassed_suspected`：疑似忽略或绕过 signature 校验 |
| 原始样本失败，但日志显示 thinking 被剥离后二次请求成功 | `signature_stripped_and_retried`：网关自愈掩盖互通失败 |
| 重复采样时 signature 互通结果和协议字段成组切换 | `mixed_routing_suspected` |
| Signature 失败且另有 SSE、tool、参数和能力多类异常 | 才考虑 `protocol_reconstruction_suspected` 或 `model_swap_suspected` |
| 只有跨官方云互通失败，其他同源控制均通过 | `cross_provider_signature_domain_unverified` |

### 5.3 不应使用的结论

- “100% 官方”或“验证为真 Claude”；
- “Signature 不通，所以一定是假模型”；
- “Signature 通过，所以一定是 Claude Code OAuth”；
- “候选自检通过，所以未换模”；
- “官方云与 Anthropic Direct 不互通，所以官方云异常”。

## 6. 实验实现要点

### 6.1 构造正向请求

1. 使用固定、低风险、确定会触发 thinking 的题目。
2. 锁定模型、thinking 配置、tools、beta headers 和 stream 模式。
3. 保存完整 assistant `content` 数组，不只提取 thinking 文本。
4. 下一请求原样回传 block 顺序、thinking、signature、redacted thinking、tool use 和文本块。
5. 记录 source/relay endpoint、model、message ID、request ID、HTTP、错误 schema、SSE 事件和 normalization notes。

### 6.2 构造篡改样本

推荐只改 signature 的最后一个 Base64 字符或一个确定字节，保持：

- JSON 仍合法；
- block 类型、顺序和 thinking 文本不变；
- 请求参数与正向样本完全相同；
- 不把完整 signature 写入数据库、日志或报告。

此外可增加两个次级变体：删除 signature、交换连续 thinking block 顺序。次级变体用于诊断，不应取代最小单字节篡改控制。

### 6.3 识别网关自动修复

需要检测以下痕迹：

- 首次请求 400，随后同一用户请求出现第二次上游调用；
- 第二次请求中 thinking 参数或 thinking blocks 消失；
- HTTP 最终为 200，但响应没有 thinking block；
- latency 明显包含一次失败加一次重试；
- 错误体包含 thinking/signature 后被网关改写；
- model、provider 或 endpoint 在重试前后变化。

只看到最终 200 时不能判 Signature 通过。

### 6.4 安全留证

- API Key、Authorization、AWS credential 和 OAuth token 只用于运行时。
- 完整 signature 不入库；只保存长度、稳定哈希、前缀脱敏值或是否存在。
- 保存篡改策略，例如 `last_byte_flip`，不要保存原始和篡改后的完整值。
- 原始请求/响应落库前递归脱敏。
- 报告必须注明 Signature 是链路完整性证据，不是来源证明。

## 7. 本项目现状与差距

### 7.1 已有能力

项目深度上游完整性探针已经实现：

- 官方自检正向控制；
- 官方自检篡改拒绝；
- 官方 -> 候选正向互通；
- 候选 -> 官方反向互通；
- 候选 signature 篡改后由官方拒绝；
- 3/5 次重复与 `signature_chain_verified` 聚合；
- Signature 脱敏后持久化。

相关实现位于 `backend/app/services.py` 的 `_integrity_signature_matrix()`。

### 7.2 当前缺口

1. 独立“Signature 检测”页面目前只执行 `Source -> Relay`，没有候选自检、反向验证和篡改对照。
2. 深度矩阵没有执行“官方 signature 篡改后发送给候选”的 M6，因此无法直接判断候选是严格校验、静默忽略，还是删除 thinking 后继续。
3. 当前 `signature_chain_verified` 对跨 provider 的可比性约束不够显式，应记录 `signature_domain`、provider、模型版本和协议 profile。
4. 自动巡检默认选择参考 source -> 待测 relay，但没有完整矩阵，适合低成本巡检，不适合输出高置信链路验证结论。
5. 需要识别 LiteLLM 类 strip-and-retry，否则最终 200 可能形成假阳性。
6. Gemini、OpenAI reasoning signature/state 应作为独立协议族或负样本，不应进入 Claude Signature 评分。

### 7.3 推荐落地顺序

**P0：补齐判断正确性**

- 深度矩阵增加 M6：`A -> C` 篡改负对照。
- 增加 `self_consistent_only`、`signature_validation_bypassed_suspected`、`signature_stripped_and_retried` 和 `cross_provider_signature_domain_unverified` 状态。
- 将 provider/model/protocol 不可比从 `fail` 拆成 `not_comparable`。

**P1：升级独立 Signature 页面**

- 提供“快速检测”和“完整矩阵”两种模式。
- 快速检测保留 `A -> C`；完整矩阵运行 M1-M8。
- UI 展示矩阵，而不是只显示一个总通过/失败。

**P2：补 Agent 场景和趋势**

- 增加 thinking + tool loop、SSE signature delta 和自动重试识别。
- 重复采样 3/5 次，展示通过率和路由切换。
- 与 request ID、provider trace 和控制面证据关联，但保持来源结论独立。

## 8. 推荐 UI 文案

通过时：

> 双向 Thinking Signature 与篡改对照在本轮重复采样中通过，说明待测链路能够保留并验证可比 Claude thinking 状态。该结果证明协议链路完整性，不证明第三方 URL 为 Anthropic 官方直连。

仅自检通过时：

> 待测渠道能够继续使用自身生成的 Signature，但尚未被可信参考渠道反向验证。该结果只能说明渠道内部自洽，不能排除自行签名、缓存或协议模拟。

跨渠道失败时：

> 跨渠道 Signature 未能验证。可能原因包括 thinking block 被裁剪、协议翻译、模型版本或签名域不兼容、网关自动降级。需结合官方控制组、篡改对照和原始请求 trace 判断，不能单独据此认定为非 Claude。

## 9. 参考资料

### 官方文档

- [Anthropic Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Anthropic Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [AWS Bedrock ReasoningTextBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningTextBlock.html)
- [AWS Bedrock ReasoningContentBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningContentBlock.html)
- [Gemini Thinking and Thought Signatures](https://ai.google.dev/gemini-api/docs/thinking#signatures)
- [OpenAI Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Cloudflare AI Gateway Anthropic provider-native endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)

### 网关与聚合层资料

- [OpenRouter Reasoning Tokens and Preserving Reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [LiteLLM Thinking / Reasoning Content](https://docs.litellm.ai/docs/reasoning_content)
- [LiteLLM PR #33719: Bedrock/Vertex missing thinking-signature self-heal](https://github.com/BerriAI/litellm/pull/33719)

## 10. 最终建议

产品层面应把当前“Signature 互通检测”升级为“Signature 链路矩阵”。默认自动巡检仍可使用低成本的官方 -> 候选探针，但不得据此给出高置信验证；只有官方控制有效、双向正向通过、双侧篡改拒绝、模型/协议可比且重复采样稳定时，才能标记 `signature_chain_verified`。

最需要优先补齐的是 **M6：官方 signature 篡改后发送给候选渠道**。没有这一项，候选返回 200 时无法区分“真正验证并接受原始 signature”和“完全忽略 signature 或删除 thinking 后继续”。
