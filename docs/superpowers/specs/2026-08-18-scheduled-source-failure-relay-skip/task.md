# 自动巡检 Source 故障时跳过 Relay Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/tests/test_api.py` | 先定义 Source 故障短路、跨轮恢复、正常 Relay 拒绝和调度收尾契约 |
| 修改 | `backend/app/services.py` | 实现当前轮 Source 故障判定、Relay 跳过证据和自动巡检分支 |

## T1: 添加 Source 故障短路失败测试

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**

1. 新增自动巡检场景，令当前轮所有 Source 探针返回已归类的上游请求错误。
2. 用可计数的替身替换 Signature 检测入口；若被调用则测试失败，证明 Relay 后处理没有被短路。
3. 执行一轮自动巡检，断言 Source 探针至少被调用一次、Signature/Relay 调用次数为 0。
4. 断言报告中的 Signature 证据为 `status=skipped`、`signature_ok=None`，包含 Source 错误和“Relay 未执行”步骤。
5. 断言报告标签包含运行故障标签且不包含 `signature_interop_failed`，计划状态为已完成并释放锁。
6. 运行聚焦测试，确认在实现前按预期失败。

**验证：** `cd backend && PYTHONPATH=. pytest tests/test_api.py -k scheduled_source_failure_relay_skip -v`；期望新增用例因现有编排仍调用 Signature 入口而失败。

## T2: 添加跨轮恢复和既有拒绝语义测试

**文件：** `backend/tests/test_api.py`

**依赖：** T1

**步骤：**

1. 为同一个计划连续执行两轮：第一轮 Source 返回运行错误，第二轮 Source 返回有效响应。
2. 断言第二轮重新执行 Source，而不是读取第一轮失败状态。
3. 断言第一轮 Relay 调用为 0，第二轮 Relay 调用为 1，并保存正常 Signature 证据。
4. 单独构造 Source 成功、Relay 明确拒绝 Signature 的场景，断言 Relay 仍被调用并保留 `signature_interop_failed`。
5. 断言两轮的 `next_run_at`、锁释放、巡检运行记录和历史报告均可查询。
6. 运行聚焦测试并确认实现前失败原因与跨轮/拒绝契约一致。

**验证：** `cd backend && PYTHONPATH=. pytest tests/test_api.py -k 'scheduled_source_failure_relay_skip or scheduled_source_recovery_relay_resume or scheduled_relay_signature_rejection' -v`；期望新增用例在实现前失败。

## T3: 实现当前轮 Source 故障判定和 Relay 跳过结果

**文件：** `backend/app/services.py`

**依赖：** T1、T2

**步骤：**

1. 增加只读取当前 `model_payload` 和运行状态的 Source 故障判定辅助逻辑，优先使用现有运行整体失败状态，并保留已归类的错误文本、HTTP 状态和运行故障标签。
2. 增加与现有 Signature 结果兼容的跳过结果构造逻辑：`status=skipped`、`ok=False`、`signature_ok=None`、`error_stage=source`，并记录 Source 失败与 Relay 未执行步骤。
3. 在自动巡检 Source 探针完成后、Signature 后处理前接入判定；命中时只查询官方 Relay 作为证据关联，不调用 Signature/Relay 网络请求。
4. 未命中时保留现有 Signature 调用和异常处理路径，不改变手动检测或 Source 成功场景。
5. 复用现有报告构建、脱敏、告警、`next_run_at`、巡检尝试完成和锁释放逻辑，确保跳过本轮仍正常收尾。
6. 检查标签归一逻辑，确保运行故障不会补写 `signature_interop_failed`。

**验证：** 重跑 T1、T2 聚焦测试，期望全部通过。

## T4: 完成后端回归与差异检查

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`

**依赖：** T3

**步骤：**

1. 运行 Source/Relay 相关聚焦测试，确认调用次数、证据字段、标签和调度收尾全部通过。
2. 运行完整后端测试，确认既有手动 Signature、自动巡检、告警和调度恢复行为无回归。
3. 运行 `git diff --check`，确认无空白错误。
4. 检查 Git 差异只包含本任务实现、测试和已批准的四阶段文档，不覆盖工作树中的既有修改。

**验证：** `cd backend && PYTHONPATH=. pytest tests/test_api.py -q`、`cd backend && PYTHONPATH=. pytest -q`、仓库根目录 `git diff --check`；期望全部退出码为 0。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4
```
