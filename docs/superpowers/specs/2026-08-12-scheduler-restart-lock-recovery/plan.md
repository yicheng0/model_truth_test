# 自动巡检重启锁恢复 Plan

## 架构概览

本方案沿用现有单实例调度模型，在后端启动恢复和每轮调度恢复两个入口共用一套“旧实例中断恢复”逻辑：

1. 应用启动完成数据库初始化后，先执行启动恢复，再启动调度循环。
2. 启动恢复查询所有启用且处于 `queued`/`running` 的计划，筛选 `locked_by` 非当前实例的记录；不依赖 `locked_until` 是否已经到期。
3. 对每个遗留计划，在同一数据库事务中恢复计划、关联巡检作业、运行尝试和 pending/running 运行记录，释放锁并设置下一次执行时间。
4. 调度循环每轮仍执行恢复检查，作为启动恢复失败或运行期间异常的兜底；当前实例的活跃锁继续由现有续租逻辑保护。
5. 健康接口继续使用现有统计字段，但恢复后的记录不再计入排队/运行和逾期统计。

## 核心数据结构

### SchedulerRecoveryResult

- `recovered_count`: 被恢复的计划、作业、尝试和运行记录总变更数，用于现有日志和健康信息。
- `interrupted_schedule_count`: 被判定为旧实例遗留的计划数量。
- `error`: 失败时的脱敏错误文本；成功为 `None`。

不新增数据库表或字段。中断原因使用现有 `last_error`、`last_error`/`error_message` 和 `Run.status` 字段记录；运行记录使用现有 `interrupted` 终态，计划/作业/尝试使用现有 `failed` 终态以保持当前状态集合兼容。

## 核心接口

### 旧实例恢复检查

输入：数据库会话、当前时间、当前调度实例 ID（默认使用进程实例 ID）。

行为：

- 查询状态为 `queued` 或 `running` 且 `locked_by` 非空、不同于当前实例的计划。
- 在事务内锁定并重新读取计划，避免处理过程中覆盖当前实例刚获得的锁。
- 找到该计划最近的 queued/running `PatrolJob`，结束作业及其 running `PatrolJobAttempt`，写入统一的脱敏中断原因。
- 根据 `scheduled.last_run_id` 以及作业/尝试上的 `run_id` 集合，结束所有 pending/running `Run`，设置 `status=interrupted` 和 `finished_at`。
- 计划设置 `last_status=failed`、`last_error`、`last_finished_at`，清空 `locked_by`/`locked_until`，启用时计算新的 `next_run_at`。
- 提交一次事务；任一异常整体回滚并向调用方抛出，让调度循环记录错误并重试。

返回：`SchedulerRecoveryResult` 或等价的变更计数。

### 现有启动生命周期入口

数据库种子初始化后调用旧实例恢复检查；仅在恢复成功后记录恢复数量，失败时记录脱敏异常但继续启动应用和监督调度循环。

### 现有调度 tick 入口

每轮派发前调用相同恢复检查。调用失败时回滚当前会话、记录异常并继续本轮剩余心跳流程；不得让异常退出调度循环。

## 模块设计

### `backend/app/services.py` 调度恢复模块

**职责：** 集中实现旧实例识别、关联记录收敛、幂等判断和事务提交。

**对外接口：** 保留现有 `recover_stale_scheduled_tests` 调用契约；扩展其恢复范围，必要时增加私有辅助函数处理“按计划收集关联 run”和“结束 pending/running run”。保留现有已过期锁与超时尝试恢复逻辑。

**依赖：** SQLAlchemy 会话和模型、现有时间/锁工具、脱敏工具、下一次执行时间计算。

### `backend/app/main.py` 生命周期模块

**职责：** 保证启动恢复在调度任务创建前执行，并在恢复异常时保持服务可启动。

**对外接口：** 不新增 HTTP 路由；继续由应用生命周期调用恢复函数。

### `backend/tests/test_api.py` 调度恢复测试

**职责：** 覆盖旧实例未来锁、当前实例锁、关联作业/尝试/run 收敛、幂等性和异常回滚。

**对外接口：** 使用现有测试数据库和服务函数/健康接口，不改变生产数据。

## 模块交互

```text
应用启动
  -> init_db / seed
  -> 旧实例恢复检查
       -> 计划 queued/running + locked_by != 当前实例
       -> 关联 PatrolJob / PatrolJobAttempt / Run 收敛
       -> 释放计划锁 + 计算 next_run_at
  -> 启动被监督的调度循环

调度循环每轮
  -> 续租当前实例活跃锁
  -> 旧实例恢复检查（失败则记录并继续）
  -> 查询到期计划并 claim
  -> 创建 PatrolJob
  -> 执行巡检并按现有流程完成/失败
```

## 文件组织

```text
backend/app/services.py       # 扩展旧实例恢复和关联记录收敛
backend/app/main.py           # 保持启动调用顺序并记录恢复异常
backend/tests/test_api.py     # 新增启动恢复、边界、幂等和回滚测试
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 旧实例判定 | `locked_by != SCHEDULER_INSTANCE_ID` 且计划仍 queued/running | 直接对应本次单实例重启事故，不受未来锁到期时间影响 |
| 当前实例保护 | 仅恢复不同实例 ID；先重新读取计划再更新 | 防止新实例活跃任务被误回收 |
| Run 终态 | `interrupted` | 现有运行模型已支持该终态，能准确区分部署中断与业务失败 |
| 计划/作业/尝试终态 | `failed` + 统一脱敏错误 | 兼容现有调度状态和前端枚举，避免扩大状态机范围 |
| 事务边界 | 每个恢复批次一个事务，异常整体回滚 | 保证计划及其关联记录不出现部分收敛 |
| 幂等性 | 只处理 queued/running 且非当前实例的计划；只结束 pending/running 关联记录 | 重复调用不会重复修改终态或创建新作业 |
| 多实例部署 | 本次不实现存活租约；部署前保持单 backend 实例 | 避免把未解决的分布式所有权问题伪装成已解决 |
| 兼容性 | 不新增迁移、队列或基础设施 | 保持 SQLite 和 PostgreSQL 双模式及现有 MVP 范围 |
