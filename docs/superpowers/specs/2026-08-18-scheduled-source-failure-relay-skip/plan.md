# 自动巡检 Source 故障时跳过 Relay Plan

## 架构概览

在自动巡检的 Source 探针完成后增加一个“本轮 Source 是否可继续”的判定层。判定只读取当前轮 `model_payload` 与其关联运行状态，不读取历史报告或上一轮状态。

```text
调度触发
  -> 当前轮 Source 探针
  -> Source 运行状态判定
       ├─ 当前轮 Source 整体失败 -> 生成 Relay 跳过证据 -> 构建报告/结束本轮
       └─ Source 可继续 -> 现有 Source -> Relay Signature 检测 -> 构建报告/结束本轮
下一轮调度始终重新进入 Source 探针
```

不新增 API、数据库列或前端页面；现有报告的 `signature_interop` 证据承载跳过状态，现有调度收尾逻辑继续负责推进时间、释放锁和创建告警。

## 核心数据结构

### Source 故障判定

- 输入：当前轮 Source 探针返回的运行对象、探针结果列表及错误信息。
- 输出：是否阻止本轮 Relay，以及用于证据的脱敏错误文本和运行故障标签。
- 判定边界：以当前轮运行整体失败或全部可用探针均为已归类运行失败为阻止条件；单个预期的参数不支持不应被误判为渠道整体挂掉。

### Relay 跳过结果

沿用现有 Signature 结果结构，填充以下语义：

- `status`: `skipped`。
- `ok`: `false`，表示本轮 Signature 未完成，不表示 Relay 拒绝。
- `signature_ok`: `null`，因为没有进入 Signature 验证。
- `source_channel_id` / `relay_channel_id`: 当前轮 Source 和已选择的官方 Relay（仅用于证据，不发起 Relay 请求）。
- `error_stage`: `source`；`raw_error`、`reason` 和 `steps` 记录 Source 失败与 Relay 未执行。
- `labels`: 使用既有运行故障标签；不包含 `signature_interop_failed`。

## 核心接口

### Source 故障判定辅助函数

**用途：** 将当前轮 Source 探针结果归一为是否跳过 Relay 的决定和脱敏原因。

**输入：** `model_payload` 及其 `run`、`results`、错误字段。

**输出：** `None`（Source 可继续）或包含 `reason`、`raw_error`、`error_http_status`、`label` 的判定结果。

**约束：** 纯当前轮判断，不保存状态，不发起网络请求。

### Relay 跳过结果构造

**用途：** 为 Source 故障轮生成可供报告、Markdown 和告警使用的 Signature 跳过证据。

**输入：** 数据库会话、计划、当前轮 Source 失败判定。

**输出：** 与现有 Signature 结果兼容的字典；只查询 Relay 配置，不调用 Relay。

## 模块设计

### 自动巡检编排

**职责：** 在 Source 探针返回后、Signature 后处理前调用故障判定；命中时使用跳过结果，不调用现有 Signature 执行函数；未命中时保持原分支。

**依赖：** 当前轮 `model_payload`、计划模块配置、现有报告构建和调度收尾逻辑。

**覆盖需求：** F1、F2、F4、F5、F6。

### Signature 证据与报告

**职责：** 接收 `status=skipped` 的运行故障结果，保留 Source 错误、Relay 未执行和渠道角色信息；沿用现有运行故障归一，避免补写 Signature 失败标签。

**依赖：** 现有 `build_scheduled_probe_report`、报告脱敏和 Markdown 渲染。

**覆盖需求：** F3、F6。

### 后端回归测试

**职责：** 使用可控的 Source/Relay 调用替身验证调用顺序、调用次数、证据和跨轮恢复，不改变现有手动 Signature 测试。

**覆盖需求：** AC1-AC5。

## 模块交互

1. 调度器启动当前轮并调用 Source 探针；该调用每轮独立执行。
2. 编排层读取当前轮运行状态和探针错误，忽略上一轮结果。
3. 若 Source 整体失败，查询官方 Relay 作为证据关联对象，生成跳过结果，Relay 网络调用次数保持为零。
4. 报告构建器合并 Source 探针和跳过结果，保留运行故障标签，完成本轮报告、告警与锁释放。
5. 下一次调度重新执行步骤 1；若 Source 成功，进入现有 Signature Source → Relay 流程。

## 文件组织

```text
backend/app/services.py        # Source 故障判定、Relay 跳过结果和自动巡检编排分支
backend/tests/test_api.py      # Source 失败短路、跨轮恢复、正常 Relay 拒绝和调度收尾回归
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 短路位置 | 自动巡检 Source 探针之后、Signature 后处理之前 | 避免无效 Relay 请求，同时保留每轮 Source 测试 |
| 故障范围 | 当前轮整体 Source 运行失败才短路 | 不把单个预期参数拒绝误判为渠道挂掉 |
| 跨轮状态 | 不缓存、不熔断，每轮重新判定 | 支持渠道从故障恢复后自动恢复 Relay 验证 |
| 结果状态 | `skipped` + `signature_ok=null` + 运行故障标签 | 区分“未执行”与“Relay 明确拒绝 Signature” |
| Relay 配置读取 | 只解析当前可用官方 Relay，不发起网络调用 | 保留 Source/Relay 角色证据且不产生额外请求 |
| 调度收尾 | 复用现有报告、告警、`next_run_at` 和锁释放流程 | 降低回归风险，保持 API 与历史可读性 |
