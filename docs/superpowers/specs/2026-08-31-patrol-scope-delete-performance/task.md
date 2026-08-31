# 自动巡检日志范围删除性能修复 Tasks

## 文件清单

- 修改后端 schema、路由与 API 测试。
- 修改前端类型、API 客户端、Runs 页面与 API 测试。
- 修改巡检分页浏览器回归脚本。
- 新建本需求的 spec、plan、task 和 checklist 文档。

## T1: 建立后端失败测试

**文件：** `backend/tests/test_api.py`

**步骤：**

1. 增加范围删除四种筛选、pending/running 保留、关联清理、计划引用回退和基线冲突测试。
2. 增加 6002 条完整关联数据性能测试，先证明当前接口缺失。

**验证：** `cd backend && PYTHONPATH=. pytest tests/test_api.py -k 'patrol_scope_delete' -v`，实现前因路由不存在而失败。

## T2: 实现共享巡检范围条件

**文件：** `backend/app/main.py`

**依赖：** T1

**步骤：** 抽取渠道、错误和巡检身份条件，由列表与范围删除复用，保证 `deletable_count` 和实际删除口径一致。

**验证：** 运行巡检列表及范围删除目标测试，筛选断言通过。

## T3: 实现范围删除接口

**文件：** `backend/app/schemas.py`、`backend/app/main.py`

**依赖：** T2

**步骤：**

1. 增加请求/响应模型和 `POST /api/runs/patrol/delete-scope`。
2. 查询终态日志 ID，复用现有预检和集合删除，单事务提交。

**验证：** `cd backend && PYTHONPATH=. pytest tests/test_api.py -k 'patrol_scope_delete or run_bulk_delete' -v` 全部通过，6002 条场景小于 5 秒。

## T4: 建立前端失败测试

**文件：** `frontend/src/api.test.ts`、`frontend/e2e/runs-pagination.mjs`

**依赖：** T3

**步骤：** 增加新 API URL、管理员头、筛选请求体和一次请求行为测试，禁止分页收集 ID。

**验证：** `cd frontend && npm test -- --run src/api.test.ts` 及 `npm run test:runs-pagination` 在实现前失败。

## T5: 接入前端范围删除

**文件：** `frontend/src/types.ts`、`frontend/src/api.ts`、`frontend/src/pages/Runs.tsx`

**依赖：** T4

**步骤：** 增加范围删除类型和 API 方法，删除逐页取 ID 循环，范围按钮直接提交当前筛选；保持删除已选、单条删除、提示和查询刷新行为。

**验证：** 前端 API 测试与浏览器回归通过。

## T6: 全量回归与性能验收

**依赖：** T5

**步骤：**

1. 使用全新临时 SQLite 数据库运行后端全套 pytest。
2. 运行前端全套 Vitest、生产构建和巡检浏览器回归。
3. 运行 `git diff --check`。
4. 获得部署授权后再执行线上 6000 条量级计时；未获授权则明确标记待验证。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6
```
