# 渠道分组管理实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为渠道增加可由用户维护的分组（例如 `cc`、`aws`），在渠道管理和创建检测任务时按分组筛选，同时不改变现有的角色、评分和历史任务语义。

**Architecture:** 分组与渠道采用多对多关系。`role` 继续表示金标/官方云/候选/负样本等评分语义，`provider_type` 继续表示提供商类型，分组只承担运营管理和筛选职责。运行创建时仍把实际选择的渠道 ID 写入 `RunChannel`，分组只是选择器，不直接替代渠道快照。

**Tech Stack:** FastAPI、Pydantic v2、SQLAlchemy 2.x、Alembic/SQLite 兼容修复、React 19、TypeScript、React Query、Ant Design。

---

## 设计结论

### 1. 采用多对多，而不是给 `channels` 增加单个 `group_id`

一个渠道未来可能同时属于 `cc`、`生产`、`高优先级` 等不同维度。多对多可以支持这些场景，也允许用户先只创建一个分组，不增加使用复杂度。若后续确认每个渠道永远只能有一个组，可以在 UI 上限制为单选，但数据库不需要返工。

### 2. 分组不替代现有分类

| 字段 | 语义 | 是否参与评分 |
|---|---|---|
| `role` | `gold`、`official_cloud`、`candidate`、`negative` | 是 |
| `provider_type` | Anthropic、AWS、Azure、relay 等 | 是/影响协议适配 |
| `group` | 用户自定义的 `cc`、`aws`、生产批次等 | 否，只用于组织、筛选和汇总 |

不能把 `cc` 或 `aws` 写入 `role`，否则会破坏金标/候选渠道的评分逻辑。

### 3. 第一阶段筛选边界

- 必须支持：渠道管理页按分组筛选；新建基线/对比任务按分组筛选可选渠道；编辑渠道时维护分组。
- 建议同时支持：渠道列表批量分配分组、分组 CRUD、小型分组统计。
- 暂不改变：任务执行、报告评分、基线计算、自动巡检的单渠道模型。
- 第二阶段再给 Runs、Reports、Alerts、Scheduled Tests 增加历史筛选；不要把分组 ID 写入每一条 `Result`。

## 数据模型

### `channel_groups`

新增 `ChannelGroup` 模型：

```python
class ChannelGroup(Base):
    __tablename__ = "channel_groups"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str | None] = mapped_column(String(32))
    sort_order: Mapped[int] = mapped_column(Integer, default=1000, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
```

`key` 是稳定的机器标识，保存前转小写并校验 `^[a-z0-9][a-z0-9_-]{0,63}$`；`name` 是可修改的展示名称，允许中文。`key` 不建议修改，避免外部链接和筛选条件失效。

### `channel_group_members`

新增显式关联模型，联合主键防止重复归属：

```python
class ChannelGroupMember(Base):
    __tablename__ = "channel_group_members"
    group_id: Mapped[str] = mapped_column(ForeignKey("channel_groups.id"), primary_key=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), primary_key=True, index=True)
```

在 `Channel` 和 `ChannelGroup` 上建立双向关系。删除分组只删除关联行，不删除渠道；删除渠道时由应用层先清理关联，兼容当前渠道删除的关联数据清理流程。

### `ChannelRead` 返回形状

不要把完整的渠道对象嵌套进每个分组，避免响应变大。返回轻量分组摘要：

```json
{
  "id": "dataeyes-cc-9472",
  "name": "dataeyes-cc-9472",
  "role": "candidate",
  "provider_type": "anthropic_messages",
  "groups": [
    {"id": "grp_cc", "key": "cc", "name": "CC", "color": "#7c3aed"}
  ]
}
```

创建/更新渠道接收 `group_ids: string[]`；分组关联变更也提供独立接口，便于批量操作。现有客户端不传 `group_ids` 时等价于“不修改”（更新）或“无分组”（创建）。

## 后端接口

### 分组 CRUD

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/channel-groups` | 按 `sort_order, name` 返回分组及 `channel_count/enabled_channel_count` |
| `POST` | `/api/channel-groups` | 创建分组；`key` 唯一，重复返回 409 |
| `PATCH` | `/api/channel-groups/{group_id}` | 修改展示名、描述、颜色、排序、启用状态 |
| `DELETE` | `/api/channel-groups/{group_id}` | 仅解绑成员并删除分组，不删除渠道 |

请求体示例：

```json
{
  "key": "aws",
  "name": "AWS",
  "description": "AWS Bedrock Claude 渠道",
  "color": "#2563eb",
  "sort_order": 20,
  "enabled": true
}
```

### 渠道关联与筛选

- `GET /api/channels?group_id=grp_cc`：服务端按关联表过滤；保留当前无参数行为和排序。
- `PUT /api/channels/{channel_id}/groups`：请求 `{"group_ids": ["grp_cc", "grp_prod"]}`，整体替换该渠道分组。
- `POST/PATCH /api/channels`：兼容接收 `group_ids`，内部复用同一套关联校验和替换逻辑。
- 分组不存在、已删除或无权使用时返回 400/404；同一分组重复 ID 在服务端去重。

`GET /api/channels` 的查询参数只增加筛选，不改变默认返回全量渠道，确保旧版前端和现有测试继续工作。

### 运行和历史数据语义

新建任务页面根据分组过滤候选/参考渠道，但提交 payload 仍然是：

```json
{
  "channel_ids": {
    "reference": ["anthropic_official"],
    "candidate": ["dataeyes-cc-9472"]
  }
}
```

不在 `Run` 上新增 `group_id`，也不改变 `RunChannel` 的角色字段。这样分组被修改后，已经创建的任务仍精确指向原渠道，报告不会因为后来移动渠道而改变。

## 前端方案

### 渠道管理页 `Channels.tsx`

1. 新增“分组管理”区域：创建、重命名、修改颜色/排序、停用、删除。删除确认文案必须明确“只移除分组，不删除渠道”。
2. 新增分组筛选 `Select`，选中后调用 `api.channels(group_id)`；保留“全部分组”。
3. 表格增加“分组”列，多个分组使用 Tag 展示；无分组显示“未分组”。
4. 新增/编辑渠道表单增加 `分组` 多选。编辑时加载现有 `group_ids`，保存调用渠道更新接口。
5. 表格开启 `rowSelection` 后提供“批量设置分组”操作，一次整体替换选中渠道分组；清空选择表示移出全部分组。
6. 分组统计显示渠道数和启用数，不把 `role` 统计改成分组统计。

### 新建任务 `CreateRun.tsx`

- 在参考渠道和候选渠道选择器上方增加分组过滤器。
- 过滤器只改变可见选项，不自动清空已经选择的隐藏渠道；下方显示“已选 N 个，其中 M 个来自当前筛选外”，避免用户误删选择。
- 复用 `createRunShared.tsx` 的选择器组件，分组列表通过 React Query 缓存，query key 使用 `['channelGroups']`。
- 分组接口失败时保留原渠道选择流程，并显示非阻塞提示；不能因为分组功能不可用而阻断旧流程。

### 复用 API 和类型

- `frontend/src/types.ts`：增加 `ChannelGroup`、`ChannelGroupCreate`、`ChannelGroupUpdate`、`ChannelGroupSummary`，给 `Channel` 增加 `groups` 和创建/更新 payload 的 `group_ids`。
- `frontend/src/api.ts`：增加 `channelGroups`、`createChannelGroup`、`updateChannelGroup`、`deleteChannelGroup`、`replaceChannelGroups`；`channels` 支持可选 `group_id`。
- 不把分组信息放进 `auth_config`，也不把凭据字段复制到分组对象。

## 迁移与兼容

### Alembic

新增迁移文件，例如 `backend/alembic/versions/<revision>_channel_groups.py`：

1. 创建 `channel_groups`。
2. 创建 `channel_group_members`，加联合主键和 `channel_id` 索引。
3. `downgrade` 先删关联表，再删分组表。

### SQLite 本地库

当前启动流程同时执行 `Base.metadata.create_all()`、Alembic 和 `repair_schema()`。因此必须：

- 让新模型进入 `Base.metadata`，保证新库可直接创建。
- 在 `backend/app/database.py::repair_schema` 增加表/列存在性兼容检查，避免已有本地 SQLite 因未升级而启动失败。
- 不回填默认分组，不改变现有渠道；旧渠道统一表现为“未分组”。

### New API 同步

现有同步逻辑中的远端 `group/groups` 只作为导入证据或筛选条件，不自动覆盖用户手工分组。第一阶段保持当前行为；第二阶段可增加“将远端组映射到本地组”的显式开关，避免一次同步误改运营分组。

## 测试计划

### 后端

在 `backend/tests/test_api.py` 增加：

- 创建分组成功；重复 `key` 返回 409；空 key、非法字符、超长 key 返回 422。
- 创建渠道携带 `group_ids` 后，`GET /api/channels` 返回分组摘要。
- `GET /api/channels?group_id=...` 只返回该分组渠道；无参数仍返回全部渠道。
- 替换渠道分组会去重并校验不存在的 group ID；清空数组可移出全部分组。
- 删除分组只解绑成员，原渠道、Run、Result、Report、Alert 不受影响。
- 旧渠道没有分组时响应为 `groups: []`，旧的渠道创建/更新请求仍通过。

### 前端

新增或扩展测试：

- 分组过滤只影响选项展示，不丢失已选渠道。
- 多分组 Tag 展示和“未分组”展示稳定。
- 批量设置分组提交完整 `group_ids`，清空操作可用。
- 分组接口失败时渠道页面仍能加载和编辑渠道。

### 验证命令

```bash
cd backend && python -m pytest
cd ../frontend && npm test -- --run
cd ../frontend && npm run build
```

## 分阶段交付

### Phase 1：可用 MVP

- 数据表、关联关系、分组 CRUD。
- 渠道管理页分组维护、筛选、批量设置。
- 新建基线/对比任务按分组筛选。
- 后端和前端回归测试、SQLite 启动兼容。

### Phase 2：运营视图

- `/api/runs`、报告、告警、自动巡检列表增加 `group_id` 查询参数。
- Dashboard 增加按分组的渠道数、健康率、告警数汇总。
- 历史数据筛选明确标注“按当前渠道归属统计”；若需要审计级历史归属，再给 `RunChannel` 增加 `group_ids_snapshot` JSON 快照。

### Phase 3：批量运营能力

- 按分组批量创建/暂停巡检计划，但仍展开为单渠道 `ScheduledChannelTest`，不改变当前调度器的一计划一渠道约束。
- New API 远端 group 到本地 group 的可选映射和导入预览。

## 验收标准

- 用户可以创建 `cc`、`aws` 两个分组，并把多个渠道加入一个或多个分组。
- 渠道列表可以按分组快速筛选，默认“全部分组”与现有页面行为一致。
- 新建任务可以按分组缩小候选范围，提交后仍只使用明确选中的渠道 ID。
- 修改或删除分组不会改变渠道角色、基线、报告和历史任务。
- API Key、auth header、原始请求/响应中不出现分组以外的新敏感数据。
- 全量后端测试和前端构建通过，SQLite 本地开发不需要额外手工迁移。

## 自检

- 需求覆盖：分组可配置、按组筛选、渠道管理、运行选择、兼容旧数据、测试均已落到上面的数据模型/API/UI/迁移/测试章节。
- 语义边界：分组不参与真实性评分，不覆盖 `role/provider_type`，历史任务使用固定的 `RunChannel` 渠道快照。
- 风险控制：删除分组不删除渠道；同步导入不默认覆盖手工分组；分组服务失败不阻断旧渠道流程。
