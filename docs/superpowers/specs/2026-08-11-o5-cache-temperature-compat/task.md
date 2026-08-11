# o5 缓存测试 temperature 兼容修复 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `backend/tests/test_api.py` | 定义缓存探针不发送 `temperature` 的回归契约 |
| 修改 | `backend/app/services.py` | 从缓存探针参数源头移除固定 `temperature` |

## T1: 添加失败回归断言

**文件：** `backend/tests/test_api.py`

**依赖：** 无

**步骤：**

1. 在现有缓存测试主流程用例取得预热和全部重复尝试的持久化结果。
2. 断言每份最终原始请求的顶层均不存在 `temperature`。
3. 断言每份原始请求的参数容器中也不存在 `temperature`，兼容现有证据结构。
4. 保留既有缓存控制、TTL、长文本、统计和凭据脱敏断言。
5. 单独运行该用例，确认它因当前请求仍包含 `temperature: 0` 而失败。

**验证：** 在 `backend` 目录运行 `python3 -m pytest -q tests/test_api.py::test_cache_hit_rate_test_persists_attempts_and_summary`，期望失败，失败证据指向原始请求中仍存在 `temperature`。

## T2: 实现最小修复

**文件：** `backend/app/services.py`

**依赖：** T1

**步骤：**

1. 只从缓存探针的专用请求参数中删除固定 `temperature`。
2. 保留 `max_tokens`、`system_content`、缓存标记、长文本和 TTL。
3. 不修改通用渠道调用器、模型名判断、重试策略或其他参数探针。
4. 重跑 T1 用例，确认回归断言和既有缓存统计断言全部通过。

**验证：** 在 `backend` 目录运行 `python3 -m pytest -q tests/test_api.py::test_cache_hit_rate_test_persists_attempts_and_summary`，期望 `1 passed`。

## T3: 运行缓存测试聚焦回归

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`

**依赖：** T2

**步骤：**

1. 运行全部缓存命中率相关测试。
2. 确认 5 分钟与 1 小时 TTL、独立探针标记、异步任务进度、非法 TTL 和协议限制行为无回归。
3. 检查专用 Thinking temperature 探针相关测试仍保持原有语义。

**验证：** 在 `backend` 目录运行 `python3 -m pytest -q tests/test_api.py -k 'cache_hit_rate or thinking_temperature'`，期望收集到的相关测试全部通过。

## T4: 完整回归和范围检查

**文件：** `backend/app/services.py`、`backend/tests/test_api.py`、本需求四阶段文档

**依赖：** T3

**步骤：**

1. 运行完整后端测试套件，确认没有其他探针和 API 回归。
2. 运行差异格式检查。
3. 检查 Git diff，确认实现只涉及缓存探针的固定温度和对应回归断言。
4. 确认不改写当前工作区中用户已有的前端未提交修改。

**验证：** 在 `backend` 目录运行 `python3 -m pytest -q`；在仓库根目录运行 `git diff --check` 和针对任务文件的 `git diff -- backend/app/services.py backend/tests/test_api.py docs/superpowers/specs/2026-08-11-o5-cache-temperature-compat`，期望测试全通过、格式检查退出码为 0、差异范围符合批准设计。

## 执行顺序

```text
T1 -> T2 -> T3 -> T4
```
