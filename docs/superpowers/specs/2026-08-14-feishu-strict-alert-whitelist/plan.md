# 飞书即时告警严格白名单 Plan

## 架构概览

本次在现有站内告警与飞书发送之间增加唯一的“飞书即时告警白名单判定”。站内是否创建告警继续沿用当前评分、等级和异常标签规则；飞书是否实际发送则只依据报告中的两类明确证据：

1. Kiro 身份泄漏。
2. Relay 返回 HTTP 400，且错误正文明确包含 `Invalid signature in thinking block`。

白名单会在三个位置使用：

```text
巡检报告
  -> 现有站内告警创建规则
       -> 飞书白名单判定
          ├── 命中 Kiro / 明确 Signature：notification_status=pending
          └── 其他告警：notification_status=skipped，站内记录保留

小时汇总发送
  -> 读取 pending / failed 历史告警
  -> 再次执行白名单判定
       ├── 白名单告警参与通知状态更新和失败重试
       └── 历史非白名单告警改为 skipped
  -> 汇总消息仍可包含巡检次数、站内异常和运营统计

手动重发
  -> 再次执行白名单判定
       ├── 白名单告警按现有三次重试发送
       └── 非白名单告警保持 skipped，不调用飞书 Webhook
```

这样既不会删除站内报告和复核入口，也能阻止旧数据、历史残留标签或手动重发绕过新策略。

## 核心数据结构

### 飞书即时告警判定结果

使用轻量内部结构表达一次判定：

- `eligible`: 是否允许发送飞书即时异常通知。
- `kind`: 命中时为 `invalid_thinking_signature` 或 `kiro_identity_leak`，未命中时为空。
- `trigger_labels`: 发送时使用的严格标签，仅保留对应异常标签。
- `skip_reason`: 未命中时记录“不符合飞书即时告警白名单”的稳定说明。
- `occurred_at`: 从对应探针证据中提取的异常发生时间；证据缺失时回退到报告或告警时间。
- `source_channel` / `relay_channel`: Signature 告警使用的 Source、Relay 渠道标识与显示名称。
- `source_message_id` / `source_request_id`: Source 侧可用标识。
- `relay_message_id` / `relay_request_id`: Relay 侧可用标识。
- `identity_channel` / `identity_message_id` / `identity_request_id`: Kiro 身份探针对应的渠道与标识。
- `error_summary`: 严格归一化后的短摘要，只允许 `Invalid signature in thinking block` 或 `Kiro identity leak`，不透传原始错误正文。

该结构只在服务内部使用，不新增数据库字段或公共 API 字段。

### 证据输入

判定器读取现有 `Report.evidence`：

- 顶层 `labels`。
- `signature_interop.signature_ok`。
- `signature_interop.error_http_status`。
- `signature_interop.error_stage`。
- `signature_interop.raw_error` 与 `signature_interop.reason`。
- `signature_interop.identity_labels`。
- 固定身份探针 `model_requests` 中的结构化标签。

不读取等级、分数、通用失败状态或告警旧标签来放宽白名单。

### 通知证据提取

Signature 通知字段按以下优先级提取：

- Source 渠道：`signature_interop.source_channel_id`，名称优先使用 `source_channel_name`，缺失时按渠道 ID 查询现有渠道记录。
- Relay 渠道：`signature_interop.relay_channel_id`，名称优先使用 `relay_channel_name`，缺失时按渠道 ID 查询现有渠道记录。
- Source Message ID / Request ID：分别读取 `source_message_id`、`source_request_id`。
- Relay Message ID / Request ID：分别读取 `relay_message_id`、`relay_request_id`。
- 发生时间：优先使用 Signature 证据的 `completed_at`，其次 `created_at`，再回退到报告或告警创建时间。

Kiro 通知字段只从命中的身份探针提取：

- 优先选择 `model_requests` 中 `key=identity_self_report` 且包含 `kiro_identity_leak` 标签的记录。
- 若旧报告没有上述列表记录，则回退到顶层 `model_request` 或 `signature_interop` 的身份字段，但仍要求报告存在结构化 Kiro 泄漏证据。
- 渠道优先使用身份探针的 `channel_id` / `channel_name`，其次使用报告的待测渠道。
- Message ID 优先使用 `message_id`，其次使用 `response_id`；Request ID 使用 `request_id`。
- 发生时间优先使用身份探针 `completed_at`，其次 `created_at`，再回退到报告或告警创建时间。

所有缺失的渠道名称或标识在飞书正文中统一显示“未提供”，不从完整原始请求、响应或 header 值中临时拼装。

### 通知状态

继续复用现有状态字段：

- `pending`: 白名单异常等待小时通知或手动发送。
- `sent`: 白名单异常对应的飞书发送成功。
- `failed`: 白名单异常调用飞书失败，可按现有机制重试。
- `skipped`: 飞书未启用、Webhook 未配置，或告警不符合严格白名单。

非白名单使用稳定的 `notification_error` 说明策略跳过，不伪装成网络发送失败。

## 核心接口

### 飞书告警资格判定

```text
classify_feishu_alert(report) -> eligibility
```

用途：

- 新建站内告警时决定初始通知状态。
- 小时发送前过滤新旧告警。
- 手动重发前阻止历史误报。
- 生成单条飞书文案时选择严格异常类型和标识。

判定顺序：

1. 若报告含结构化 `kiro_identity_leak`，返回 Kiro。
2. 否则检查 Signature：必须是 Relay 阶段、HTTP 400、错误正文命中现有明确 Signature 拒绝判定；`signature_ok=false` 或兼容的历史缺失状态可作为辅助，但标签本身不能单独通过。
3. 其他情况全部返回不允许发送。

Kiro 优先于 Signature，避免同一报告发送两条即时通知。

### 安全通知文案构造

```text
build_feishu_alert_text(alert, report, eligibility) -> text
```

用途：

- 为单条发送和手动重发生成同一套严格文案。
- 为小时汇总中的白名单异常明细生成文本块。

Signature 文案固定包含：

- 异常类型与精简错误摘要。
- Source 渠道名称和 ID。
- Relay 渠道名称和 ID。
- 异常发生时间。
- Source Message ID、Source Request ID。
- Relay Message ID、Relay Request ID。

Kiro 文案固定包含：

- 异常类型与精简错误摘要。
- 命中的待测渠道名称和 ID。
- 异常发生时间。
- 身份探针 Message ID、Request ID。

构造器只接收白名单判定产生的结构化字段。它不接收或输出 Signature 值、thinking 内容、原始请求、原始响应、认证头或 API Key；标识在输出前继续经过现有文本脱敏与长度限制。

### 站内告警创建

```text
create_alerts_for_run(...)
```

现有告警创建、去重、静默期和人工复核逻辑保持不变，只调整通知初始状态：

- 白名单异常：`pending`。
- 非白名单异常：`skipped`，并写入策略跳过原因。

站内 `trigger_labels` 继续保留完整异常标签，避免影响已有详情、筛选和统计；飞书发送文案使用严格判定结果，不把非白名单标签带入即时通知。

重复告警命中现有去重记录时，仍沿用原有静默期和连续窗口计数；通知资格在后续实际发送前重新根据最新关联报告复核，不因旧告警标签而放宽。

### 单条通知与手动重发

```text
send_alert_notification(...)
POST /api/alerts/{alert_id}/resend-notification
```

发送函数首先读取关联报告并重新判定资格：

- 不符合白名单时，更新为 `skipped`，不增加真实发送尝试次数，不调用 Webhook。
- 符合白名单时，再检查飞书开关和 Webhook，并沿用现有三次网络重试。
- 符合白名单时，使用安全通知文案构造器生成包含渠道、时间和 ID 的文本，不再发送通用评分、等级或完整异常标签文案。

重发接口无需新增分支逻辑，因为它继续统一调用发送函数。

### 小时汇总

```text
send_hourly_patrol_summary(...)
```

小时汇总仍按现有时间窗发送一次综合统计消息，并保留正常、站内异常和运营问题统计。通知状态处理改为：

- 只对白名单告警执行 `pending/failed -> sent/failed` 状态流转。
- 对时间窗内遗留的历史非白名单 `pending/failed` 告警改为 `skipped`。
- 小时汇总发送失败时，只将白名单告警记为通知失败；普通站内告警不进入飞书重试队列。
- 小时汇总正文保留运营统计，并追加时间窗内每条白名单异常的安全明细文本；这些明细与单条发送使用同一字段和脱敏规则。

汇总文案中的运营问题继续明确称为运营问题，不改写为 Signature 或 Kiro 即时异常。

### 飞书测试消息

```text
send_feishu_test_message(...)
```

该接口不关联巡检告警，不执行白名单判定，保持现有行为。

## 模块设计

### 严格白名单判定器

**职责：**

- 从报告证据中识别 Kiro 和明确 Signature 拒绝。
- 复用现有 Signature 错误文本匹配，避免产生第二套正则口径。
- 返回稳定的异常类型、严格标签和跳过原因。
- 不依赖分数、等级或历史告警标签。

**对外接口：** 仅供后端服务内部调用。

**依赖：** 现有报告证据结构、`is_explicit_invalid_thinking_signature`、现有脱敏逻辑。

### 告警持久化边界

**职责：**

- 保留所有满足站内规则的 `ChannelAlert`。
- 根据白名单设置通知初始状态。
- 保持现有去重键、静默期、严重级别和人工复核字段。

**依赖：** 严格白名单判定器、现有告警模型。

### 飞书发送边界

**职责：**

- 在每次真实调用 Webhook 前重新读取报告证据并判定。
- 白名单命中后才构造单条异常文案和执行重试。
- 统一解析 Source、Relay、身份探针渠道和两类 ID，并格式化发生时间。
- 只输出归一化短摘要及允许的结构化定位字段。
- 非白名单统一标记为策略跳过。

**依赖：** 严格白名单判定器、飞书配置、现有签名和 HTTP 发送函数。

### 通知数据安全边界

**职责：**

- 对所有渠道名称、ID 和时间字段应用现有文本脱敏与长度限制。
- 缺失字段输出“未提供”，不回退展示完整原始证据。
- Signature 只用于判定，完整值和前缀都不进入飞书。
- 原始错误只用于匹配明确拒绝，正文仅输出固定精简摘要。

**依赖：** 现有文本脱敏函数、严格白名单判定结果。

### 小时统计边界

**职责：**

- 保留现有综合统计发送。
- 将即时通知状态与广义站内统计分离。
- 只对白名单告警执行通知成功、失败和重试状态更新。

**依赖：** 严格白名单判定器、现有小时租约、统计报告和飞书发送函数。

## 模块交互

### 新告警

```text
Report
  -> report_needs_alert
  -> 创建 ChannelAlert
  -> classify_feishu_alert
       -> eligible: notification_status=pending
       -> ineligible: notification_status=skipped + skip_reason
```

### 小时发送

```text
小时租约成功
  -> 构建综合巡检统计
  -> 加载 pending/failed 告警
  -> classify_feishu_alert
       -> eligible_alert_ids
       -> skipped_alert_ids
  -> 为 eligible 生成安全异常明细
  -> 发送一条“运营统计 + 白名单异常明细”的小时汇总
       -> 成功：eligible -> sent
       -> 失败：eligible -> failed
       -> skipped 始终保持 skipped
```

### 手动重发

```text
POST resend
  -> send_alert_notification
  -> 加载 Alert + Report
  -> classify_feishu_alert
       -> ineligible: skipped，返回站内告警
       -> eligible: 飞书配置检查 -> 最多三次发送 -> sent/failed
```

## 文件组织

```text
backend/
├── app/
│   └── services.py       # 白名单判定、告警初始状态、小时过滤和发送前复核
└── tests/
    └── test_api.py       # Signature/Kiro 正例、字段提取与脱敏、普通异常和历史重发反例、小时统计与测试消息回归
```

不修改数据库模型、迁移、前端页面或公共响应 schema。

## 需求映射

| 需求 | 设计归属 |
|---|---|
| F1、F4 | 严格白名单判定器的 Signature 分支 |
| F2、F5 | 严格白名单判定器的 Kiro 分支 |
| F3 | 新建初始状态、小时过滤、发送前复核三处共同保证 |
| F6 | 告警持久化边界与 `skipped` 状态 |
| F7 | Signature 通知证据提取与安全通知文案构造 |
| F8 | Kiro 身份探针证据提取与安全通知文案构造 |
| F9 | 通知数据安全边界与固定精简摘要 |
| F10 | 小时统计边界与现有日报链路回归 |
| N1 | 保持现有去重、静默期和重试实现 |
| N2 | 只修改服务和测试，不改模型与迁移 |
| N3 | 单条发送和小时发送前重新判定 |
| N4 | 测试消息接口不接入白名单 |

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 收紧站内告警还是飞书发送 | 只收紧飞书通知资格 | 保留报告、历史、复核和统计能力，符合批准范围 |
| Signature 判定 | HTTP 400 + Relay 阶段 + 明确错误正文 | 截图证据明确，且避免历史标签和普通 400 误报 |
| Kiro 判定 | 结构化 `kiro_identity_leak` 优先 | 现有检测已产生稳定标签，误报风险低 |
| 历史数据处理 | 发送时动态复核并改为 skipped | 无需迁移，也能阻止旧告警手动重发 |
| 非白名单通知状态 | `skipped` + 稳定原因 | 与网络失败区分，站内仍可解释 |
| 小时汇总 | 保留综合统计，只收紧告警状态和即时异常口径 | 满足 F10，同时避免普通告警进入发送重试队列 |
| 测试消息 | 完全豁免白名单 | 它用于验证飞书配置，不属于巡检异常 |
| 自动通知承载方式 | 在现有小时汇总中追加白名单异常明细，手动重发使用同一文案 | 保持现有发送节奏和租约机制，同时保证自动通知包含渠道、时间与 ID |
| 错误摘要 | 输出固定短摘要，不直接截取 `raw_error` | 避免完整 Signature、thinking、认证信息或其他原始证据泄漏 |
| 缺失标识 | 统一显示“未提供” | 明确区分证据缺失，避免从不安全原始字段猜测或拼装 |
