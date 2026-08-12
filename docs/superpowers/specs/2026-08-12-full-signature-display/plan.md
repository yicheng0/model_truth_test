# Signature 完整展示 Plan

## 架构概览

本次修复保留现有 Signature 检测链路和页面结构，只调整后端生成脱敏证据的策略：

```text
Source / Relay 请求响应
        ↓
Signature 证据脱敏
        ├── 原始证据模式：保留完整 signature，继续脱敏认证秘密并压缩 thinking 正文
        └── 摘要模式：signature 仍只保留短前缀
        ↓
现有 Result JSON 持久化与 API 序列化
        ↓
现有前端 <pre> 区域换行、滚动、选择或复制
```

不新增数据库字段和迁移。新记录通过现有 `request_logs` 中的 `request_excerpt`、`response_excerpt` 保存完整 Signature；已截断的历史字符串原样返回。

## 核心数据结构

### Signature 原始证据

沿用现有请求日志结构：

| 字段 | 内容 | 展示策略 |
|---|---|---|
| `request_excerpt` | Source 或 Relay 的脱敏请求 JSON | 完整保留其中的 `signature` |
| `response_excerpt` | Source、Relay 或身份请求的脱敏响应 JSON | 完整保留其中的 `signature` |

字段名为兼容历史数据保持不变。尽管名称仍为 excerpt，只有 thinking 正文和非证据性超长内容允许按既有规则压缩；Signature 本身不得截断。

### Signature 摘要证据

沿用现有字段：

| 字段 | 内容 | 展示策略 |
|---|---|---|
| `signature_prefixes` | 每个 thinking block 的 Signature 前缀 | 保持最多 50 个字符 |
| `relay_raw_excerpt` | Relay 响应摘要 | 保持紧凑和总长度限制 |
| `steps[].excerpt` | 检测步骤摘要 | 保持短文本 |

## 核心接口

### Signature 证据脱敏

后端内部证据处理支持两种明确用途：

- 原始证据用途：保留完整 Signature；递归脱敏 API Key、Authorization、Token、Password 等认证秘密；thinking 正文继续使用既有长度控制。
- 摘要用途：Signature 仍转换为 50 字符前缀和省略标识，防止摘要区出现长文本。

两种用途不改变公开 API 路由和请求参数。

### Signature 请求日志生成

请求日志生成继续输出字符串形式的脱敏 JSON，但原始证据模式不得再对整个结果执行会截断 Signature 的固定长度裁剪。由于 thinking 正文仍受长度控制，日志体积保持有界；完整 Signature 作为协议证据保留。

### 结果读取接口

现有 Signature 检测接口、运行原始结果接口和报告证据结构保持兼容。通用结果序列化继续执行认证秘密脱敏，不对 Signature 再做二次裁剪。

## 模块设计

### 后端 Signature 证据处理

**职责：** 区分原始证据和摘要证据；完整保留原始证据中的 Signature，并继续保护认证凭证。

**对外接口：** 不新增公开接口；只调整现有 Signature 证据构造结果。

**依赖：** 现有通用文本与秘密脱敏能力。

**覆盖需求：** F1、F4、F5、N1、N2、N4。

### 后端请求日志与摘要构造

**职责：** 请求日志使用原始证据策略，摘要字段继续使用紧凑策略。

**对外接口：** 保持 `request_logs`、`signature_prefixes`、`relay_raw_excerpt` 和 `steps` 的既有字段形状。

**依赖：** Signature 证据处理模块。

**覆盖需求：** F1、F3、F5、N1、N2。

### 前端原始证据展示

**职责：** 复用现有 `<pre>` 展示完整字符串，通过已有 `pre-wrap`、自动断词和滚动样式支持长 Signature 查看、选择与复制。

**对外接口：** 不新增组件属性，不改变页面工作流。

**依赖：** 后端返回的现有请求日志字段。

**覆盖需求：** F2、F3、N3。

### 自动化回归测试

**职责：** 使用超过 50 字符的 Signature 验证原始证据完整、摘要仍短、认证秘密仍脱敏，并覆盖 Signature 判断语义不变。

**依赖：** 后端 Signature 检测服务与既有 API 测试夹具。

**覆盖需求：** F1、F3、F4、F5、N4。

## 模块交互

1. Signature 检测取得 Source 响应及 Relay 请求/响应。
2. 步骤摘要调用紧凑证据策略，继续输出 Signature 前缀。
3. `request_logs` 调用原始证据策略，递归保留完整 Signature并脱敏认证秘密。
4. 检测结果通过现有 JSON 字段持久化，无数据库迁移。
5. API 使用现有响应模型返回证据；通用秘密脱敏保持启用。
6. 前端展开请求日志后，现有代码块完整渲染字符串；长内容在容器内换行并滚动。

## 文件组织

```text
backend/
├── app/services.py       # 区分完整 Signature 原始证据与短前缀摘要
└── tests/test_api.py     # 完整展示、摘要截断和凭证脱敏回归测试

frontend/
├── src/pages/SignatureInterop.tsx  # 复核并沿用现有原始证据展示
├── src/pages/ReportDetailPage.tsx  # 复核并沿用现有巡检日志展开展示
└── src/styles.css                    # 复核现有长文本换行与滚动规则；仅在验证失败时做最小调整
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 完整值保存位置 | 沿用 `request_logs` 的请求/响应证据 | 已有持久化、API 和 UI 链路，避免新增字段与迁移 |
| 摘要展示 | 保留 `signature_prefixes` 的 50 字符限制 | 满足列表和报告概览的可扫描性 |
| 脱敏边界 | Signature 视为协议证据完整保留，认证凭证继续脱敏 | 修复证据缺失，同时不放宽 API Key 等安全规则 |
| 日志总长度 | 原始证据不再用固定总长度裁掉 Signature；thinking 正文仍压缩 | 保证 Signature 完整，同时控制主要体积来源 |
| 前端实现 | 优先复用现有代码块和 CSS | 现有样式已支持换行、断词、滚动和文本选择 |
| 历史数据 | 原样展示，不推断缺失后缀 | 被截断信息不可恢复，伪造会破坏证据可信度 |
| 数据库 | 不迁移 | 现有 JSON 字段能容纳完整证据 |

## 需求映射

| 需求 | 实现归属 |
|---|---|
| F1 | 原始证据脱敏、请求日志生成 |
| F2 | 现有前端代码块与长文本样式 |
| F3 | 摘要证据策略 |
| F4 | 通用秘密脱敏回归保护 |
| F5 | 不迁移历史数据，只影响新证据 |
