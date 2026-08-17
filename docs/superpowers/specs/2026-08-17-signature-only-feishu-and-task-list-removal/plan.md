# 飞书仅播报 Signature 异常与检测任务列表移除 Plan

## 架构概览

本次沿用现有自动巡检、站内告警和飞书小时任务，只收紧飞书发送边界，并移除检测任务页面的普通任务列表展示。

后端处理链路调整为：

```text
巡检报告
  -> 现有站内报告与告警创建规则
       -> Signature-only 飞书资格判定
          ├── 明确 Relay Signature 拒绝：notification_status=pending
          └── Kiro / 普通异常 / 运营问题：notification_status=skipped

小时任务
  -> 领取现有小时租约
  -> 扫描时间窗内待处理告警
  -> 再次执行 Signature-only 判定
       ├── 有明确 Signature 异常：合并为一条纯 Signature 飞书消息
       └── 无明确 Signature 异常：推进小时游标并跳过 Webhook
  -> 仅 Signature 告警参与 sent / failed / 重试状态流转
```

前端页面调整为：

```text
检测任务页面
  ├── 保留“提取渠道指纹”“真实性对比”创建入口
  ├── 删除普通检测任务查询、分组表和批量操作
  └── 保留自动巡检日志的独立查询、筛选、异常摘要、详情、取消和删除
```

后端普通检测任务数据和接口继续存在，本次只移除该页面上的读取和展示。

## 核心数据结构

### 飞书告警资格结果

继续复用现有内部判定结果，但允许发送的 `kind` 只保留：

- `eligible`: 只有明确 Signature 拒绝时为 `true`。
- `kind`: 命中时固定为 `invalid_thinking_signature`；其他情况为空。
- `trigger_labels`: 命中时只包含 `signature_interop_failed`。
- `skip_reason`: 未命中时使用稳定的策略跳过说明。
- `error_summary`: 命中时固定为 `Invalid signature in thinking block`。
- `occurred_at`: Signature 证据发生时间，缺失时回退到报告时间。
- `source_channel_id` / `source_channel_name`: Source 渠道标识。
- `relay_channel_id` / `relay_channel_name`: Relay 渠道标识。
- `source_message_id` / `source_request_id`: Source 侧定位标识。
- `relay_message_id` / `relay_request_id`: Relay 侧定位标识。

Kiro 身份探针字段不再进入飞书资格结果。Kiro 证据继续保留在报告、巡检日志和站内异常摘要中。

### 小时发送集合

小时任务在内存中维护两个集合：

- `eligible_alerts`: 时间窗内重新判定为明确 Signature 拒绝的告警。
- `signature_details`: 由 `eligible_alerts` 生成的安全 Signature 文案。

返回值中的 `alert_count` 和 `channel_count` 只根据 `eligible_alerts` 计算，不再代表普通真实性异常或 Kiro 数量。

### 检测任务页面状态

删除普通任务列表后，页面只保留自动巡检需要的状态：

- 当前巡检页码和每页数量。
- 当前渠道筛选和“只看错误”筛选。
- 已选择的巡检日志 ID。
- 单条删除、批量删除和取消巡检任务的进行状态。

普通任务列表数据、普通任务选择 ID、普通任务分组数据和普通任务批量删除状态全部移除。

## 核心接口

### Signature-only 飞书资格判定

```text
classify_feishu_alert(report) -> eligibility
```

判定条件保持严格交集：

1. `signature_interop.error_stage` 为 Relay。
2. HTTP 状态为 400。
3. 错误正文明确命中 `Invalid signature in thinking block` 的既有判定器。
4. `signature_ok` 明确为 `false`，或兼容旧证据中该字段缺失的情况。

Kiro、标签单独命中、低分、等级、普通 HTTP 400、网络失败和运营错误全部返回不允许发送。该接口继续在告警创建、单条发送、手动重发和小时发送前使用，避免历史告警绕过新规则。

### Signature 安全文案构造

```text
build_feishu_alert_text(alert, report, eligibility, db, setting) -> text
```

只保留 Signature 分支，固定输出：

- `Thinking Signature 异常` 标题。
- 固定错误摘要。
- Source 渠道名称与 ID。
- Relay 渠道名称与 ID。
- 异常发生时间。
- Source Message ID、Source Request ID。
- Relay Message ID、Relay Request ID。

若调用方传入非 Signature 判定结果，则返回策略跳过说明，不构造 Kiro 文案。现有字段脱敏、缺失字段显示“未提供”和长度限制保持不变。

### Signature 小时消息构造

```text
hourly_patrol_summary_text(signature_details) -> text
```

小时消息不再接收或渲染巡检统计报告。文案只包含：

- `Thinking Signature 异常汇总` 标题。
- 本次 Signature 异常条数。
- 每条 Signature 安全文案，条目之间清晰分隔。

不输出时间窗统计、巡检数、正常数、真实性异常总数、运营问题、渠道综合情况、最低分、复审链接或 Kiro 明细。每条异常自己的发生时间和定位 ID 已由安全文案构造器提供。

### 小时发送

```text
send_hourly_patrol_summary(session_factory, now) -> result
```

保留现有整点后五分钟水位、小时游标、十分钟租约和失败释放机制，调整发送决策：

1. 时间窗内没有巡检报告时，沿用现有行为推进游标并跳过。
2. 读取时间窗内 `pending` / `failed` 告警并重新判定。
3. 历史 Kiro 和其他非 Signature 告警统一更新为 `skipped`，不增加发送尝试次数。
4. 若 `eligible_alerts` 为空，推进 `last_hourly_summary_at`、释放租约，并返回“该小时无 Signature 异常”；不构造 payload、不调用 Webhook。
5. 若存在 Signature 告警，只用 `signature_details` 构造一条飞书消息。
6. Webhook 成功后，仅 Signature 告警更新为 `sent`；失败时仅 Signature 告警更新为 `failed` 并增加尝试次数。

小时游标在无 Signature 异常时仍推进，避免调度器重复扫描并反复处理同一小时。

### 单条发送、手动重发和测试消息

```text
send_alert_notification(...)
POST /api/alerts/{alert_id}/resend-notification
send_feishu_test_message(...)
```

- 单条发送和手动重发继续在 Webhook 调用前重新判定；Kiro 和其他非 Signature 告警改为 `skipped`。
- Signature 告警继续沿用现有最多三次网络重试。
- 飞书测试消息不关联巡检证据，不经过 Signature 判定，保持当前 `哈喽` 配置验证行为。

### 检测任务页面数据访问

```text
GET /api/runs?exclude_patrol=true
```

检测任务页面不再调用该普通任务列表接口。接口本身保留，避免影响其他调用方和历史兼容性。

自动巡检继续使用：

```text
GET /api/runs/patrol
GET /api/runs/patrol/anomalies
GET /api/channels
```

其分页、筛选、异常摘要、取消和删除接口不变。

## 模块设计

### 后端飞书资格边界

**职责：**

- 删除 Kiro 的飞书合格分支。
- 只允许明确 Relay Signature 拒绝进入发送集合。
- 保留站内告警创建与诊断证据。
- 保证历史 Kiro 或普通异常重发时也被拦截。

**对外接口：** 现有内部飞书资格判定函数。

**依赖：** 现有 Signature 证据结构和明确错误匹配器。

**满足需求：** F1、F2、F8。

### 后端飞书文案边界

**职责：**

- 删除 Kiro 飞书文案。
- 复用现有 Signature 安全文案中的渠道、时间和 ID。
- 将小时文案从综合运行报告改为纯 Signature 异常集合。
- 阻止完整 Signature、thinking 和凭证材料进入正文。

**对外接口：** 现有单条告警文案与小时消息构造函数。

**依赖：** 飞书资格结果、渠道显示名称查询、现有脱敏函数。

**满足需求：** F3、F4、N1。

### 后端小时调度边界

**职责：**

- 保留小时租约、游标和重试机制。
- 无 Signature 异常时推进游标但不调用飞书。
- 仅更新 Signature 告警的发送成功或失败状态。
- 将历史非 Signature 待发送状态改为策略跳过。

**对外接口：** 现有小时发送函数及调度入口。

**依赖：** 飞书配置、告警表、报告证据、现有 Webhook 发送函数。

**满足需求：** F5、F8、N2、N3、N4。

### 前端检测入口

**职责：**

- 保留页面标题及“提取渠道指纹”“真实性对比”入口。
- 用紧凑操作区替代普通检测任务列表卡片内容。
- 不请求或展示普通检测任务数据。

**对外接口：** 现有两个创建任务路由。

**依赖：** React Router、Ant Design 现有按钮样式。

**满足需求：** F6、F7。

### 前端自动巡检日志

**职责：**

- 保留现有巡检分页、渠道筛选、错误筛选和全局异常摘要。
- 保留巡检详情、取消、单条删除、删除已选和删除当前范围。
- 清理普通任务列表移除后不再使用的查询、状态、辅助函数和导入。

**对外接口：** 现有巡检 API。

**依赖：** React Query、Ant Design、现有巡检证据解析工具。

**满足需求：** F7、F8。

## 模块交互

### 飞书自动发送

```text
scheduled_test_tick
  -> send_hourly_patrol_summary
      -> 领取时间窗租约
      -> 查询时间窗内待处理告警
      -> classify_feishu_alert
          ├── Signature -> build_feishu_alert_text -> signature_details
          └── 其他 -> notification_status=skipped
      -> signature_details 为空
          -> 推进游标 + 释放租约 + 不调用 Webhook
      -> signature_details 非空
          -> hourly_patrol_summary_text
          -> post_feishu_payload
          -> 更新 Signature 告警状态 + 推进游标 + 释放租约
```

### 检测任务页面

```text
进入 /runs
  -> 渲染创建任务操作区
  -> 请求巡检日志、巡检异常摘要和渠道
  -> 不请求普通检测任务列表
  -> 用户筛选 / 展开 / 查看 / 取消 / 删除巡检日志
```

## 文件组织

```text
backend/
├── app/services.py
│   ├── 收紧飞书资格为 Signature-only
│   ├── 删除 Kiro 飞书文案
│   └── 小时消息改为无 Signature 不发送、正文仅含 Signature
└── tests/test_api.py
    ├── 更新现有 Kiro 白名单和小时汇总断言
    ├── 增加无 Signature 不调用 Webhook的覆盖
    └── 保留 Signature、脱敏、重试、锁和测试消息回归

frontend/
├── src/pages/Runs.tsx
│   ├── 删除普通任务查询、分组、选择、批量删除和表格
│   ├── 保留两个创建入口
│   └── 保留自动巡检日志完整能力
└── e2e/runs-pagination.mjs
    ├── 断言普通任务列表与相关操作不可见
    ├── 断言页面不请求普通任务列表接口
    └── 回归自动巡检分页、筛选、异常摘要和删除

docs/superpowers/specs/2026-08-17-signature-only-feishu-and-task-list-removal/
├── spec.md
├── plan.md
├── task.md
└── checklist.md
```

不修改数据库模型、迁移、公共 API 类型和普通任务后端接口。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 飞书异常范围 | 只允许明确 Relay Signature 拒绝 | 与“只统计签名问题”一致，并能由结构化证据复核 |
| Kiro 处理 | 站内保留，飞书标记为策略跳过 | 保留诊断价值，同时消除飞书噪音 |
| 无 Signature 的小时 | 推进游标但不调用 Webhook | 避免零异常播报和同一时间窗重复扫描 |
| 小时消息内容 | 合并安全 Signature 明细，不附综合统计 | 彻底去除正常、运营、渠道汇总和最低分等内容 |
| Signature 多条异常 | 同一小时合并为一条飞书消息 | 保留现有小时发送节奏，减少重复通知 |
| 飞书日报 | 本次不修改 | 日报使用独立开关和独立文案，不属于本次自动 Signature 小时通知范围 |
| 图二移除方式 | 删除普通列表展示与页面查询，保留后端数据和接口 | 满足 UI 删减要求，避免破坏历史数据和其他调用方 |
| 创建任务入口 | 保留为紧凑操作区 | 用户仍需发起指纹提取和真实性对比 |
| 自动巡检日志 | 完整保留 | 它是 Signature 和其他站内证据的主要诊断入口 |
| 数据库变更 | 不新增迁移 | 现有字段已能表达策略跳过和发送状态 |
| 测试策略 | 后端聚焦测试加前端真实页面端到端回归 | 同时验证消息边界和图二确实不可见 |

## 需求覆盖矩阵

| 需求 | 设计归属 |
|---|---|
| F1 | 后端飞书资格边界、小时调度边界 |
| F2 | 后端飞书资格边界、单条与手动重发 |
| F3 | Signature 安全文案构造、小时消息构造 |
| F4 | 小时消息构造、通知数据安全边界 |
| F5 | 小时调度边界的空集合跳过流程 |
| F6 | 前端检测入口、普通任务页面状态清理 |
| F7 | 前端检测入口、自动巡检日志模块 |
| F8 | 站内告警保留、Signature-only 资格和计数 |
| N1 | 现有脱敏与安全字段构造 |
| N2 | 现有租约、去重和重试机制复用 |
| N3 | 无模型和迁移改动 |
| N4 | 保持执行链路与巡检 API 不变 |
| N5 | 文件级范围控制和 Git 差异检查 |
