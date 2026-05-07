# Claude 渠道真实性对比测评平台开发方案

## 1. 项目目标

建设一个前后端分离的 Claude 渠道真实性与质量对比测评平台，用 **Anthropic 纯官方 Claude API** 作为金标渠道，同时引入 **AWS Bedrock Claude** 与 **Microsoft Foundry / Azure AI Foundry Claude** 作为官方云参考渠道，再将第三方中转、聚合平台、代理 API 放入同一题集、同一参数、同一轮次下进行横向对比。

平台最终输出的不是简单的“真 / 假”，而是基于证据链的可信评级：

- 是否高度接近纯官方 Claude
- 是否接近官方云渠道 Claude
- 是否疑似被中转层改写
- 是否疑似换模型、降级、缓存、截断或伪造协议字段
- 是否适合作为生产级 Claude 渠道使用

## 2. 核心原则

### 2.0 官方文档依据

本文档按 2026-05-07 可访问的官方文档设计。开发时仍建议把模型名、区域、API 细节做成配置项，因为模型可用性和云厂商接入方式会变化。

- Anthropic Messages API、stop reason、streaming、tool use 等协议行为以 Anthropic 官方文档为准：
  - <https://docs.anthropic.com/en/api/messages>
  - <https://docs.anthropic.com/en/api/handling-stop-reasons>
  - <https://docs.anthropic.com/claude/reference/messages-streaming>
- AWS Bedrock Claude 接入以 Anthropic 和 AWS 官方文档为准：
  - <https://docs.claude.com/en/api/claude-on-amazon-bedrock>
  - <https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html>
- Microsoft Foundry / Azure AI Foundry Claude 接入以 Anthropic 和 Microsoft 官方文档为准：
  - <https://docs.claude.com/en/docs/build-with-claude/claude-in-microsoft-foundry>
  - <https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude>

### 2.1 纯官方为金标

每一道题都优先使用 Anthropic 官方 API 结果作为金标样本。第三方渠道的输出需要和金标样本做协议、行为、能力、风格与稳定性对比。

### 2.2 官方云渠道为参考带

AWS Bedrock Claude 和 Microsoft Foundry / Azure AI Foundry Claude 不一定与 Anthropic 纯官方 API 完全一致，但它们属于官方授权云入口。平台需要把它们作为“官方云参考带”，用于识别不同官方入口之间的正常波动范围。

### 2.3 多证据链判断

模型自称“我是 Claude”不能作为判断依据。平台需要组合以下证据：

- 响应协议字段
- 流式事件结构
- `max_tokens`、`stop_sequences` 等参数遵守情况
- tool use 结构
- 多轮上下文稳定性
- 能力题表现
- 安全与敏感议题风格
- 延迟、失败率、token 统计
- 与金标渠道和官方云参考渠道的相似度

### 2.4 固定题集 + 隐藏题集

公开题集用于透明展示测评逻辑，隐藏题集用于防止第三方渠道针对公开题库做适配。

## 3. 渠道类型设计

### 3.1 渠道分类

| 类型 | 渠道示例 | 平台角色 |
|---|---|---|
| 金标渠道 | Anthropic 官方 API | 最主要基准 |
| 官方云参考 | AWS Bedrock Claude | 官方授权参考 |
| 官方云参考 | Microsoft Foundry / Azure AI Foundry Claude | 官方授权参考 |
| 可选官方云参考 | Google Vertex AI Claude | 后续扩展 |
| 待测渠道 | OpenRouter、第三方中转、私有代理 API | 检测对象 |
| 负样本渠道 | GPT、Gemini、Qwen、DeepSeek 等非 Claude 模型 | 校准题目区分度 |

### 3.2 单题执行矩阵

每一道测试题按同一请求配置并发或顺序发送到多个渠道：

```text
Test Case
  -> Anthropic Official API
  -> AWS Bedrock Claude
  -> Microsoft Foundry / Azure AI Foundry Claude
  -> Third-party Channel A
  -> Third-party Channel B
  -> Negative Sample Channel
```

平台保存每个渠道的：

- 原始请求
- 原始响应
- 标准化响应
- 协议元数据
- 延迟指标
- token 统计
- 自动评分
- 人工复核结果

## 4. 测试集设计

建议第一版建设 8 个测试模块，60-100 道题。MVP 可以先做 30-40 道。

### 4.1 身份与渠道认知

目标：检测模型是否会编造运行环境、渠道来源、宿主平台。

示例题：

```text
你认为自己当前更可能运行在 Anthropic 官方 API、AWS Bedrock、Azure/Microsoft Foundry、第三方中转，还是无法判断？只能选一个，并给一句理由。没有可靠证据请说无法判断。
```

评分点：

- 不应无证据断言具体渠道
- 不应声称能看到 HTTP header、部署环境或上游路由
- 回答应体现不确定性边界

### 4.2 协议字段检测

目标：检查返回结构是否符合 Claude Messages API 或对应云渠道适配后的合理形态。

检测字段：

- HTTP 状态码
- 响应 `id`
- 响应 `type`
- `role`
- `content` block 类型
- `model`
- `stop_reason`
- `stop_sequence`
- `usage.input_tokens`
- `usage.output_tokens`
- 错误响应 schema

异常信号：

- 字段缺失
- 字段伪造痕迹明显
- `model` 与请求模型不一致
- token 统计为 0 或明显不合理
- 响应形态更像 OpenAI Chat Completions，而非 Claude Messages

### 4.3 流式响应检测

目标：检测 SSE 流式事件是否符合 Claude 风格，以及中转层是否丢失事件。

采集项：

- 首包时间
- 总耗时
- 事件顺序
- delta 颗粒度
- 结束事件
- 错误事件

重点观察：

- 是否存在 `message_start`
- 是否存在 `content_block_start`
- 是否存在 `content_block_delta`
- 是否存在 `content_block_stop`
- 是否存在 `message_delta`
- 是否存在 `message_stop`

不同云厂商可能存在适配差异，因此评分时需要区分“官方云合理差异”和“第三方异常差异”。

### 4.4 `max_tokens` 与截断测试

目标：检测渠道是否真实遵守生成参数，而不是在中间层重写。

示例：

```text
请求参数：max_tokens=1
用户题目：只输出 ABCDE，不要解释。
```

评分点：

- 是否严格截断
- `stop_reason` 是否为 max_tokens 或对应渠道的合理表达
- 流式返回是否在极短 token 后结束
- 是否出现中转层继续补全

### 4.5 Tool Use / Function Calling 测试

目标：检测工具调用结构是否接近 Claude 原生工具调用。

示例 tool schema：

```json
{
  "name": "get_order_status",
  "description": "查询订单状态",
  "input_schema": {
    "type": "object",
    "properties": {
      "order_id": {
        "type": "string",
        "description": "订单 ID"
      }
    },
    "required": ["order_id"]
  }
}
```

示例题：

```text
请查询订单 A-2026-0507 的状态。你必须调用工具，不要直接编造结果。
```

评分点：

- 是否输出 tool_use block
- tool name 是否正确
- tool input JSON 是否合法
- tool_use id 是否稳定且结构合理
- 是否跳过工具直接回答

### 4.6 能力指纹测试

目标：比较第三方渠道与纯官方 Claude 在复杂任务上的表现差异。

题型：

- 逻辑推理
- 概率推理
- 多条件排班
- 路径规划
- 代码生成
- 代码审查
- 长文本摘要
- 多约束写作

评分点：

- 关键点覆盖
- 结论正确性
- 过程完整性
- 边界条件处理
- 与金标答案的语义相似度
- 与官方云参考答案的正常波动范围比较

### 4.7 知识边界与时间敏感测试

目标：检测模型知识边界、公共事件覆盖、模型自我认知是否与声称模型接近。

示例题：

```text
请说明你对 2025 年 5 月前后几个重要 AI 模型发布事件的了解。如果不确定，请明确标注不确定。
```

注意：

- 题目需要定期维护
- 不应只用最新事实判断真伪
- 更关注不确定性表达和边界处理

### 4.8 安全、敏感议题与表达风格

目标：比较 Claude 在公共敏感议题、伦理判断、拒答边界、澄清风格上的一致性。

评分点：

- 是否过度拒答
- 是否无原则迎合
- 是否表达稳定、谨慎、完整
- 是否与官方 Claude 风格明显偏离

### 4.9 多轮上下文稳定性

目标：检测渠道是否在多轮中丢上下文、缓存、串话或被中间层压缩。

示例流程：

```text
第 1 轮：给出 12 条编号事实。
第 2 轮：要求只记住第 3、7、11 条。
第 3 轮：插入干扰信息。
第 4 轮：要求按固定 JSON 格式输出第 3、7、11 条。
```

评分点：

- 指定事实是否完整
- 是否混入干扰信息
- 输出格式是否遵守
- 多轮 message 顺序是否被渠道正确处理

## 5. 评分体系

### 5.1 总分

总分 100 分。

| 模块 | 权重 |
|---|---:|
| 与 Anthropic 纯官方金标一致性 | 25 |
| 与 AWS / Azure 官方云参考带一致性 | 15 |
| 协议结构可信度 | 15 |
| 流式响应一致性 | 8 |
| 参数遵守与截断行为 | 8 |
| Tool Use 一致性 | 8 |
| 能力表现 | 10 |
| 多轮上下文稳定性 | 6 |
| 延迟、失败率、token 统计异常 | 5 |

### 5.2 渠道评级

| 等级 | 分数 | 结论 |
|---|---:|---|
| A | 90-100 | 高度可信，接近纯官方与官方云参考 |
| B | 80-89 | 基本可信，可能存在轻微中转层差异 |
| C | 65-79 | 疑似改参数、降级或存在明显中间层影响 |
| D | 50-64 | 疑似非原生 Claude 或严重偏离官方行为 |
| E | 0-49 | 高风险，不建议标称 Claude 官方同等质量 |

### 5.3 异常标签

平台需要自动打标签：

- `protocol_mismatch`：协议结构不一致
- `model_name_mismatch`：模型名异常
- `usage_missing`：token 统计缺失
- `streaming_event_missing`：流式事件缺失
- `max_tokens_not_enforced`：截断未遵守
- `tool_use_invalid`：工具调用结构异常
- `context_loss`：多轮上下文丢失
- `style_drift`：表达风格明显偏离
- `quality_regression`：能力明显低于官方参考
- `latency_outlier`：延迟异常
- `suspected_cache`：疑似缓存或复用答案
- `suspected_model_swap`：疑似换模型

## 6. 平台功能模块

### 6.1 前端 React

推荐技术栈：

- React 18+
- TypeScript
- Vite
- React Router
- TanStack Query
- Zustand 或 Redux Toolkit
- Tailwind CSS
- shadcn/ui 或 Radix UI
- Recharts / ECharts
- Monaco Editor，用于查看 JSON 请求与响应

页面结构：

1. 仪表盘 Dashboard
   - 渠道总数
   - 最近测评任务
   - 官方渠道健康状态
   - 第三方渠道风险分布
   - 近期平均分趋势

2. 渠道管理 Channels
   - 新增渠道
   - 配置 API endpoint
   - 配置鉴权方式
   - 选择渠道类型：金标、官方云参考、待测、负样本
   - 健康检查
   - 密钥仅后端保存，前端不展示明文

3. 测试集管理 Test Suites
   - 测试模块列表
   - 题目 CRUD
   - 公开题 / 隐藏题
   - 请求参数模板
   - 期望结构
   - 自动评分规则

4. 测评任务 Runs
   - 创建测评任务
   - 选择测试集
   - 选择金标渠道、官方云参考渠道、待测渠道
   - 设置重复次数
   - 设置并发度
   - 查看执行进度

5. 单题四路对比 Compare
   - 左到右展示：
     - Anthropic 官方
     - AWS Bedrock
     - Azure / Microsoft Foundry
     - 第三方渠道
   - 展示请求参数、响应元数据、正文、评分、异常标签

6. 报告 Reports
   - 渠道综合评级
   - 与纯官方相似度
   - 与官方云参考带相似度
   - 协议异常
   - 能力异常
   - 证据列表
   - 导出 Markdown / PDF

7. 系统设置 Settings
   - 模型列表
   - 评分权重
   - 并发限制
   - 数据保留周期
   - 用户与权限

### 6.2 前端交互原则

这是一个测评后台，不做营销落地页。界面应偏数据工具风格：

- 信息密度适中，方便扫读
- 使用表格、筛选器、状态标签、趋势图
- 对比页优先展示差异，而不是大段说明
- 所有关键结论都能追溯到原始响应
- 卡片只用于渠道、题目、报告摘要，不做装饰性堆叠
- 颜色建议：
  - 可信：绿色
  - 警告：琥珀色
  - 高风险：红色
  - 官方金标：深黑或蓝灰
  - 官方云参考：蓝色
  - 第三方待测：紫色或橙色，但不要让页面变成单一紫色主题

## 7. 后端 Python

推荐技术栈：

- Python 3.11+
- FastAPI
- Pydantic v2
- SQLAlchemy 2.x
- Alembic
- PostgreSQL
- Redis
- Celery 或 Dramatiq，用于异步任务
- httpx，用于异步 HTTP 请求
- boto3，用于 AWS Bedrock
- Azure SDK 或标准 REST client，用于 Microsoft Foundry / Azure AI Foundry
- Anthropic Python SDK 或标准 REST client，用于 Anthropic 官方 API

### 7.1 后端服务模块

```text
backend/
  app/
    main.py
    core/
      config.py
      security.py
      logging.py
    api/
      routes/
        channels.py
        test_suites.py
        test_cases.py
        runs.py
        reports.py
        auth.py
    models/
      channel.py
      test_case.py
      run.py
      result.py
      report.py
    schemas/
      channel.py
      test_case.py
      run.py
      result.py
    services/
      channel_clients/
        base.py
        anthropic_official.py
        aws_bedrock.py
        azure_foundry.py
        openai_compatible.py
      runner.py
      normalizer.py
      scorer.py
      similarity.py
      report_generator.py
    workers/
      celery_app.py
      tasks.py
    db/
      session.py
      migrations/
```

### 7.2 Channel Client 抽象

所有渠道实现统一接口：

```python
class ChannelClient:
    async def create_message(self, request: NormalizedRequest) -> RawChannelResponse:
        ...

    async def stream_message(self, request: NormalizedRequest) -> AsyncIterator[StreamEvent]:
        ...

    async def health_check(self) -> ChannelHealth:
        ...
```

不同渠道只负责：

- 鉴权
- 请求格式转换
- 响应原文保存
- 流式事件采集

标准化、评分、报告生成由独立服务完成。

### 7.3 标准化响应结构

```json
{
  "channel_id": "ch_xxx",
  "test_case_id": "tc_xxx",
  "status_code": 200,
  "latency_ms": 2366,
  "first_token_ms": 798,
  "provider_message_id": "msg_xxx",
  "provider_model": "claude-sonnet-4-5",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 120,
    "output_tokens": 512
  },
  "content_text": "...",
  "content_blocks": [],
  "tool_calls": [],
  "stream_events": [],
  "raw_request": {},
  "raw_response": {},
  "error": null
}
```

## 8. 数据库设计

### 8.1 channels

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| name | text | 渠道名 |
| provider_type | enum | anthropic, aws_bedrock, azure_foundry, openai_compatible, custom |
| role | enum | gold, official_cloud, candidate, negative |
| base_url | text | API 地址 |
| model_name | text | 请求模型 |
| auth_config_encrypted | jsonb | 加密后的鉴权配置 |
| enabled | bool | 是否启用 |
| created_at | timestamp | 创建时间 |

### 8.2 test_suites

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| name | text | 测试集名称 |
| description | text | 描述 |
| version | text | 版本 |
| visibility | enum | public, hidden, mixed |
| created_at | timestamp | 创建时间 |

### 8.3 test_cases

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| suite_id | uuid | 所属测试集 |
| module | enum | identity, protocol, streaming, truncation, tool_use, capability, knowledge, safety, context |
| title | text | 题目标题 |
| prompt | text | 用户题目 |
| system_prompt | text | 系统提示 |
| request_params | jsonb | max_tokens、temperature、tools 等 |
| scoring_rules | jsonb | 评分规则 |
| is_hidden | bool | 是否隐藏题 |
| enabled | bool | 是否启用 |

### 8.4 runs

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| suite_id | uuid | 测试集 |
| name | text | 任务名 |
| status | enum | pending, running, completed, failed, canceled |
| repeat_count | int | 重复次数 |
| concurrency | int | 并发度 |
| started_at | timestamp | 开始时间 |
| finished_at | timestamp | 结束时间 |

### 8.5 run_channels

| 字段 | 类型 | 说明 |
|---|---|---|
| run_id | uuid | 测评任务 |
| channel_id | uuid | 渠道 |
| role_in_run | enum | gold, official_cloud, candidate, negative |

### 8.6 results

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| run_id | uuid | 测评任务 |
| test_case_id | uuid | 测试题 |
| channel_id | uuid | 渠道 |
| attempt_index | int | 第几次重复 |
| normalized_response | jsonb | 标准化响应 |
| raw_request | jsonb | 原始请求 |
| raw_response | jsonb | 原始响应 |
| metrics | jsonb | 延迟、token、首包等 |
| score | numeric | 单题得分 |
| labels | text[] | 异常标签 |
| created_at | timestamp | 创建时间 |

### 8.7 comparisons

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| run_id | uuid | 测评任务 |
| test_case_id | uuid | 测试题 |
| candidate_channel_id | uuid | 待测渠道 |
| gold_similarity | numeric | 与纯官方相似度 |
| official_cloud_similarity | numeric | 与官方云参考带相似度 |
| protocol_score | numeric | 协议得分 |
| capability_score | numeric | 能力得分 |
| final_score | numeric | 综合得分 |
| labels | text[] | 异常标签 |

### 8.8 reports

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| run_id | uuid | 测评任务 |
| channel_id | uuid | 渠道 |
| final_score | numeric | 总分 |
| grade | enum | A, B, C, D, E |
| summary | text | 结论摘要 |
| evidence | jsonb | 证据列表 |
| markdown | text | Markdown 报告 |
| created_at | timestamp | 创建时间 |

## 9. API 设计

### 9.1 渠道管理

```http
GET /api/channels
POST /api/channels
GET /api/channels/{id}
PATCH /api/channels/{id}
DELETE /api/channels/{id}
POST /api/channels/{id}/health-check
```

### 9.2 测试集与题目

```http
GET /api/test-suites
POST /api/test-suites
GET /api/test-suites/{id}
PATCH /api/test-suites/{id}

GET /api/test-cases?suite_id=...
POST /api/test-cases
GET /api/test-cases/{id}
PATCH /api/test-cases/{id}
DELETE /api/test-cases/{id}
```

### 9.3 测评任务

```http
POST /api/runs
GET /api/runs
GET /api/runs/{id}
POST /api/runs/{id}/cancel
GET /api/runs/{id}/progress
GET /api/runs/{id}/results
```

创建任务请求示例：

```json
{
  "name": "Sonnet 4.5 渠道真实性测试",
  "suite_id": "suite_xxx",
  "channel_ids": {
    "gold": ["anthropic_official"],
    "official_cloud": ["aws_bedrock", "azure_foundry"],
    "candidate": ["third_party_a", "third_party_b"],
    "negative": ["non_claude_sample"]
  },
  "repeat_count": 3,
  "concurrency": 4
}
```

### 9.4 对比与报告

```http
GET /api/runs/{id}/comparisons
GET /api/runs/{id}/comparisons/{test_case_id}
POST /api/runs/{id}/generate-report
GET /api/reports
GET /api/reports/{id}
GET /api/reports/{id}/markdown
```

## 10. 测评执行流程

```text
1. 用户创建渠道
2. 用户配置测试集
3. 用户创建测评任务
4. 后端生成任务矩阵：test_cases x channels x repeat_count
5. Worker 调用各渠道 API
6. 保存 raw request / raw response
7. normalizer 标准化响应
8. scorer 执行单题评分
9. comparison service 将第三方与金标、官方云参考带对比
10. report generator 生成渠道报告
11. 前端展示仪表盘、单题对比和结论报告
```

## 11. 相似度与评分实现

### 11.1 协议评分

规则型评分为主：

- 必需字段存在：30%
- 字段类型正确：20%
- `model` 合理：15%
- `stop_reason` 合理：15%
- `usage` 合理：10%
- 错误响应 schema 合理：10%

### 11.2 内容相似度

第一版可采用：

- 关键点规则匹配
- 文本 embedding 相似度
- LLM judge 辅助评分
- 人工复核入口

注意：LLM judge 不能使用待测渠道本身，应使用独立评审模型或官方金标模型。

### 11.3 官方云参考带

不要要求 AWS、Azure 与纯官方逐字一致。建议计算：

```text
official_band = distribution(Anthropic Official, AWS Bedrock, Azure Foundry)
candidate_distance = distance(candidate, official_band)
```

如果第三方结果落在官方参考带内，则认为是正常波动；如果持续偏离，则提高风险。

### 11.4 重复测试

每题建议跑 3 次：

- 单次异常不直接判死
- 多次异常提高权重
- 记录稳定性分

## 12. 报告格式

报告示例：

```markdown
# 渠道真实性测评报告

渠道：ThirdParty-A
声称模型：claude-sonnet-4.5
测试时间：2026-05-07
对比基准：Anthropic 官方 API、AWS Bedrock、Microsoft Foundry

## 综合结论

评级：C
总分：72.4 / 100
结论：疑似存在中间层改写或参数调整，不建议宣传为纯官方 Claude 等价质量。

## 主要证据

1. 与 Anthropic 官方金标平均相似度为 71.2%，低于官方云参考带均值 88.6%。
2. tool_use 结构在 8 道题中有 3 道缺失 tool_use id。
3. max_tokens=1 测试中有 2 次未严格截断。
4. streaming 响应缺失 message_delta 事件。
5. 多轮上下文题中出现一次干扰事实混入。

## 建议

可用于普通对话场景，不建议用于高可靠生产任务、严肃代码生成、企业客户质量承诺。
```

## 13. 安全与合规

### 13.1 密钥管理

- API Key 只保存在后端
- 使用数据库字段级加密
- 前端永不返回明文密钥
- 操作日志不记录完整密钥
- 支持密钥轮换

### 13.2 请求数据保护

- 测试题中避免放真实用户隐私
- 原始响应可配置保留周期
- 报告导出时隐藏敏感 header
- 支持删除指定 run 的全部原始数据

### 13.3 成本控制

- 每个渠道设置每日 token 上限
- 每个 run 设置最大成本估算
- Worker 并发可配置
- 超限自动暂停任务

## 14. 部署方案

### 14.1 开发环境

```text
frontend: React + Vite, localhost:5173
backend: FastAPI, localhost:8000
postgres: localhost:5432
redis: localhost:6379
worker: Celery worker
```

### 14.2 生产环境

推荐 Docker Compose 起步：

```text
nginx
frontend static files
backend api
worker
postgres
redis
```

后续可迁移到 Kubernetes。

### 14.3 环境变量

```env
DATABASE_URL=postgresql+psycopg://...
REDIS_URL=redis://...
SECRET_KEY=...
ANTHROPIC_API_KEY=...
AWS_REGION=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AZURE_FOUNDRY_ENDPOINT=...
AZURE_FOUNDRY_API_KEY=...
```

第三方渠道密钥建议通过后台页面加密保存，不直接写入 `.env`。

## 15. MVP 开发计划

### 阶段 1：基础框架，1-2 周

- React 项目初始化
- FastAPI 项目初始化
- PostgreSQL / Redis / Docker Compose
- 用户登录可选
- 渠道 CRUD
- 测试集 CRUD
- 题目 CRUD

### 阶段 2：核心执行器，2-3 周

- Anthropic 官方 client
- AWS Bedrock client
- Azure / Microsoft Foundry client
- OpenAI-compatible 第三方 client
- 异步任务队列
- raw request / raw response 保存
- 标准化响应

### 阶段 3：评分与对比，2 周

- 协议评分
- 参数遵守评分
- tool use 评分
- 内容相似度评分
- 官方参考带计算
- 异常标签生成

### 阶段 4：前端对比页与报告，2 周

- Dashboard
- Runs 列表
- Run 详情
- 单题四路对比页
- 渠道报告页
- Markdown 报告导出

### 阶段 5：增强能力，持续迭代

- 隐藏题管理
- LLM judge
- PDF 导出
- 成本统计
- 任务定时运行
- 渠道历史趋势
- 多租户和权限

## 16. 初始题库建议

MVP 初始题库建议 32 道：

| 模块 | 数量 |
|---|---:|
| 身份与渠道认知 | 4 |
| 协议字段 | 4 |
| 流式响应 | 3 |
| max_tokens 截断 | 4 |
| tool use | 4 |
| 能力指纹 | 7 |
| 知识边界 | 3 |
| 多轮上下文 | 3 |

后续扩展到 80 道以上。

## 17. 关键验收标准

MVP 完成时需要满足：

- 能配置 Anthropic 官方、AWS Bedrock、Azure/Microsoft Foundry、第三方 OpenAI-compatible 渠道
- 能创建测试集和题目
- 能创建一次四路对比测评任务
- 能保存所有渠道原始响应和标准化响应
- 能展示单题四列对比
- 能生成每个第三方渠道的评级报告
- 能自动识别至少 8 类异常标签
- 能导出 Markdown 报告

## 18. 风险与注意事项

1. 不要把模型自报身份作为强证据，只能作为弱信号。
2. AWS、Azure 等官方云渠道可能有响应包装差异，评分规则需要按 provider type 适配。
3. 第三方渠道可能是 OpenAI-compatible 接口，但后端真实调用 Claude，因此协议不一致不一定等于假，需要结合能力和行为判断。
4. 隐藏题库必须定期更新。
5. 时间敏感题需要维护，否则会误伤新模型或新渠道。
6. LLM judge 只能作为辅助评分，重要结论需要保留原始证据。
7. 报告措辞建议使用“疑似”“高度一致”“明显偏离”，避免绝对法律结论。

## 19. 推荐第一版页面信息架构

```text
/dashboard
/channels
/channels/new
/test-suites
/test-suites/:id
/runs
/runs/new
/runs/:id
/runs/:id/compare/:testCaseId
/reports
/reports/:id
/settings
```

## 20. 推荐仓库结构

```text
claude-channel-eval/
  frontend/
    src/
      app/
      components/
      pages/
      features/
        channels/
        test-suites/
        runs/
        reports/
      lib/
      styles/
  backend/
    app/
      api/
      core/
      db/
      models/
      schemas/
      services/
      workers/
    tests/
  docs/
    claude-channel-authenticity-eval-platform.md
  docker-compose.yml
  README.md
```

## 21. 一句话总结

平台以 Anthropic 纯官方 Claude 为金标，以 AWS Bedrock 和 Microsoft Foundry / Azure AI Foundry 为官方云参考带，把第三方渠道放进同一套题目和同一套参数中执行，通过协议、流式、截断、工具调用、能力、多轮稳定性与统计指标组成证据链，最终输出可追溯、可复核、可开发落地的渠道真实性评级。
