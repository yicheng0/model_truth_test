# Signature 运营故障误报抑制 Spec

## 背景

巡检详情页会在 Signature 检测整体状态为失败时，无条件展示红色“Signature 失败”提示，并继续展示 AI 疑难复核结论。后端对于权限、账号、模型访问、网络和服务故障已经将 `signature_ok` 保持为未知，但前端详情归一化丢失了该判定字段，只根据整体失败状态渲染。

因此以下未完成 Signature 验证的运营故障被错误展示成协议失败：

- Source 身份请求返回 `Upstream access forbidden`。
- Relay 返回 Bedrock 账号或模型无权访问，例如 `models is not allowed for this account`。
- 配额不足、临时不可用、网络错误、超时、HTTP 5xx 等请求故障。

这些错误只能说明本轮检测未完成，不能证明 Signature 被拒绝，也不能作为渠道真伪异常。

## 目标

- 运营故障不再在巡检详情顶部展示红色“Signature 失败”。
- 仅由运营故障导致的本轮结果不展示 AI 真伪疑难复核卡片。
- Signature 状态按“未完成验证/无法判定”展示，不计入真伪异常或 Signature 失败统计。
- 原始脱敏错误仍可在用户主动展开的请求日志或探针详情中查看。
- 明确的 Signature 协议拒绝继续醒目展示。

## 方案选择

- 推荐方案：详情展示基于三态 Signature 结果。`true` 显示通过，`false` 仅显示明确 Signature 拒绝，`null` 显示中性“未完成验证”且隐藏顶部错误和 AI 真伪结论。该方案与后端现有语义一致。
- 备选方案：仅按错误关键词隐藏两张截图中的文本。改动较小，但会遗漏其他权限、配额、网络和 5xx 运营故障，后续仍会误报。
- 不采用：完全删除运营错误。会丢失排障证据，不利于定位账号、权限和上游可用性问题。

## 功能需求

- F1: 巡检详情必须保留并使用 Signature 三态判定；不能仅根据整体 `status=fail` 判断 Signature 是否失败。
- F2: 当 Signature 判定为未知时，顶部不展示红色“Signature 失败”提示，不使用红色失败图标或错误样式。
- F3: Source/Source Identity/Relay 阶段的权限禁止、账号无权访问模型、配额不足、网络错误、超时、HTTP 5xx 和临时不可用均按“检测未完成/无法判定”处理。
- F4: 当本轮仅存在上述运营故障、没有 Kiro 身份泄漏或明确 Signature 拒绝时，不展示 AI 疑难复核的真伪结论卡片，不要求真伪复审。
- F5: 运营故障的错误正文、HTTP 状态、阶段和 Request ID 继续保存在巡检证据中，仅在用户主动展开请求日志、探针详情或原始证据时显示。
- F6: 只有明确出现 `Invalid signature in thinking block` 的 Signature 拒绝，才显示红色“Signature 失败”并作为 Signature 异常。
- F7: Kiro 身份泄漏等独立身份异常继续显示，不得因 Signature 运营故障被隐藏。
- F8: 历史记录只要包含 `signature_ok=null` 或可识别的运营故障证据，即使整体状态为失败，也按未知状态展示。

## 非功能需求

- N1: 前端展示语义必须与后端现有规则一致：`signature_ok=true` 表示 Relay 接受，`false` 表示明确拒绝，`null` 表示运营或执行不确定。
- N2: 不删除、覆盖或重新持久化历史错误证据，不修改 Request ID、HTTP 状态和请求日志。
- N3: 不展示 API Key、鉴权头、完整 Signature 或其他敏感凭据。
- N4: 不改变自动巡检执行、评分、告警发送、运营问题统计和 Signature 请求流程。
- N5: 兼容历史数据缺少结构化运营标签、但包含权限/账号/网络/状态码错误文本的情况。
- N6: 保留工作区中与本需求无关的未提交修改，只提交本次展示修复涉及的文件。

## 不做的事

- 不把所有 HTTP 400 都视为运营故障。
- 不隐藏明确的 `Invalid signature in thinking block` 拒绝。
- 不隐藏 Kiro 身份泄漏或其他独立真实性异常。
- 不删除请求日志和原始脱敏错误。
- 不新增渠道权限申请、账号配置、自动重试或模型切换功能。
- 不修改普通检测任务详情和非巡检页面。

## 验收标准

- AC1: 构造 Source Identity HTTP 500 `Upstream access forbidden`，巡检详情不出现红色“Signature 失败”和黄色 AI 真伪复核卡片；Signature 显示“未完成验证/无法判定”。
- AC2: 构造 Relay HTTP 400 `models is not allowed for this account`，巡检详情不出现红色“Signature 失败”和 AI 真伪复核卡片，不计入 Signature 异常。
- AC3: 构造配额不足、网络错误、超时、HTTP 503 和临时不可用，均按未知状态展示；主动展开请求日志后仍可看到脱敏错误、阶段、HTTP 状态和 Request ID。
- AC4: 构造 HTTP 400 `Invalid signature in thinking block`，仍显示红色“Signature 失败”，并保留明确拒绝的异常语义。
- AC5: 构造 Kiro 身份泄漏同时伴随 Signature 运营故障，仍显示身份异常，但不额外显示 Signature 失败。
- AC6: 历史数据整体 `status=fail`、`signature_ok=null` 时按未知状态展示；缺少 `signature_ok` 但错误可识别为运营故障时同样不误报。
- AC7: 前端归一化测试、详情组件测试、前端全量测试和生产构建通过；真实浏览器复查两张截图对应场景不再爆出误导性提示。
