# 渠道总览逆向异常记录 Plan

## 架构概览

在现有前端渠道总览数据流中增加一个纯函数归一层：先从最新报告的 `labels` 中筛选允许在总览展示的逆向异常标签，再由 `Runs.tsx` 的“异常标签”列渲染筛选结果。报告获取、最新报告选择、评分计算和后端持久化保持不变。

数据流：

```text
/api/reports/summary -> buildChannelResultOverview -> extractOverviewAnomalyLabels -> Runs.tsx 异常标签列
```

## 核心数据结构

### 总览异常标签

- 输入：最新报告的字符串标签数组。
- 输出：稳定顺序、去重后的异常标签数组。
- 允许展示的标签：`kiro_identity_leak`、`signature_interop_failed`。
- 过滤规则：忽略巡检通过、兼容、Signature 通过及其他非本次范围标签；运行失败被后端归一为其他 operational 标签时，不补写 Signature 失败。

## 核心接口

### `extractOverviewAnomalyLabels`

**用途：** 将报告标签转换为渠道总览专用的异常标签列表。

**输入：** `string[] | null | undefined`。

**输出：** `string[]`，最多包含两类异常，按固定业务顺序输出并去重。

**行为：** 不修改输入数组；未知标签和正常标签被忽略；空输入返回空数组。

## 模块设计

### 总览数据工具模块

**职责：** 提供总览所需的标签筛选逻辑，集中维护“总览只显示逆向异常”的白名单和顺序。

**对外接口：** `extractOverviewAnomalyLabels`。

**依赖：** 无新增依赖，复用 TypeScript 标准数组操作。

### 渠道总览页面

**职责：** 在“异常标签”列调用归一函数；有筛选结果时渲染红色标签，无结果时继续显示 `-`。

**依赖：** 现有 `buildChannelResultOverview` 返回的 `latestReport.labels`。

### 前端测试

**职责：** 覆盖 Kiro 单异常、Signature 单异常、正常标签过滤、组合异常去重、空输入和未知标签。

## 模块交互

1. 页面查询渠道、报告摘要和任务列表。
2. 页面按现有逻辑确定每个渠道的最新报告。
3. 异常标签列将最新报告标签交给归一函数。
4. 归一函数仅返回 Kiro 身份泄漏和 Signature 互验失败。
5. 页面展示返回标签；返回空数组时展示 `-`。

## 文件组织

```text
frontend/src/
├── runsUtils.ts          # 新增总览异常标签归一函数
├── runsUtils.test.ts     # 新增筛选、去重和空态测试
└── pages/Runs.tsx        # 异常标签列使用归一结果
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 异常识别来源 | 使用报告已持久化的结构化 `labels` | 不重新解析原始响应，避免前端猜测和敏感数据暴露 |
| 展示范围 | 仅白名单 `kiro_identity_leak`、`signature_interop_failed` | 满足本次“只记录异常”且不误把其他正常/运行状态展示为逆向异常 |
| 运行失败处理 | 依赖后端已有 operational 标签归一，不将其强制改成 Signature 失败 | 区分互验不通过与服务不可用，避免错误归因 |
| 实现位置 | 前端纯函数 + 单列调用 | 不改 API、数据库和评分，兼容既有报告与页面 |
| 标签顺序 | Kiro 身份泄漏在前，Signature 互验失败在后 | 多异常展示稳定，便于扫描和测试 |
