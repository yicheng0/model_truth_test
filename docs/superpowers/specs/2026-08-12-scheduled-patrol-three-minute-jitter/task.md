# 自动巡检三分钟窗口随机调度 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/app/services.py` | 分离原周期与三分钟派发抖动，创建独立延迟启动任务 |
| 修改 | `backend/tests/test_api.py` | 覆盖窗口边界、精确启动、去重、恢复和长周期兼容 |
| 修改 | `docs/superpowers/specs/2026-08-12-scheduled-patrol-three-minute-jitter/checklist.md` | 记录最终验收结果 |
| 确认 | `frontend/src/pages/Runs.tsx` | 保持真实创建/开始/结束时间展示，不做前端掩盖 |

## T1: 建立调度窗口失败测试

**文件：** `backend/tests/test_api.py`
**依赖：** 无
**步骤：**
1. 为三分钟派发窗口增加随机秒数边界测试，覆盖 1 秒、180 秒和越界值。
2. 修改现有五分钟随机周期测试，先验证原配置周期不再被随机改写。
3. 增加两个同时到期计划的独立 `due_at` 测试，以及同一计划重复 tick 的去重测试。
4. 增加 queued 任务延迟到 `due_at` 后才执行的异步测试。
5. 运行聚焦后端测试，确认新增断言在实现更新前失败。

**验证：** `cd backend && python -m pytest -q tests/test_api.py -k "scheduled_run_at or scheduled_test_tick or scheduled_test_loop"`；新增断言应先失败，失败原因对应当前随机周期/立即启动行为。

## T2: 分离原配置周期与派发抖动

**文件：** `backend/app/services.py`
**依赖：** T1
**步骤：**
1. 保留 `next_scheduled_run_at` 的五分钟及以上原周期和运行窗口逻辑。
2. 增加 180 秒派发窗口和可注入随机秒数的纯计算函数。
3. 创建 PatrolJob 时写入独立 `due_at` 和窗口抖动元数据。
4. 确保同一调度 tick 中不同计划分别取随机偏移，不共享时间值。

**验证：** 运行 T1 聚焦测试；窗口边界和长周期兼容测试通过。

## T3: 接入精确延迟启动与去重

**文件：** `backend/app/services.py`
**依赖：** T2
**步骤：**
1. 将调度循环的跟踪任务从“领取即执行”改为“领取即创建独立延迟协程”。
2. 每个协程精确等待到自身 `due_at`，再调用现有超时执行入口。
3. 等待期间保持计划锁、queued 状态和并发槽位占用，取消/恢复时释放资源。
4. 保留手动立即执行路径绕过抖动但受同一计划锁保护。
5. 确认失败、锁过期和重试仍只推进原周期，不在同一窗口重复创建正式任务。

**验证：** `cd backend && python -m pytest -q tests/test_api.py -k "scheduled_test_loop or scheduled_test_tick or timeout or recover"`；期望异步启动、重复 tick、锁恢复测试通过。

## T4: 完成全量验收

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`、`frontend/src/pages/Runs.tsx`
**依赖：** T3
**步骤：**
1. 运行完整后端测试套件。
2. 运行完整前端测试和生产构建，确认时间展示路径未回归。
3. 运行差异格式检查并审阅工作区，保留用户已有未提交改动。
4. 使用本地任务列表观察同批新巡检的真实开始时间不再被强制相同。

**验证：** `cd backend && python -m pytest -q`、`cd frontend && npm test`、`cd frontend && npm run build`、`git diff --check`；全部成功。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4
```
