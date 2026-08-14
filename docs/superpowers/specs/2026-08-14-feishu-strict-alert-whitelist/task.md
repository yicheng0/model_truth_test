# 飞书即时告警严格白名单 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/tests/test_api.py` | 先补充白名单、通知字段、脱敏、状态流转与回归测试 |
| 修改 | `backend/app/services.py` | 实现严格资格判定、安全文案、通知状态过滤和发送前复核 |

不修改数据库模型、迁移、前端文件或公共响应 schema。

## T1: 增加严格白名单判定测试

**文件：** `backend/tests/test_api.py`
**依赖：** 无

**步骤：**

1. 添加明确 Signature 拒绝正例：Relay 阶段、HTTP 400、错误正文命中 `Invalid signature in thinking block`。
2. 添加 Kiro 结构化身份泄漏正例，并验证 Kiro 在同报告同时存在 Signature 异常时优先。
3. 添加非白名单反例：仅 `signature_interop_failed` 标签、普通 HTTP 400、HTTP 5xx、网络/额度/权限错误、低评分、D/E 等级、`protocol_mismatch` 和普通身份异常。
4. 断言正例返回稳定异常类型，反例均返回不允许发送及稳定跳过原因。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility" -q`，期望新增测试因判定器尚未实现而失败，且失败原因与缺失行为一致。

## T2: 实现严格白名单判定器

**文件：** `backend/app/services.py`
**依赖：** T1

**步骤：**

1. 定义内部飞书告警资格结果，包含资格、异常类型、严格标签、跳过原因和通知所需结构化证据。
2. 从报告证据识别结构化 `kiro_identity_leak`，不把普通身份失败或其他模型自报异常视为 Kiro。
3. 复用现有明确 Signature 错误匹配，仅允许 Relay 阶段 HTTP 400 且正文明确命中的拒绝。
4. 禁止使用评分、等级、通用失败状态或旧告警标签放宽资格。
5. 确保同一报告同时命中时只返回 Kiro 类型。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility" -q`，期望 T1 新增测试全部通过。

## T3: 增加通知证据提取与安全文案测试

**文件：** `backend/tests/test_api.py`
**依赖：** T2

**步骤：**

1. 为 Signature 正例准备 Source/Relay 渠道名称与 ID、双方 Message ID、Request ID、探针时间及包含长 Signature、thinking、API Key、认证头的原始证据。
2. 断言文案包含固定短摘要、Source/Relay 渠道、发生时间和双方 ID。
3. 为 Kiro 正例准备命中的身份探针渠道、Message ID、Request ID 和完成时间，断言文案只展示身份探针定位信息。
4. 添加缺失 ID 的边界用例，断言对应位置显示“未提供”。
5. 断言文案不包含完整 Signature、Signature 前缀、thinking、API Key、认证头和完整原始请求/响应片段。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text" -q`，期望新增测试因安全文案尚未实现而失败，且不出现测试数据构造错误。

## T4: 实现结构化证据提取和安全通知文案

**文件：** `backend/app/services.py`
**依赖：** T3

**步骤：**

1. 为 Signature 从现有 `signature_interop` 字段提取 Source/Relay 渠道、Message ID、Request ID 和发生时间。
2. 为 Kiro 优先从命中的 `identity_self_report` 记录提取渠道、Message ID、Request ID 和发生时间，并实现批准的旧报告回退顺序。
3. 渠道名称缺失时按渠道 ID 查询现有渠道记录；标识缺失时输出“未提供”。
4. 对渠道名称和标识复用现有文本脱敏与长度限制。
5. 构造 Signature 与 Kiro 两种固定格式文本，错误摘要使用固定短文案，不传入原始证据。
6. 调整现有 `feishu_text_payload`，使单条通知只接受白名单判定结果生成的安全文本。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_text" -q`，期望 T3 新增测试全部通过。

## T5: 增加新建告警通知状态测试

**文件：** `backend/tests/test_api.py`
**依赖：** T4

**步骤：**

1. 验证明确 Signature 拒绝和 Kiro 告警创建后为 `pending`。
2. 验证普通真实性异常仍创建站内告警，但通知状态为 `skipped`，并记录“不符合飞书即时告警白名单”的原因。
3. 验证运营故障继续遵循现有站内规则，不被新增逻辑伪装成 Signature 或 Kiro。
4. 验证现有去重键、静默期和连续窗口计数行为不变。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "alert_notification_initial_status or alert_dedup" -q`，期望新增状态测试在实现接入前失败，现有去重测试保持通过。

## T6: 接入告警创建时的通知资格状态

**文件：** `backend/app/services.py`
**依赖：** T5

**步骤：**

1. 保持 `report_needs_alert`、站内告警内容、严重级别、去重和静默期逻辑不变。
2. 创建新告警时调用严格白名单判定器。
3. 白名单正例设置 `notification_status=pending`；其他站内告警设置 `notification_status=skipped` 和稳定策略原因。
4. 保留站内 `trigger_labels` 的完整标签集合，不用飞书严格标签覆盖站内证据。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "alert_notification_initial_status or alert_dedup" -q`，期望 T5 新增测试与相关现有回归全部通过。

## T7: 增加手动重发发送前复核测试

**文件：** `backend/tests/test_api.py`
**依赖：** T6

**步骤：**

1. 创建历史 `pending`/`failed` 告警，仅保留旧 `signature_interop_failed` 标签但无明确拒绝正文。
2. 调用单条通知函数和现有手动重发接口，断言不调用飞书 Webhook、状态改为 `skipped`、真实发送尝试次数不增加。
3. 对 Signature 和 Kiro 白名单正例分别断言 Webhook 被调用，发送文本包含批准字段。
4. 模拟飞书发送连续失败，验证白名单正例仍沿用现有最多三次网络重试与 `failed` 状态。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_resend_whitelist or alert_notification_marks_failed" -q`，期望新增复核测试在发送边界接入前失败，现有失败重试测试保持可运行。

## T8: 在单条发送和手动重发前复核白名单

**文件：** `backend/app/services.py`
**依赖：** T7

**步骤：**

1. 在增加真实发送尝试次数和读取 Webhook 之前加载关联报告并重新执行白名单判定。
2. 非白名单告警设置 `skipped` 和稳定策略原因，不调用 Webhook、不增加真实发送尝试次数。
3. 白名单告警使用安全通知文案，再执行现有开关、Webhook 配置和最多三次网络重试。
4. 保持现有手动重发 API 统一调用单条发送函数，不增加旁路。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_resend_whitelist or alert_notification_marks_failed" -q`，期望 T7 新增测试与相关现有测试全部通过。

## T9: 增加小时汇总白名单过滤和安全明细测试

**文件：** `backend/tests/test_api.py`
**依赖：** T8

**步骤：**

1. 在同一小时内创建 Signature、Kiro、普通真实性异常和历史残留标签告警。
2. 断言小时汇总仍只有一次 Webhook 调用并保留巡检、正常、真实性异常和运营问题统计。
3. 断言正文只追加 Signature/Kiro 安全明细，包含各自渠道、时间和 ID，不包含普通异常详情或敏感原始证据。
4. 断言发送成功后仅白名单告警变为 `sent`，非白名单历史告警变为 `skipped`。
5. 模拟汇总发送失败，断言仅白名单告警变为 `failed` 并增加尝试次数。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary and whitelist" -q`，期望新增测试在小时发送接入前失败。

## T10: 在小时汇总中应用白名单和安全异常明细

**文件：** `backend/app/services.py`
**依赖：** T9

**步骤：**

1. 小时窗口读取 `pending`/`failed` 告警后逐条加载报告并重新判定资格。
2. 立即把历史非白名单告警改为 `skipped` 和稳定策略原因，使其不进入失败重试队列。
3. 为白名单告警生成与单条发送相同字段和脱敏规则的安全明细，并追加到现有小时统计文本。
4. 汇总成功或失败时只更新白名单告警的发送状态、尝试次数和通知时间。
5. 保持小时租约、空窗口推进、五分钟收尾等待和单次综合消息行为不变。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary" -q`，期望新增白名单测试及现有小时汇总测试全部通过。

## T11: 增加飞书测试消息与日报口径回归测试

**文件：** `backend/tests/test_api.py`
**依赖：** T10

**步骤：**

1. 验证飞书测试消息继续绕过巡检白名单并正常调用 Webhook。
2. 验证小时汇总和日报中的运营问题继续称为运营问题，不出现 Signature 或 Kiro 即时异常措辞。
3. 验证普通真实性异常仍可在站内报告、告警详情和统计中查看。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_test_message or smart_patrol_daily or hourly_patrol_summary" -q`，期望新增回归测试全部通过。

## T12: 运行聚焦回归并修正兼容性问题

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`
**依赖：** T11

**步骤：**

1. 运行飞书、告警、Signature、Kiro、小时汇总相关测试。
2. 修正因通知初始状态从 `pending` 变为 `skipped` 导致的旧断言，但不改变已批准的站内告警行为。
3. 检查所有测试载荷都不把真实或示例密钥写入日志输出。
4. 运行差异格式检查，清理空白和无关改动。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu or alert or signature_interop or kiro or hourly_patrol_summary" -q`，期望全部通过；运行 `git diff --check -- backend/app/services.py backend/tests/test_api.py`，期望无输出且退出码为 0。

## T13: 运行后端全量回归

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`
**依赖：** T12

**步骤：**

1. 使用临时 SQLite 数据库运行后端完整测试套件，避免污染默认本地数据库。
2. 若出现失败，只修复与本任务同一行为链相关的回归；无关失败记录证据并停止扩大范围。
3. 确认工作区仅包含本任务文档、目标代码/测试以及用户原有的无关修改。

**验证：** 运行 `cd backend && test_db_dir=$(mktemp -d) && DATABASE_URL="sqlite:///$test_db_dir/test.db" python3 -m pytest -q`，期望全部测试通过；运行 `git status --short`，期望用户原有 `docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md` 修改保持未被本任务覆盖或暂存。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9 -> T10 -> T11 -> T12 -> T13
```

所有任务串行执行：后续任务依赖前一阶段的失败测试或已实现行为，不进行共享文件并行修改。
