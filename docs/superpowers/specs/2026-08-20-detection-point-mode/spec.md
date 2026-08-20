# Fable 5 渠道检测点模式 Spec

## 背景

当前测试集以协议、能力、身份、上下文和安全等模块组织题目，但检测结果仍容易被理解成一个笼统的“真假 Claude”结论。社区常用的 Fable 5 特征题可以发现部分中转降级或模型替换，但隐藏 fallback、改写错误和透明转发都会使单一题目失效。

官方资料还表明：Claude Fable 5 可以通过 Anthropic API、Amazon Bedrock、Claude Platform on AWS、Google Cloud 和 Microsoft Foundry 提供；Kiro 由 Amazon Bedrock 提供模型；Claude Code 可以使用官方 API、订阅、云平台或自定义网关。因此，模型行为、客户端身份、访问路径和资源凭据必须分别检测和报告。

## 目标

- 新增一个面向渠道筛查的“检测点模式”，优先验证 Fable 5 行为边界和渠道来源线索。
- 将现有题目重新映射到检测点，不再让普通身份自报或单个 Fable 5 题目承担“官方来源证明”。
- 独立输出模型身份、Claude Code 客户端可能性、访问路径和资源身份四类结论。
- 保留官方云参考、Kiro/Bedrock 兼容和透明中转等合法但不同的渠道类型。
- 对 fallback、错误改写、协议重建、混合路由和运营故障提供可区分的证据记录。

## 功能需求

- F1: 用户可以选择“检测点模式”运行一次低成本筛查；该模式至少执行三次重复采样，并展示每个检测点的独立状态、证据摘要和不可判定原因。
- F2: 检测点模式必须包含 Fable 5 行为组，覆盖模型字段/可用性、adaptive thinking 默认行为、禁止关闭 thinking 的错误、非默认采样参数拒绝、reasoning extraction 拒绝、thinking signature 和流式事件边界。
- F3: Fable 5 行为组必须同时包含正向样本、负向样本和至少一个篡改/改写对照；任何单个错误文案、`msg_` ID、SSE 事件或 signature 都不能单独把渠道标记为官方 Anthropic API。
- F4: 检测点模式必须包含 Kiro/Bedrock 线索组，覆盖 Kiro 模型目录差分、盲身份请求中的 Kiro 泄漏、Bedrock/跨区域参考线索和模型可用性矛盾；这些结果只能形成 Kiro 可能性或矛盾标签，不能直接判定底层模型被替换。
- F5: 检测点模式必须包含 Claude Code 客户端组。只有在入口侧捕获到真实入站请求时，才根据 `x-claude-code-*`、attribution block、请求序列、`count_tokens`、`/v1/models` 和 SSE 使用方式给出 `claude_code_like`；只有主动向远端发送探针而未捕获原始请求时，结果必须为 `unobservable`。
- F6: 检测点模式必须包含 Anthropic 官方来源组，区分端点配置证据、响应协议兼容证据和控制面闭环证据。只有目标域名、组织侧 request-id、账单/用量或云审计等证据能够相互关联时，才允许输出 `anthropic_api_direct_verified`；否则输出官方来源未验证或透明中转未决。
- F7: 现有题目必须重新挂接到上述检测点：协议题、消息 ID、SSE、thinking、tool-use 和参数边界题进入硬协议/Fable 行为组；身份题改为低权重盲身份辅助；能力、安全、知识和上下文题保留为校准组，不再作为官方来源的直接证明。
- F8: 题库必须增加针对社区短文本、多约束和错误边界方法的安全改写题，但不得使用要求生成违法、有害实验或危险操作步骤的内容；题目应检测长度约束、拒答类别、错误 envelope 和 fallback 行为，而不是引导危险内容生成。
- F9: 结果必须独立输出以下字段：`model_identity`、`client_likelihood`、`access_path`、`resource_identity`、`control_plane_evidence` 和 `detection_points`；总评分可以保留，但不得用一个总分覆盖这些字段的边界。
- F10: 检测点模式必须区分以下状态：通过、异常、疑似改写/换模、官方云参考差异、Kiro 线索、客户端不可观测、运营故障、模型不兼容和证据不足；超时、配额、认证失败和服务不可用不得自动归为 Signature 或模型异常。
- F11: 检测报告必须显示每个结论对应的原始结构化证据摘要、重复采样结果、官方文档依据和时间敏感说明；不得保存或展示 API Key、认证头、OAuth token 或未脱敏原始凭据。
- F12: 原有完整测试模式和 mock 模式继续可用；检测点模式的题目、标签、结果和报告应能与现有运行记录兼容，并可在同一渠道上进行后续完整复核。

## 非功能需求

- N1: 检测结果必须证据优先、可审计，明确区分“高度符合 Fable 5 行为”和“已验证 Anthropic 官方直连”。
- N2: 重复采样应保持可比较的模型、参数、系统提示和协议设置，并记录样本数量、失败原因和不可比条件。
- N3: 检测点定义、标签和结论名称应稳定，便于趋势统计、巡检告警和历史报告比较。
- N4: 官方模型目录、Fable 5 能力和 Kiro 模型列表属于时间敏感资料；报告应记录资料版本或抓取日期，不能把一次目录差分永久当成绝对事实。
- N5: 运行成本应受现有每日 token 上限和每轮成本估算约束；低成本模式不得悄悄扩大为完整题库调用。
- N6: 前端展示应以检测点表格、证据摘要和独立字段为主，不使用“真货/假货/100% 官方”等绝对或法律化措辞。

## 不做的事

- 不把 Fable 5 单题通过、Claude 自报身份、thinking signature、`msg_` ID、SSE 或 Anthropic 风格错误单独视为官方 API 证明。
- 不通过远程响应推断 Kiro、Claude.ai 订阅、Claude Code OAuth 或具体 API Key 账户归属；这些需要本机或控制面证据。
- 不强制要求 Bedrock、Foundry、Vertex、Kiro 和 Anthropic 直连逐字段一致；官方云渠道允许存在协议封装和能力差异。
- 不在本阶段新增认证系统、计费系统、队列、Redis、Celery 或大型服务拆分。
- 不删除现有完整题库、历史运行记录、mock 执行和既有异常分类；只调整题目归属、检测点编排和结果展示口径。
- 不把社区方法或未验证的中转站经验写成 Anthropic 官方保证。

## 验收标准

- AC1: 运行检测点模式后，结果页面能看到 Fable 5 行为、Kiro/Bedrock、Claude Code、官方来源和校准组的独立检测点，每个检测点都有状态、证据摘要和重复采样计数。
- AC2: 对一个符合 Fable 5 行为的官方或官方云参考样本，adaptive thinking、禁止关闭 thinking、参数边界、reasoning extraction 和 signature 相关检测点能得到与协议相符的结果；页面只表述为 Fable 5 行为一致或官方云参考一致，不自动显示官方直连。
- AC3: 对返回被改写错误、缺失 signature、重建 SSE、静默换模或违反参数边界的样本，至少两个独立检测点能够分别记录异常，并输出疑似改写/换模或证据不足，而不是依赖单个 Fable 题下结论。
- AC4: 当盲身份题主动泄漏 Kiro 或模型目录与 Fable 5 产生矛盾时，结果显示 Kiro 线索/目录矛盾；不会把该结果直接标记为非 Claude 或模型替换。
- AC5: 有真实入站捕获且具备 Claude Code 请求特征时，客户端字段显示 `claude_code_like`；只有主动探针、没有入站捕获时，客户端字段显示 `unobservable`。
- AC6: 只有具备官方端点和控制面关联证据的样本才显示 `anthropic_api_direct_verified`；仅有 Messages 协议兼容、request-id、signature 或 SSE 的样本显示来源未验证/透明中转未决。
- AC7: 现有题目列表在检测点模式中均有明确归属；能力、安全、知识和上下文题仍可运行，但不会改变官方来源字段；旧完整模式结果和 mock 模式不回归。
- AC8: 社区短文本和多约束安全改写题能验证长度、格式、错误类别、fallback 和拒答边界；题目不要求生成危险操作内容，且检测记录不泄漏密钥或敏感请求头。
- AC9: 运营故障、认证失败、限流、超时和未配置能力分别显示为运营/不可判定状态，不计入 `signature_interop_failed`、`model_swap_suspected` 或 Kiro 泄漏统计。
- AC10: 检测点模式支持重复运行和历史比较；报告能够显示资料抓取日期、检测模式、题目版本、样本数和结论边界。
