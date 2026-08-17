# 飞书仅播报 Signature 异常与检测任务列表移除 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/tests/test_api.py` | 定义 Signature-only 飞书资格、纯 Signature 小时消息、无 Signature 不发送及状态流转行为 |
| 修改 | `backend/app/services.py` | 收紧飞书资格，删除 Kiro 飞书文案，调整小时发送和游标处理 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 验证图二功能不可见、普通任务接口不再请求，并回归巡检日志能力 |
| 修改 | `frontend/src/pages/Runs.tsx` | 移除普通检测任务列表、查询、分组和批量操作，保留创建入口与巡检日志 |
| 新建 | `docs/superpowers/specs/2026-08-17-signature-only-feishu-and-task-list-removal/checklist.md` | 定义最终行为验收项；需在任务文档批准后单独生成与批准 |

## T1: 将 Kiro 飞书资格测试改为策略跳过

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**

1. 将当前 Kiro 飞书资格正例改为反例，断言 `eligible=false`、`kind` 为空、`trigger_labels` 为空，并返回稳定跳过原因。
2. 保留结构化 Kiro 报告证据，证明被跳过的原因是发送策略收紧，而不是测试数据不再构成 Kiro 异常。
3. 将 Kiro 单条飞书文案测试改为断言只得到策略跳过说明，不包含 Kiro 标题、渠道或身份探针 ID。
4. 将 Kiro 告警初始状态参数化用例拆分或调整为 `notification_status=skipped`，并断言站内告警仍被创建。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility_kiro or feishu_alert_text_kiro or alert_notification_initial_status_whitelist" -q`，期望在业务代码修改前至少出现一个与 Kiro 仍被允许发送有关的失败。

## T2: 收紧飞书资格判定并删除 Kiro 文案

**文件：** `backend/app/services.py`

**依赖：** T1

**步骤：**

1. 删除 Kiro 身份探针进入 `eligible=true` 的资格分支。
2. 保留明确 Relay Signature 拒绝的现有严格交集条件和结构化字段提取。
3. 删除 `build_feishu_alert_text` 中的 Kiro 文案分支，使所有非 Signature 判定只返回策略跳过说明。
4. 清理仅供 Kiro 飞书资格使用、且没有其他调用方的内部辅助函数。
5. 确认站内 `report_needs_alert`、报告证据、巡检异常摘要和 Kiro 诊断逻辑未被删除。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu_alert_eligibility or feishu_alert_text or alert_notification_initial_status" -q`，期望 Signature 正例通过、Kiro 被跳过、普通异常仍被跳过且站内告警仍存在。

## T3: 将小时汇总测试改为纯 Signature 消息

**文件：** `backend/tests/test_api.py`

**依赖：** T1

**步骤：**

1. 更新同一小时多渠道用例，使其同时包含 Signature、Kiro 和普通异常，并断言只发送一条消息且 `alert_count=1`。
2. 断言正文包含 Signature 标题、固定错误摘要、Source、Relay、发生时间及双方 Message ID/Request ID。
3. 断言正文不包含 Kiro、巡检数、正常数、真实性异常总数、运营问题、渠道综合情况、最低分和复审链接。
4. 更新历史非白名单用例，断言没有 Signature 时不调用 Webhook、返回跳过状态、推进小时游标，历史告警改为 `skipped` 且发送尝试次数不增加。
5. 将正常巡检、普通重复异常和小时边界用例改为“无 Signature 不发送”，并继续验证左闭右开时间窗及游标推进。
6. 保留 Signature 发送失败用例，断言只增加 Signature 告警的失败次数，普通告警仍为策略跳过。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary" -q`，期望在小时发送实现修改前出现综合统计仍被发送、Kiro 仍被发送或无 Signature 仍调用 Webhook的失败。

## T4: 将小时文案构造器改为 Signature 明细集合

**文件：** `backend/app/services.py`

**依赖：** T2、T3

**步骤：**

1. 调整小时文案构造器输入，使其只接收已脱敏的 Signature 明细集合。
2. 固定输出 `Thinking Signature 异常汇总` 标题、异常条数和各条 Signature 安全文案。
3. 删除巡检报告、正常数、真实性异常数、运营问题、渠道汇总、最低分、复审链接和 Kiro 明细的渲染逻辑。
4. 保证多条 Signature 异常在同一飞书消息内清晰分隔，且不会重新读取原始 Signature 或 thinking 内容。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary_sends_one_message_for_all_channels or feishu_alert_text_signature" -q`，期望正文只包含允许的 Signature 字段，并继续通过脱敏断言。

## T5: 无 Signature 异常时跳过 Webhook并推进游标

**文件：** `backend/app/services.py`

**依赖：** T4

**步骤：**

1. 在小时任务重新判定全部告警后，将 Kiro 和其他非 Signature 告警更新为 `skipped`。
2. 当合格 Signature 告警集合为空时，更新 `last_hourly_summary_at=to_at`，清除小时租约并提交。
3. 返回稳定的“该小时无 Signature 异常”跳过结果，不构造飞书 payload、不调用 Webhook。
4. 当存在 Signature 告警时，只用 Signature 明细构造 payload，并保持现有成功、失败、租约过期和失败释放逻辑。
5. 返回结果中的 `alert_count` 和 `channel_count` 只统计实际发送的 Signature 告警。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "hourly_patrol_summary" -q`，期望小时相关测试全部通过。

## T6: 回归单条发送、手动重发和测试消息

**文件：** `backend/tests/test_api.py`

**依赖：** T2、T5

**步骤：**

1. 增加或更新 Kiro 手动重发测试，断言 Webhook 未调用、状态为 `skipped`、发送尝试次数不增加。
2. 保留历史仅有 `signature_interop_failed` 标签但无明确拒绝正文的重发拦截测试。
3. 保留明确 Signature 拒绝的单条发送与失败重试测试。
4. 保留飞书测试消息绕过巡检资格判定并发送 `哈喽` 的测试。
5. 保留 Signature 正文敏感信息脱敏测试。

**验证：** 运行 `cd backend && python3 -m pytest tests/test_api.py -k "feishu or alert_notification or signature" -q`，期望所有相关用例通过。

## T7: 为图二移除增加页面端到端断言

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** 无

**步骤：**

1. 为 `/api/runs` 普通列表路由增加请求计数，保留现有巡检接口模拟。
2. 页面加载后断言“检测任务列表”、普通任务全选、普通任务批量删除、任务数、最近状态、最近进度和最近任务均不可见。
3. 断言普通 `/api/runs?exclude_patrol=true` 列表请求次数为零。
4. 断言“提取渠道指纹”“真实性对比”和“自动巡检日志”仍可见。
5. 保留现有巡检分页、渠道筛选、只看错误、异常摘要、行展开和删除范围的全部断言。

**验证：** 先运行 `cd frontend && npm run build && npm run test:runs-pagination`，期望在页面实现修改前因图二仍可见或普通任务接口仍被请求而失败。

## T8: 移除普通检测任务列表及页面状态

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T7

**步骤：**

1. 删除普通任务列表的 React Query 请求和轮询。
2. 删除普通任务选择状态、普通任务批量删除 mutation、选择计算、清理 effect 和操作函数。
3. 删除普通任务渠道分组类型、分组函数、首选详情函数、普通任务异常摘要组件和普通任务操作列。
4. 删除图二对应的 Checkbox、删除工具栏、渠道分组 Table 和展开后的普通任务明细 Table。
5. 保留页面顶部紧凑的“提取渠道指纹”“真实性对比”入口。
6. 保留巡检单条删除与取消 mutation；清理其中对已移除普通列表查询缓存的更新和失效操作。
7. 清理不再使用的 `useQueries`、`Checkbox`、`Progress`、普通任务工具函数和相关类型导入，但保留巡检页面仍需要的导入。

**验证：** 运行 `cd frontend && npm run build && npm run test:runs-pagination`，期望 TypeScript 构建通过、图二断言通过，巡检页面端到端用例全部通过。

## T9: 运行后端聚焦回归

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`

**依赖：** T5、T6

**步骤：**

1. 创建独立临时目录和 SQLite 数据库，避免复用仓库测试数据库。
2. 运行飞书资格、告警状态、Signature、Kiro 和小时调度聚焦测试。
3. 查看实际失败输出；若失败来自本次行为变化，修正实现或测试并重新运行。
4. 确认没有真实 Webhook 调用，所有网络发送均由测试替身接管。

**验证：** 运行 `cd backend && patrol_test_tmp=$(mktemp -d) && DATABASE_URL="sqlite:///$patrol_test_tmp/test.db" python3 -m pytest tests/test_api.py -k "feishu or alert_notification or signature_interop or kiro or hourly_patrol_summary" -q`，期望测试全部通过。

## T10: 运行前端完整自动化验证

**文件：** `frontend/src/pages/Runs.tsx`、`frontend/e2e/runs-pagination.mjs`

**依赖：** T8

**步骤：**

1. 运行全部 Vitest 测试，确认巡检证据解析、删除范围和其他页面未回归。
2. 运行生产构建，确认无未使用导入、类型错误或构建错误。
3. 在构建产物上运行巡检页面端到端测试。
4. 查看浏览器控制台和页面错误输出，确认没有未处理异常。

**验证：** 依次运行 `cd frontend && npm test`、`cd frontend && npm run build`、`cd frontend && npm run test:runs-pagination`，期望全部通过。

## T11: 运行后端完整测试

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`

**依赖：** T9

**步骤：**

1. 使用新的临时 SQLite 数据库运行后端完整测试套件。
2. 确认 Mock 模式、普通任务 API、巡检执行、报告和其他飞书功能未回归。
3. 若完整测试发现与本次改动相关的旧综合小时汇总断言，按已批准的 Signature-only 行为更新；不修改无关产品行为。

**验证：** 运行 `cd backend && full_test_tmp=$(mktemp -d) && DATABASE_URL="sqlite:///$full_test_tmp/test.db" python3 -m pytest -q`，期望完整测试全部通过。

## T12: 检查变更范围与验收准备

**文件：** 本任务涉及的全部文件

**依赖：** T10、T11

**步骤：**

1. 运行差异格式检查并查看完整差异。
2. 确认没有数据库迁移、公共 API 删除、日报改动或生成产物变更。
3. 确认现有 `docs/superpowers/specs/2026-08-12-patrol-delete-button-usability/checklist.md` 未被本次编辑。
4. 确认任务范围只包含本规格目录、后端服务与测试、Runs 页面和对应端到端测试。
5. 根据后续批准的 `checklist.md` 逐项执行最终验收，不以测试通过代替行为验收。

**验证：** 运行 `git diff --check`、`git status --short` 和 `git diff -- backend/app/services.py backend/tests/test_api.py frontend/src/pages/Runs.tsx frontend/e2e/runs-pagination.mjs docs/superpowers/specs/2026-08-17-signature-only-feishu-and-task-list-removal`，期望无空白错误、无无关代码改动，并能清晰审查完整任务范围。

## 执行顺序

```text
T1 -> T2
T1 -> T3 -> T4 -> T5
T2 + T5 -> T6 -> T9 -> T11
T7 -> T8 -> T10
T10 + T11 -> T12
```

后端与前端两条实现链可在开发阶段独立推进，但同一文件内的测试和实现必须按上述测试先行顺序执行。
