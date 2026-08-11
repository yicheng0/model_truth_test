# Signature 告警收紧与巡检随机秒间隔 Plan

## 架构概览

本次改动集中在后端签名结果归一化、自动巡检报告/告警汇总和调度时间计算，前端只做必要的展示回归确认，不新增 API。

数据流分为两条：

1. Signature 结果流：provider/relay 原始响应 → `signature_ok` 与错误元数据 → 自动巡检报告 → 告警标签与前端详情。
2. 调度流：当前轮完成/失败/超时 → 计算下一次时间 → 持久化 `next_run_at` → 调度 tick 按已保存时间领取任务。

严格边界是：只有 `is_explicit_invalid_thinking_signature` 判定为真的错误，才允许进入 `signature_interop_failed`；其余错误必须使用现有运营失败标签或 `signature_ok = null`。

## 核心数据结构

### SignatureDecision

- `signature_ok`: `true` 表示 relay 接受 source signature；`false` 仅表示明确拒绝 thinking block signature；`null` 表示无法判定或请求未完成。
- `explicit_signature_rejection`: 是否命中明确的 thinking block signature 拒绝文案。
- `operational_failure_label`: 网络、超时、5xx、额度、资源池或其他请求失败标签；与 Signature 异常互斥。
- `raw_error`、`error_http_status`、`error_stage`、请求/响应 ID：用于详情和报告留痕。

### PatrolScheduleTiming

- `base_at`: 当前轮结束、失败或超时的调度基准时间。
- `configured_interval_minutes`: 计划原有间隔。
- `random_delay_seconds`: 短周期计划生成的 1–300 秒随机等待值；非短周期计划为空并保持原间隔。
- `next_run_at`: 持久化的下一次运行时间。

短周期定义为 `interval_minutes <= 5`。其随机延迟范围为 `[1, min(interval_minutes * 60, 300)]`；现有合法最小间隔为 5 分钟，因此实际范围为 1–300 秒。大于 5 分钟的计划继续使用原有分钟间隔和运行窗口计算。

## 核心接口

### 严格 Signature 判定

保留并集中使用现有明确错误识别器：

- 明确 `Invalid signature in thinking block` 或带反引号的等价文案 → `signature_ok=false`。
- 网络、超时、5xx、额度、资源池、身份请求失败、后处理异常或普通 400 → `signature_ok=null`，并保留运营失败标签。

结果、报告和告警入口都先清理可能残留的 `signature_interop_failed`，再依据同一判定器重新添加，避免普通错误沿链路误报。

### 随机巡检时间

扩展 `next_scheduled_run_at` 的可测试计算逻辑，接收可注入的随机秒数生成器或随机值：

- 短周期计划：从当前基准时间加 1–300 秒；必要时再应用现有运行窗口约束。
- 非短周期计划：保持当前 `interval_minutes` 加运行窗口逻辑。
- 计算结果直接写入 `ScheduledChannelTest.next_run_at`；调度 tick 只读取已保存值，不在查询或服务重启时重新随机。

成功、失败、超时恢复和 stale lock 恢复路径均调用同一下一次时间计算函数。

### 前端展示

继续展示后端的 `signature_ok`、运营失败标签、错误阶段、HTTP 状态和脱敏原始错误。普通请求失败显示“网络或检测失败/资源暂不可用/额度不足”等现有分类，不新增 Signature 异常文案。

## 模块设计

### `backend/app/services.py`

**职责：** 统一 Signature 结果归一化、报告附加、告警前标签清理，以及下一次巡检时间计算。

**对外接口：** 保持现有 API 路由和响应字段；内部函数增加可选随机值/生成器参数，不改变调用方默认行为。

**依赖：** SQLAlchemy `ScheduledChannelTest`、现有运营失败分类、UTC/运行窗口工具、标准库随机源。

### `backend/app/scheduled_probe.py`

**职责：** 保持探针状态文本和运营失败分类优先级，确保 Signature 标签不会覆盖运营失败标签。

**对外接口：** 不新增 HTTP 接口；继续输出现有 labels、classification 和 evidence 字段。

### `backend/tests/test_api.py`

**职责：** 覆盖明确拒绝、网络/超时/5xx/额度/资源池/普通 400、报告与告警标签清理、随机时间范围与持久化行为。

### 前端现有 Signature 展示模块

**职责：** 只验证后端字段的显示回归；不在前端自行推断 Signature 异常。

## 模块交互

```text
provider/relay response
  -> explicit signature matcher + operational classifier
  -> signature_ok / labels / raw error metadata
  -> report evidence and alerts
  -> frontend detail/status text

patrol completion/failure/timeout
  -> next schedule calculator
  -> persisted ScheduledChannelTest.next_run_at
  -> scheduler tick reads due rows
  -> claim/lock/concurrency/window protections remain unchanged
```

## 文件组织

```text
backend/app/services.py       # Signature 统一判定与短周期随机下一次时间
backend/app/scheduled_probe.py # 运营失败优先级与巡检分类回归
backend/tests/test_api.py     # 后端行为测试
frontend/src/signatureInterop.ts      # 仅在需要时补充展示回归测试
frontend/src/signatureInterop.test.ts # 仅在需要时补充展示回归测试
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Signature 异常判定 | 仅显式 thinking block signature 拒绝 | 消除网络错误误报，符合用户观察和既有语义 |
| 普通错误状态 | `signature_ok=null` + 运营失败标签 | 保留诊断证据，不把不可判定当成不兼容 |
| 随机范围 | 5 分钟短周期内 1–300 秒 | 避免整点/整分/整秒规律，同时不改变小时/天级计划 |
| 随机持久化 | 计算时写入 `next_run_at`，读取时不重算 | 服务重启和多实例调度不会改变已安排时间 |
| 随机可测试性 | 注入随机值/生成器并覆盖边界 | 避免测试依赖真实随机数，能验证 1 和 300 秒 |
| 运行窗口处理 | 保留现有窗口约束 | 随机化不能绕过计划允许运行时间 |
| 历史数据 | 不回写 | 降低迁移风险，明确新规则只影响新结果 |

## 需求映射

| 需求 | 负责组件 |
|---|---|
| F1、F2、F3、N1 | `services.py`、`scheduled_probe.py`、报告/告警汇总路径 |
| F4、F5、F6、N2、N3 | `services.py` 调度时间计算与现有 scheduler tick |
| F7、N4、N5 | 数据持久化、脱敏和现有数据库/调度结构 |
