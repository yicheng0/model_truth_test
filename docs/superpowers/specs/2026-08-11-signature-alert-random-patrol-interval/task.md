# Signature 告警收紧与巡检随机秒间隔 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/tests/test_api.py` | 先添加签名误报和随机调度的失败测试，再保留接口回归覆盖 |
| 修改 | `backend/app/services.py` | 实现严格 Signature 标签边界和短周期随机下一次时间 |
| 修改 | `backend/app/scheduled_probe.py` | 校正运营失败与 Signature 状态文本/分类优先级（如测试暴露缺口） |
| 修改（必要时） | `frontend/src/signatureInterop.ts`、`frontend/src/signatureInterop.test.ts` | 确认前端只按后端 `signature_ok` 与标签展示，不自行把普通错误写成 Signature 异常 |
| 不修改 | `backend/app/models.py`、数据库迁移 | 复用现有 `next_run_at`，不新增字段 |

## T1: 建立 Signature 判定回归矩阵

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**
1. 扩展明确拒绝测试，覆盖带反引号、大小写变化、换行和 request id 的 thinking block signature 错误。
2. 增加网络、连接失败、超时、502/503、资源池无可用渠道、额度不足、身份失败、后处理异常和普通 400 的参数化用例。
3. 验证这些非 Signature 错误返回 `signature_ok=None` 或运营失败状态，不包含 `signature_interop_failed`，并保留错误阶段、HTTP 状态、脱敏错误和请求 ID。
4. 验证报告附加、自动巡检分类和告警生成不会把运营失败重新升级为 Signature 异常。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k 'signature or scheduled_probe_operational or scheduled_operational'`，新增测试应先失败或暴露当前误报路径。

## T2: 收紧 Signature 结果、报告和告警标签

**文件：** `backend/app/services.py`、`backend/app/scheduled_probe.py`

**依赖：** T1

**步骤：**
1. 梳理所有写入、合并和清理 `signature_interop_failed` 的路径，统一使用明确 thinking block signature 判定器。
2. 当结果是网络/超时/5xx/额度/资源池/后处理等运营失败时，清除残留 Signature 标签，保留对应运营失败标签和完整脱敏元数据。
3. 保持明确 Signature 拒绝的 `signature_ok=False`、报告异常标签和告警行为不变。
4. 确认 source 缺少 block/signature、模型不可比和 setup 失败仍是无法判定/证据缺失，不误报为明确拒绝。
5. 不改动手动 Signature 测试的 API 字段和历史记录。

**验证：** 重跑 T1 命令，期望所有 Signature/运营失败回归测试通过；再运行 `cd backend && python3 -m pytest tests/test_api.py -k 'alert'`，期望告警策略无回归。

## T3: 为随机短周期时间添加失败测试

**文件：** `backend/tests/test_api.py`

**依赖：** 无（可与 T1 并行编写，但实现前统一执行）

**步骤：**
1. 增加 5 分钟短周期计划的时间计算测试，注入随机值 1、300 及中间值，验证间隔边界和基准时间。
2. 验证连续多轮使用不同随机值时不恒定为 300 秒；验证大于 5 分钟的计划仍按原分钟间隔。
3. 验证成功、失败、超时恢复和 stale lock 恢复路径均写入合法 `next_run_at`，且读取已保存时间不会重新随机。
4. 覆盖运行窗口、禁用、暂停、并发槽位和锁占用时的既有保护行为。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k 'next_scheduled_run_at or scheduled_test_tick or recover_stale or timeout or available_slots'`，新增随机行为测试应先失败。

## T4: 实现可测试的随机调度计算

**文件：** `backend/app/services.py`

**依赖：** T3

**步骤：**
1. 为短周期计划引入 1–300 秒随机延迟，并允许测试注入固定值或生成器；生产路径使用标准库随机源。
2. 将随机延迟应用在当前轮调度基准上，同时保留现有 UTC 转换和运行窗口边界处理。
3. 保持大于 5 分钟的计划使用原有 `interval_minutes` 逻辑，避免日/小时计划变成高频任务。
4. 检查 claim、完成、异常、超时和 stale lock 恢复调用同一计算路径，并保证 `next_run_at` 在提交后持久化。
5. 保持全局暂停、enabled、锁、并发和 due 查询逻辑不变。

**验证：** 重跑 T3 命令及完整相关调度测试，期望全部通过；检查数据库中的 `next_run_at` 与注入随机秒数一致。

## T5: 前端展示和跨层回归

**文件：** `frontend/src/signatureInterop.ts`、`frontend/src/signatureInterop.test.ts`（仅在 T1/T2 发现缺口时修改）

**依赖：** T2

**步骤：**
1. 确认普通运营失败使用已有“无法判定/请求失败/资源暂不可用/额度不足”文案，不从错误文本自行推导 Signature 异常。
2. 若存在前端误判，补充最小展示修复和对应测试；否则保持文件不变。
3. 检查自动巡检日志、报告详情和 Signature 互通详情仍显示错误阶段、状态和脱敏请求信息。

**验证：** `cd frontend && npm test` 与 `cd frontend && npm run build`，期望全部通过。

## T6: 集成验收与文档记录

**文件：** `docs/superpowers/specs/2026-08-11-signature-alert-random-patrol-interval/checklist.md`

**依赖：** T1、T2、T3、T4、T5

**步骤：**
1. 运行后端 Signature、调度和告警相关测试，再运行后端完整测试。
2. 运行前端完整测试和构建。
3. 检查 `git diff --check`、`git status --short`，确认用户已有 dirty 文件未被覆盖。
4. 按实际命令输出填写 checklist，通过项打勾，未执行的浏览器/线上行为明确列为未验证。

**验证：**

- `cd backend && python3 -m pytest tests/test_api.py -k 'signature or scheduled or alert'`：相关测试通过。
- `cd backend && python3 -m pytest`：后端全量测试通过。
- `cd frontend && npm test`：前端全量测试通过。
- `cd frontend && npm run build`：TypeScript/Vite 构建通过。
- `git diff --check`：无格式错误。

## 执行顺序

```text
T1 + T3 -> T2 -> T4 -> T5 -> T6
```

T1 与 T3 先分别建立 Signature 和调度的失败测试；T2、T4 在对应 RED 证据后实现；T5 仅在确有前端缺口时修改；T6 统一完成跨层验收。
