# Signature 待测源方向修正 Spec

## 背景

Thinking Signature 互通检测的底层顺序是 Source 先产生带签名的 thinking block，再由 Relay 复用该 block。但当前手动推荐组合、自动巡检和 Claude 深度检测把官方参考渠道放在 Source、待测渠道放在 Relay，实际验证的是“待测渠道能否接收官方产生的签名”，与产品要判断“待测资源产生的签名是否有效”相反。

同时，现有身份探针检测 Relay，检测结果也归属 Relay。方向调整后，官方可信渠道将作为 Relay，因此身份异常和检测结论必须归属待测 Source，避免把 Kiro 身份或 Signature 失败记到官方渠道上。

## 目标

- 所有用于评价待测渠道的 Signature 检测统一采用“待测渠道作为 Source，官方可信渠道作为 Relay”。
- 验证待测 Source 产生的 thinking signature 能否被官方可信 Relay 接受。
- Kiro 等身份异常检测待测 Source，并将 Signature 与身份结论记录到待测 Source。
- 保留运行故障、模型不可比与真正 Signature 失败的区别。

## 功能需求

- F1: 手动 Signature 检测的推荐组合必须选择非官方待测渠道作为 Source，选择同模型的官方可信参考渠道作为 Relay。
- F2: 手动选择允许用户查看和调整组合，但当 Source 为官方参考、Relay 为非官方待测渠道时，界面必须明确提示方向与目标相反，避免误解检测结论。
- F3: 自动巡检执行 Signature 检测时，被巡检渠道必须作为 Source，基线快照或已启用官方参考渠道必须作为 Relay。
- F4: Claude 深度检测执行 Signature 探针时，当前被检测渠道必须作为 Source，配置的官方参考渠道必须作为 Relay。
- F5: Signature 判断必须基于官方 Relay 是否接受待测 Source 产生的带签名 thinking block；Source 未产生有效 signature 或官方 Relay 明确拒绝 signature 时，记录 Signature 链路异常。
- F6: 模型不一致、官方 Relay 无模型权限、超时、配额、服务不可用等情况必须继续标记为不可比或运行故障，不得直接归因为待测 Source 的签名无效。
- F7: 固定身份探针必须请求待测 Source；若 Source 明确返回 Kiro 身份，记录 Kiro 身份泄漏异常。
- F8: 手动检测日志、自动巡检报告、评分影响和异常标签必须归属待测 Source，而不是官方 Relay。
- F9: 页面步骤、结果摘要和帮助文案必须明确表达“Source 产签名、官方 Relay 验签”，并将身份步骤标为 Source 身份检测。
- F10: 检测通过仅表示待测 Source 的 Signature 可被所选官方 Relay 接受，不得表述为官方直连、资源来源已验证或百分之百真实。

## 非功能需求

- N1: 不改变底层请求中 Source 先生成、Relay 后复用的协议顺序。
- N2: API Key 和原始认证信息仍只用于运行时调用，不新增持久化或展示。
- N3: 保持现有 SQLite、PostgreSQL、Mock 模式和已有 API 路由兼容。
- N4: 方向修正必须有前端推荐组合测试、后端手动检测测试、自动巡检测试和 Claude 深度探针测试。
- N5: 保留现有报告和历史结果可读性；历史记录不自动重算，新的方向仅对新检测生效。

## 不做的事

- 不把单次 Candidate → Official 互通成功提升为 `signature_chain_verified` 或官方来源证明。
- 不在本次新增完整双向矩阵、篡改签名负对照或多轮统计验证。
- 不改变普通模型能力、参数、Web Search 或性能探针。
- 不修改渠道凭证、模型名称或参考渠道配置。
- 不迁移或重写历史 Signature 检测结果。

## 验收标准

- AC1: 点击“填入推荐组合”后，Source 是非官方待测渠道，Relay 是相同模型的官方可信参考渠道。
- AC2: 手动发起检测时，第一个模型请求发送给待测 Source；携带该 Source signature 的复用请求发送给官方 Relay。
- AC3: 自动巡检某候选渠道时，持久化证据显示该候选渠道为 Source、官方参考渠道为 Relay，报告仍归属候选渠道。
- AC4: Claude 深度检测某候选渠道时，Signature 探针调用方向为候选 Source → 官方 Relay。
- AC5: 身份探针请求发送给待测 Source；Source 返回 Kiro 时，候选报告出现 `kiro_identity_leak`，官方 Relay 报告不受影响。
- AC6: 官方 Relay 接受待测 Source signature 时结果为通过，结论文案仅说明 Signature 被官方 Relay 接受。
- AC7: 官方 Relay 明确拒绝待测 Source signature 时出现 `signature_interop_failed`；模型不可比或运行故障时不误报该标签。
- AC8: 页面检测步骤显示“请求 Source thinking → 校验 Source signature → 官方 Relay 复用验证 → Source 身份验证 → 最终判定”。
- AC9: 相关前后端聚焦测试、完整测试和前端生产构建通过，且现有未提交的 Claude 指纹工作不被覆盖。
