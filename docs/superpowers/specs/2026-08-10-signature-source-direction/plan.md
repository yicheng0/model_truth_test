# Signature 待测源方向修正 Plan

## 架构概览

统一 Signature 检测的业务角色：待测渠道始终是 `Source`，官方可信参考渠道始终是 `Relay`。底层仍按“Source 生成 thinking signature → Relay 复用验证”执行；身份探针改为再次请求 Source，独立判断待测资源是否泄漏 Kiro 身份。

```text
待测 Source
  ├─ 生成 thinking + signature
  ├─ 接受 Source 身份探针
  └─ 承担检测结果、标签和评分归属
          │
          ▼
官方 Relay
  └─ 复用 Source assistant content，验证 Source signature 是否可接受
```

手动页面、自动巡检和 Claude 深度检测共享同一角色语义。历史接口参数名保持兼容，但新结果中的 `source_channel_id` 和 `relay_channel_id` 必须反映真实角色。

## 核心数据结构

### Signature 检测结果

- `ok`：整个检测是否无阻断异常；Signature 失败或 Source 身份明确异常时为 false。
- `signature_ok`：仅表示官方 Relay 是否接受待测 Source 产生的 signature；不受 Source 身份自报影响。
- `classification`：保留 `pass`、`fail`、`not_comparable` 等现有分类。
- `source_channel_id`：待测渠道。
- `relay_channel_id`：官方可信参考渠道。
- `identity_*`：Source 身份探针证据；字段名保持兼容，字段内容改为 Source 响应。
- `labels`：按独立信号组合；`signature_interop_failed` 只由 `signature_ok=false` 且非不可比、非运行故障产生，Kiro 身份只产生身份相关标签。
- `request_logs.stage`：使用 `source`、`relay`、`source_identity` 三个阶段。

### 推荐检测组合

- `source`：启用、凭证完整、非官方参考渠道。
- `relay`：启用、凭证完整、官方参考渠道，优先选择与 Source 模型可比的渠道。
- 无同模型官方 Relay 时，可展示备用官方 Relay，但界面提示模型不可比，后端不发起跨模型验签。

## 核心接口

### 推荐组合选择

提供一个返回 `{ source, relay }` 的纯函数：先选择待测 Source，再按标准化模型名选择官方 Relay。输出稳定且不修改输入列表。

### Signature 执行服务

继续接收 `source` 和 `relay` 两个渠道对象：

1. 使用 Source 凭证请求 thinking signature。
2. 使用 Relay 凭证复用 Source assistant content。
3. 保存第二步得到的 `signature_ok`。
4. 使用 Source 凭证和 Source endpoint 执行身份探针。
5. 合并 Signature 与 Source 身份结论，但分别生成标签。

### Claude 深度检测兼容接口

外部请求中的 `source_channel_id` 暂不改名，以免破坏现有 API 和前端类型；服务内部将该字段解释为“官方参考渠道 ID”，并作为 Relay 传入 Signature 探针。页面文案改称“官方 Relay / 官方基线”。

### 最新手动检测日志查询

新 Result 归属 Source。查询时优先按 Source 查找，同时兼容旧数据按 Relay 保存的历史记录，再通过原始 `source_channel_id`、`relay_channel_id` 精确匹配。

## 模块设计

### 手动 Signature 页面

**职责：** 推荐待测 Source → 官方 Relay；展示反向选择警告；更新步骤、说明、恢复日志和结果文案。

**对外接口：** 继续提交现有 `source_channel_id`、`relay_channel_id`。

**依赖：** 渠道列表中的 `is_reference` 和 `model_name`。

### Signature 核心服务

**职责：** 保持生成与验签顺序；将身份探针切到 Source；产生独立 `signature_ok`；生成准确标签和日志阶段。

**对外接口：** 现有手动检测 API 响应新增可选兼容字段 `signature_ok`。

**依赖：** 现有 Anthropic Messages 调用、错误分类、凭证合并和敏感信息脱敏逻辑。

### 手动检测持久化与查询

**职责：** Result 归属 Source；评分和异常标签依据独立 Signature/身份信号生成；最新日志兼容新旧归属方式。

**依赖：** 现有 Run、RunChannel、Result 模型，不新增数据库字段。

### 自动巡检

**职责：** 将计划的被巡检渠道作为 Source，从基线快照或官方参考集合选 Relay；把结果附加到被巡检 Source 的报告。

**依赖：** BaselineSnapshot、ScheduledChannelTest 和现有 operational failure 归一逻辑。

### Claude 深度检测

**职责：** 将当前被测 `channel` 作为 Source，将配置的官方参考渠道作为 Relay；凭证覆盖只应用于待测 Source。

**依赖：** 现有 `source_channel_id` 兼容参数和官方参考渠道查询。

## 模块交互

### 手动检测

1. 页面选择非参考 Source 和同模型参考 Relay。
2. 后端创建同时包含 Source/Relay 角色的 Run。
3. Source 生成带 signature 的 thinking block。
4. 官方 Relay 复用并返回接受或拒绝结果。
5. 后端保存 `signature_ok`。
6. 后端向 Source 发身份探针，生成身份标签。
7. 合并整体状态，Result 保存到 Source 渠道。
8. 页面展示 Source 身份和官方 Relay 验签证据。

### 自动巡检

1. 计划渠道作为 Source。
2. 基线快照中的官方参考渠道作为 Relay。
3. 执行同一 Signature 核心服务。
4. 将证据和标签附加到 Source 的巡检报告。

### Claude 深度检测

1. 当前检测渠道作为 Source。
2. 用户选择或自动发现的官方参考渠道作为 Relay。
3. Signature 探针采用 Source → Relay。
4. 完整双向完整性矩阵保持现状，不在本次修改。

## 文件组织

```text
frontend/src/
├── signatureInterop.ts              # 推荐 Source/Relay 组合与方向判断
├── signatureInterop.test.ts         # 推荐组合和模型可比性测试
├── pages/SignatureInterop.tsx       # 手动页面方向、步骤和文案
└── types.ts                          # 为 Signature 结果补充可选 signature_ok

backend/app/
├── services.py                       # 核心探针、自动巡检、Claude 深度探针和结果归属
├── schemas.py                        # Signature 响应兼容字段
└── routers/channels.py               # 最新日志按 Source 查询并兼容历史 Relay 归属

backend/tests/
└── test_api.py                       # 手动、身份、巡检、深度探针和历史查询回归
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 身份探针对象 | 待测 Source | 身份异常要评价产签名的待测资源，官方 Relay 只负责验签 |
| 身份探针时机 | Relay 验签后执行 Source 身份请求 | 保留完整 Signature 证据，同时让身份结论独立可追踪 |
| Signature 与身份状态 | 新增 `signature_ok` 独立信号 | 防止 Kiro 身份异常被误标为 Signature 失败 |
| Result 归属 | Source 渠道 | 检测目标是 Source 资源，评分和异常必须记到待测渠道 |
| 自动巡检角色 | scheduled channel=Source，baseline reference=Relay | 与产品目标及手动检测统一 |
| Claude 深度参数兼容 | 保留外部 `source_channel_id` 字段名，内部作为官方 Relay | 避免破坏 API；通过页面文案和内部变量消除语义歧义 |
| 历史日志 | 新数据按 Source 查询，旧数据兼容 Relay 查询 | 不迁移历史结果也能继续查看 |
| 运行故障归因 | 继续优先 operational/not_comparable | HTTP 失败、无权限或模型不一致不能证明 Source signature 无效 |
| Kiro 标签 | 只由 Source 身份响应产生 | 避免官方 Relay 身份与待测渠道风险混淆 |
| 深度双向矩阵 | 保持不变 | 现有矩阵已包含 candidate→official，本次只修正单向快捷探针和业务归属 |
