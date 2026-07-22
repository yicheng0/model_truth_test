# 轻量 Claude API 检测器：方案调研与落地边界

## 调研结论

轻入口适合做“快速兼容性筛查”，不适合宣称官方来源或 OAuth 资源真实性。远程接口可以重写 `model`、消息 ID、SSE 事件和自报身份，因此必须把结论拆成协议、行为和运营证据三层。

本项目保留现有 Claude Code / Messages 探针，把结果压缩为 10 个清单项；详细探针和原始证据仍可展开查看。`skipped`、`not_applicable` 和能力未开放统一显示“未验证”，不会作为非 Claude 证据。

## 技术方案对比

| 方案 | 可复用技术 | 适合本项目的部分 | 不应直接照搬 |
| --- | --- | --- | --- |
| hvoy.ai 首页检测（现场调研，2026-07-22） | 单页配置、模型选择、一次检测、结果清单、最近历史 | 配置成本低；结果先给 checklist，细节后置 | 公开站点的二元红绿灯；不把 PDF/图片不支持当作真实性失败 |
| Anthropic Messages API | `POST /v1/messages`、`model`、`max_tokens`、`messages`、`stream`、`tools`、`thinking`；流式事件包括 `message_start`、`content_block_delta`、`message_delta`、`message_stop` | 作为协议和参数探针的规范基线 | `model` 自报和单一 `msg_` 前缀不能证明官方来源 |
| LiteLLM Proxy | `/health`、模型路由和统一代理入口 | 可借鉴快速连通性、状态检查和路由可观测性 | 健康接口 200 只说明代理可用，不说明上游模型未被替换 |
| OpenRouter Provider Routing | provider 顺序、路由偏好、fallback、供应商差异 | 解释同一模型名在不同供应商上的合法行为差异；需要重复采样 | 不把供应商切换误判成伪造；要记录路由不确定性 |
| Portkey / Helicone | 请求 ID、延迟、token、错误和 trace 观测 | 保留安全的 latency、usage、request id 等证据 | 不保存 API Key、Authorization 或原始敏感请求 |
| 公开 API schema / SDK 测试器 | JSON Schema、SSE 解析、工具参数校验 | 作为结构化输出、工具调用和流事件的硬校验 | 只测 schema 无法检测能力退化、混合路由和重复性 |

## 轻量检测流程

1. 连接与鉴权：发起最小 Messages 请求，记录状态码、错误类型和请求耗时。
2. 硬协议：校验响应类型、`model`、`usage`、`stop_reason`、消息 ID 和安全的请求 ID。
3. 行为探针：重复回显、严格 JSON、工具调用、流式生命周期、多轮约束和低成本能力题。
4. 可选能力：thinking、图片、文档等按“通过 / 失败 / 未验证”单独显示，不能替代真实性判断。
5. 结果表达：给分数和风险标签，同时保留证据链；不输出“100% 真 / 假”。

## 官方参考

- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Anthropic streaming messages](https://docs.anthropic.com/en/api/messages-streaming)
- [Anthropic extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [Anthropic tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
- [LiteLLM proxy health](https://docs.litellm.ai/docs/proxy/health)
- [OpenRouter provider routing](https://openrouter.ai/docs/features/provider-routing)
- [Portkey observability](https://portkey.ai/docs/product/observability)

## 安全和证据边界

- API Key 仅进入运行时请求，不进入 localStorage、数据库、历史摘要、日志和报告。
- 浏览器最近历史只保留检测 ID、endpoint host、模型、分数、风险级别和时间。
- 第三方网关即使完整通过 Messages 协议，也只能得出“Claude-compatible / 高一致性”；官方直连、OAuth 资源和上游未换模需要本地 CLI 或供应商审计证据。
