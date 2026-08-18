# 自动巡检 Source 故障时跳过 Relay Spec

## 背景

自动巡检在每个调度时间点测试一个待测渠道（Source），并在 Signature 互通检测中把 Source 产生的内容交给官方参考渠道（Relay）复用验证。当前当轮 Source 已经请求失败时，自动巡检仍可能继续进入 Relay 后处理，造成无效的 Relay 请求、额外成本和误导性的跨渠道结果。

渠道故障可能是暂时性的：本轮 Source 挂掉，不代表下一轮仍然不可用。因此需要按巡检轮次做短路，而不能把渠道永久标记为不可测或停止后续巡检。

## 目标

- 每个自动巡检时间点都重新测试 Source。
- 当本轮 Source 明确请求失败时，本轮不向 Relay 发起请求，并记录可追踪的跳过原因。
- 下一次调度仍按原计划测试 Source；Source 恢复后，Relay 验证自动恢复。
- 区分 Source 运行故障与 Signature 明确不兼容，避免错误产生 Signature 失败异常。

## 功能需求

- F1: 每个自动巡检轮次必须先完成待测 Source 的本轮请求判断；不能使用上一轮 Source 成功或失败状态替代本轮请求。
- F2: 当本轮 Source 请求返回错误、超时、不可用或其他已归类的运行失败时，自动巡检本轮不得向官方 Relay 发起 Signature 复用请求。
- F3: Source 故障导致 Relay 跳过时，巡检证据必须记录 Source 失败、Relay 未执行及可读原因；该状态应归类为运行故障或不可比，不得新增 `signature_interop_failed`。
- F4: 当本轮 Source 请求成功并产生可供验证的内容时，自动巡检继续执行现有 Source → Relay Signature 验证流程，成功、明确 Signature 拒绝和 Relay 运行故障仍按既有规则区分。
- F5: 下一次自动巡检到达时间时，系统必须再次请求 Source；若 Source 已恢复，本轮必须重新允许 Relay 请求，不受上一轮跳过状态影响。
- F6: Source 故障短路不得改变自动巡检的调度时间推进、锁释放、轮次记录、告警生成和历史报告可读性；本轮仍应正常结束并留下证据。

## 非功能需求

- N1: 不新增永久熔断、跨轮失败缓存、人工恢复开关或改变现有调度间隔的机制。
- N2: 不持久化 API Key、认证头或其他凭证；新增证据沿用现有脱敏规则。
- N3: 保持 SQLite、PostgreSQL、Mock 模式和现有自动巡检 API 兼容；Mock 模式不因本需求引入真实 Relay 请求。
- N4: 必须有测试证明 Source 失败时 Relay 调用次数为零，并证明下一轮 Source 恢复后 Relay 会再次调用。

## 不做的事

- 不改变普通手动 Signature 检测的 Source → Relay 调用顺序。
- 不在 Source 失败后对 Source 做同一轮额外重试；是否跨轮重试仍由现有调度规则决定。
- 不修改 Signature 评分权重、异常白名单、渠道启停配置或历史记录。
- 不把所有 Source 非 200 响应都重新定义为 Signature 失败；继续沿用现有运行故障分类。

## 验收标准

- AC1: 构造一轮 Source 请求失败的自动巡检，观察到 Source 请求被执行、Relay 请求次数为 0，且报告中的 Signature 证据显示 Relay 已跳过并包含原因。
- AC2: AC1 场景的报告和告警标签包含运行故障或不可比标签，不包含 `signature_interop_failed`。
- AC3: 在 Source 失败后推进到下一次调度，令 Source 恢复并返回有效内容，观察到该轮 Source 请求被执行且 Relay 请求次数为 1，结果进入现有 Signature 验证流程。
- AC4: 构造 Source 成功但 Relay 明确拒绝 Signature 的场景，仍观察到 Relay 请求被执行并保留既有 `signature_interop_failed` 语义，证明短路条件只针对 Source 故障。
- AC5: 自动巡检的 `next_run_at`、锁状态、轮次记录和历史报告在 Source 短路后与正常结束规则一致；相关后端聚焦测试、完整测试和差异检查通过。
