# 自动巡检分页与全局异常置顶 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/app/schemas.py` | 定义全局异常摘要及分页响应字段 |
| 修改 | `backend/app/main.py` | 统一查询最新报告、分类真实性异常并修正越界响应语义 |
| 修改 | `backend/tests/test_api.py` | 覆盖跨页摘要、渠道范围、运营故障和越界页 |
| 修改 | `frontend/src/types.ts` | 定义异常摘要前端类型 |
| 修改 | `frontend/src/runsUtils.ts` | 提供响应匹配与页码校正纯逻辑 |
| 修改 | `frontend/src/runsUtils.test.ts` | 覆盖旧响应竞态、有效页和真实越界 |
| 修改 | `frontend/src/pages/Runs.tsx` | 使用目标页控制分页并展示顶部异常摘要 |
| 修改 | `frontend/e2e/runs-pagination.mjs` | 用 60+ 条记录验证第 6 页、筛选、轮询和异常入口 |
| 新建 | `docs/superpowers/specs/2026-08-13-patrol-pagination-global-anomaly-summary/checklist.md` | 最终验收清单（下一阶段生成） |

## T1: 建立后端异常摘要失败测试

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**
1. 创建至少 60 个分布在多个分页和两个渠道的巡检任务，每个任务写入最新报告。
2. 在不同分页分别放置结构化 Kiro 标签、历史明确 Kiro 身份自报、结构化 Signature 明确拒绝和历史 HTTP 400 明确拒绝。
3. 同时放置 `signature_ok=null`、权限禁止、模型无权、配额、超时、HTTP 5xx 及只讨论关键词的反例。
4. 断言第 1 页响应中的两类摘要统计全部分页命中，但反例均不计数。
5. 断言每类入口按最新时间稳定排序、数量有固定上限、包含任务和脱敏诊断字段。
6. 切换 `channel_id`，断言总数和入口只属于该渠道。
7. 切换 `errors_only`，断言日志集合改变但异常摘要保持当前渠道全局口径。

**验证：** 在 `backend` 运行 `python3 -m pytest tests/test_api.py -k "patrol and anomaly_summary" -q`，期望实现前因响应缺少摘要而失败。

## T2: 建立后端越界分页失败测试

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**
1. 创建总数可覆盖 6 页的巡检任务，断言请求第 6 页返回真实总数、`page=6` 和正确记录。
2. 请求超过末页的页码，断言响应保留真实总数和请求页，`items` 为空，不返回伪造的 `total=0`。
3. 对 `errors_only=true` 重复有效页和越界页测试，确保筛选后的真实总数不丢失。
4. 覆盖空数据范围，确认只有真实空范围才返回 `total=0`。

**验证：** 在 `backend` 运行 `python3 -m pytest tests/test_api.py -k "patrol and page" -q`，期望当前越界分支因返回错误总数而失败。

## T3: 定义异常摘要响应模型

**文件：** `backend/app/schemas.py`

**依赖：** T1

**步骤：**
1. 增加异常入口模型，包含任务、渠道、时间、少量 Request ID、HTTP 状态和阶段。
2. 增加异常分组模型，包含总数、固定大小入口和截断标记。
3. 增加 Kiro 与 Signature 两类异常摘要模型。
4. 在巡检分页响应中增加带安全默认值的 `anomaly_summary`，保持旧调用方兼容。

**验证：** 在 `backend` 运行 `python3 -m pytest tests/test_api.py -k "patrol and anomaly_summary" -q`，期望 Schema 校验通过，分类测试仍因路由未实现而失败。

## T4: 实现后端明确异常分类

**文件：** `backend/app/main.py`

**依赖：** T1、T3

**步骤：**
1. 提取结构化标签、Signature 三态、HTTP 状态、阶段、错误文本和 Request ID 的安全读取逻辑。
2. 实现 Kiro 判定：结构化标签优先，历史数据只接受明确身份自报语境。
3. 实现 Signature 判定：明确结构化拒绝，或 HTTP 400 且精确命中 `Invalid signature in thinking block`。
4. 显式排除 `signature_ok=null` 及权限、账号、模型、配额、网络、超时、HTTP 5xx 和临时不可用。
5. 只返回脱敏的少量 Request ID 和诊断字段，不返回完整响应或 Signature。
6. 为分类逻辑复用现有真实性异常边界，避免错误统计与摘要口径分叉。

**验证：** 在 `backend` 运行 `python3 -m pytest tests/test_api.py -k "patrol and anomaly_summary" -q`，期望结构化命中、历史兼容和所有反例通过。

## T5: 重构巡检分页汇总与越界响应

**文件：** `backend/app/main.py`

**依赖：** T2、T4

**步骤：**
1. 建立不受 `errors_only` 影响、但受 `channel_id` 约束的基础巡检范围。
2. 为范围内每个任务选择最新报告，统一用于错误计数和两类异常汇总。
3. 计算固定上限的异常入口、总数和截断状态。
4. 对日志应用 `errors_only` 后计算真实 `total`、`deletable_count` 和当前页切片。
5. 即使当前请求页没有记录，也返回过滤范围的真实总数、请求页和全局异常摘要。
6. 保持当前页日志为轻量摘要，不序列化完整 Result、Report 或原始证据。

**验证：** 在 `backend` 运行 `python3 -m pytest tests/test_api.py -k "patrol_query or patrol_delete or patrol.*page or patrol.*anomaly" -q`，期望相关分页、删除范围和摘要测试全部通过。

## T6: 建立前端分页竞态失败测试

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**
1. 构造用户已切换到第 6 页、但旧第 1 页响应随后到达的场景，断言保持第 6 页。
2. 构造第 6 页有效响应，断言保持第 6 页。
3. 构造删除后第 6 页真实越界且最后有效页为第 5 页，断言校正到第 5 页。
4. 构造加载中、响应页不匹配、总数为零和不同每页条数的边界场景。
5. 断言有效后页绝不因旧响应或短暂空数据跳回第 1 页。

**验证：** 在 `frontend` 运行 `./node_modules/.bin/vitest run src/runsUtils.test.ts`，期望实现前因缺少页码校正逻辑而失败。

## T7: 实现页码响应匹配与校正逻辑

**文件：** `frontend/src/runsUtils.ts`、`frontend/src/runsUtils.test.ts`

**依赖：** T6

**步骤：**
1. 增加纯函数，输入目标页、响应页、真实总数、每页条数和完成状态。
2. 对加载中或响应页不匹配场景返回目标页。
3. 对有效目标页返回目标页。
4. 仅对当前响应确认的越界页返回最后一个有效页；真实空范围返回第 1 页。
5. 运行新增测试并确认所有现有分页工具测试无回归。

**验证：** 在 `frontend` 运行 `./node_modules/.bin/vitest run src/runsUtils.test.ts`，期望全部通过。

## T8: 扩展前端异常摘要类型

**文件：** `frontend/src/types.ts`

**依赖：** T3

**步骤：**
1. 定义异常入口、异常分组和全局异常摘要类型。
2. 在 `PatrolRunList` 中增加 `anomaly_summary`。
3. 保持现有分页、删除计数和日志摘要字段不变。

**验证：** 在 `frontend` 运行 `./node_modules/.bin/tsc -b`，期望类型检查指出页面/测试模拟响应尚需补充新字段，但类型本身无错误。

## T9: 修复页面受控分页状态

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T5、T7、T8

**步骤：**
1. 分页器 `current` 直接使用本地目标页，不使用查询响应页替代。
2. 查询参数继续由目标页和每页条数驱动。
3. 页码校正 effect 只处理与当前目标页匹配的已完成响应。
4. 数字页、上一页、下一页直接设置目标页；只有每页条数变化时显式回到第 1 页。
5. 渠道筛选变化保持显式回到第 1 页；“只看错误”按现有行为回到第 1 页。
6. 删除或刷新导致越界时进入最后有效页，不把普通有效页重置为 1。

**验证：** 在 `frontend` 运行 `./node_modules/.bin/vitest run src/runsUtils.test.ts && ./node_modules/.bin/tsc -b`，期望分页逻辑与类型检查通过。

## T10: 实现顶部全局异常摘要 UI

**文件：** `frontend/src/pages/Runs.tsx`

**依赖：** T5、T8

**步骤：**
1. 在自动巡检日志表格上方增加独立、紧凑的异常摘要区域。
2. Kiro 和 Signature 使用两条独立错误 Alert，分别展示跨页总数。
3. 展示后端返回的有限任务入口，链接到对应 `/runs/{run_id}`；有截断时显示剩余数量。
4. 没有命中时不渲染对应 Alert；两类都没有时不保留空白区域。
5. 渠道筛选变化时直接使用同一分页响应的新摘要；“只看错误”切换后摘要内容保持不变。
6. 不在顶部展示完整错误正文、完整 Signature 或运营故障。

**验证：** 在 `frontend` 运行 `./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build`，期望编译和生产构建成功。

## T11: 扩展真实浏览器分页与异常测试

**文件：** `frontend/e2e/runs-pagination.mjs`

**依赖：** T9、T10

**步骤：**
1. 将模拟巡检日志扩展到至少 65 条，确保第 6 页和末页均存在。
2. 在不同分页和渠道放置 Kiro、明确 Signature、运营错误及关键词反例，并在分页响应返回全局摘要。
3. 模拟第 1 页旧响应延迟到第 6 页点击之后到达，验证分页器仍停在第 6 页。
4. 点击第 6 页、上一页、下一页、第 1 页和末页，逐次断言请求参数、选中页码和可见记录一致。
5. 等待一次模拟轮询，断言第 6 页不跳回第 1 页。
6. 切换渠道，断言页码回 1 且异常总数缩小；切换“只看错误”，断言摘要总数不变。
7. 验证两类 Alert 分开显示，运营错误和关键词反例不计数。
8. 点击异常任务入口，断言导航到对应详情并能触发详情数据请求。
9. 模拟删除使当前页越界，断言进入最后有效页。
10. 统计完整结果请求，断言列表加载和分页不会为全部日志逐条请求详情。

**验证：** 先在 `frontend` 运行 `./node_modules/.bin/vite build`，再运行 `node e2e/runs-pagination.mjs`，期望脚本退出码为 0 且所有分页、摘要和请求数断言通过。

## T12: 完整回归与差异审查

**文件：** 所有本需求文件

**依赖：** T5、T9、T10、T11

**步骤：**
1. 运行后端全量测试并确认没有改变调度、删除保护和普通任务接口。
2. 运行前端全量测试、TypeScript 编译和生产构建。
3. 运行真实浏览器分页脚本。
4. 运行差异格式检查。
5. 检查 Git 差异，只包含本需求文件及同文件中明确属于本需求的代码块；保留现有未提交删除保护改动。
6. 对照批准的 spec 和 plan 完成代码审查，重点检查旧响应竞态、跨页统计、运营故障误报和详情请求数量。

**验证：** 运行以下命令，期望全部退出码为 0：

```bash
cd backend && python3 -m pytest
cd ../frontend && ./node_modules/.bin/vitest run
./node_modules/.bin/tsc -b
./node_modules/.bin/vite build
node e2e/runs-pagination.mjs
cd .. && git diff --check
```

## 执行顺序

```text
T1 -> T3 -> T4 -> T5
T2 -----------^
T6 -> T7 -> T9
T3 -> T8 -> T9 -> T11
T5 -> T10 -> T11
T11 -> T12
```
