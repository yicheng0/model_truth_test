# Signature 运营故障误报抑制 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `frontend/src/runsUtils.ts` | 保留 Signature 三态并集中计算展示状态 |
| 修改 | `frontend/src/runsUtils.test.ts` | 覆盖运营故障、明确拒绝和历史数据归一化 |
| 修改 | `frontend/src/pages/RunDetail.tsx` | 按三态条件渲染 Signature 与 AI 复核卡片 |
| 新建或修改 | `frontend/src/pages/RunDetail.test.tsx` | 覆盖详情页可见提示和隐藏行为 |

## T1: 建立三态归一化失败测试

**文件：** `frontend/src/runsUtils.test.ts`

**依赖：** 无

**步骤：**
1. 构造 `status=fail`、`signature_ok=null` 的 Source Identity HTTP 500 `Upstream access forbidden` 证据。
2. 构造 `status=fail`、`signature_ok=null` 的 Relay HTTP 400 `models is not allowed for this account` 证据。
3. 断言归一化结果保留 `signatureOk=null`，运营错误文本、阶段、状态码和请求日志不丢失。
4. 构造 `signature_ok=false` 且明确 `Invalid signature in thinking block`，断言归一化结果保留明确拒绝。
5. 构造缺少 `signature_ok` 的历史运营故障，断言展示状态保守归为未知。

**验证：** 运行 `npm test -- runsUtils.test.ts`，期望实现前因 `signatureOk` 字段缺失或展示状态错误而失败。

## T2: 实现 Signature 三态归一化与纯函数判断

**文件：** `frontend/src/runsUtils.ts`

**依赖：** T1

**步骤：**
1. 扩展 `PatrolSignatureEvidence`，增加 `signatureOk: boolean | null`。
2. 在 Signature 归一化时读取 `signature_ok`，保持 `true/false/null`；缺失时保持未知。
3. 复用现有明确 Signature 错误正则和运营故障识别逻辑，新增可测试的展示状态计算函数。
4. 明确拒绝仅由 `signatureOk=false` 且错误文本命中 `Invalid signature in thinking block` 产生。
5. 权限禁止、账号/模型无权访问、配额、网络、超时、5xx、临时不可用和历史缺字段运营错误归为未知。
6. 保留 Kiro、`signature_interop_failed` 等真实异常标签的独立判断。

**验证：** 运行 `npm test -- runsUtils.test.ts`，期望 T1 测试全部通过，现有错误筛选和巡检证据测试无回归。

## T3: 建立详情页展示失败测试

**文件：** `frontend/src/pages/RunDetail.test.tsx` 或现有等价组件测试文件

**依赖：** T2

**步骤：**
1. 渲染 Source Identity `Upstream access forbidden` 场景，断言不出现红色“Signature 失败”和 AI 疑难复核标题，显示中性“未完成验证/无法判定”。
2. 渲染 Relay `models is not allowed for this account` 场景，断言同样不出现顶部误报卡片。
3. 断言运营错误在请求日志或探针详情展开后仍可查看。
4. 渲染明确 `Invalid signature in thinking block`，断言红色 Signature 失败仍出现。
5. 渲染 Kiro + Signature 运营故障组合，断言身份异常仍显示，但 Signature 失败不显示。

**验证：** 运行对应详情组件测试，期望实现前因无条件 `status=fail` 渲染而失败。

## T4: 修复详情页顶部状态和卡片条件

**文件：** `frontend/src/pages/RunDetail.tsx`

**依赖：** T3

**步骤：**
1. 使用集中展示状态函数计算 Signature 通过、明确拒绝和未知状态。
2. 顶部 Signature 标签对未知状态显示中性文案和颜色。
3. 红色 Signature Alert 仅在明确拒绝时渲染。
4. 纯运营故障场景隐藏 AI 疑难复核卡片；存在 Kiro 或真实协议异常时保留。
5. 不修改请求日志和探针详情组件，确保诊断证据仍可主动查看。

**验证：** 运行详情组件测试，期望所有新增场景通过。

## T5: 前端完整验证

**文件：** 无新增文件

**依赖：** T4

**步骤：**
1. 运行 `runsUtils` 和详情页定向测试。
2. 运行前端完整测试套件。
3. 运行 TypeScript/生产构建。
4. 执行差异格式检查，并确认没有修改后端执行和分类逻辑。
5. 检查暂存范围，只包含本规格目录和本次前端修复文件；保留用户已有未提交修改。

**验证：** 在 `frontend` 目录运行 `npm test` 与 `npm run build`，期望退出码均为 0；仓库根目录运行 `git diff --check`，期望无错误。

## T6: 浏览器与生产验收

**文件：** 无新增文件

**依赖：** T5、checklist 批准后完成实现

**步骤：**
1. 本地打开两类运营故障详情，确认顶部不出现红色 Signature 失败和 AI 真伪复核卡片。
2. 展开请求日志，确认错误正文、阶段、HTTP 状态和 Request ID 仍存在。
3. 打开明确 Signature 拒绝详情，确认红色提示仍存在。
4. 提交并推送到 `main` 后部署前端/服务容器。
5. 在生产真实详情页复查两张截图对应场景和明确拒绝边界。

**验证：** 自动化测试、构建、本地浏览器和生产真实页面四类证据全部通过后，才报告修复完成。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6
```
