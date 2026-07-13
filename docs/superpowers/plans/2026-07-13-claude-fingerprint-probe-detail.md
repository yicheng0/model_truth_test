# Claude 指纹探针详情与每日历史实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「Claude 指纹」页面的 Web Search 官方能力误判，完整透传探针警告原因，增加自然身份探针、可展开诊断详情和按天历史视图。

**Architecture:** 保留现有 `ClaudeCodeEvidence.result_payload` 持久化模式，由后端在 `_claude_code_probe_payload` 统一生成已脱敏诊断字段，实时 job 与历史详情复用同一 payload。历史列表接口增加 UTC 时间范围过滤，前端将本地日期转换为查询范围并按本地日期分组；旧历史使用兼容回退逻辑展示已有摘要。

**Tech Stack:** FastAPI、SQLAlchemy 2.x、Pydantic v2、pytest、React 19、TypeScript、TanStack Query、Ant Design、dayjs、Vitest。

---

## 文件结构

- 修改 `backend/app/services.py`：Web Search/身份后检查、统一诊断字段、历史日期过滤。
- 修改 `backend/app/schemas.py`：为实时与完成探针响应增加可选诊断字段。
- 修改 `backend/app/main.py`：Claude 指纹历史接口接收 `from` / `to`。
- 修改 `backend/tests/test_api.py`：覆盖 Web Search、诊断透传、身份探针、日期过滤和旧数据兼容。
- 修改 `frontend/src/types.ts`：声明统一探针诊断字段和历史筛选类型。
- 修改 `frontend/src/api.ts`：发送历史时间范围查询参数。
- 修改 `frontend/src/api.test.ts`：验证历史查询参数兼容性。
- 创建 `frontend/src/claudeFingerprintHistory.ts`：日期范围转换、每日分组统计和旧诊断回退。
- 创建 `frontend/src/claudeFingerprintHistory.test.ts`：单测日期/分组/诊断逻辑。
- 修改 `frontend/src/pages/ClaudeCodeCheck.tsx`：展开详情、日期筛选、每日历史分组。
- 修改 `frontend/src/styles.css`：详情面板和每日历史标题的紧凑布局。

### Task 1: 用失败测试锁定 Web Search 状态和完整诊断契约

**Files:**
- Modify: `backend/tests/test_api.py`

- [ ] **Step 1: 增加 Web Search 状态矩阵测试**

在现有 `test_claude_code_web_search_reference_detects_server_tool_evidence` 附近增加参数化测试，构造以下 normalized payload：

```python
@pytest.mark.parametrize(
    ("normalized", "expected_status", "expected_label"),
    [
        (
            {
                "status_code": 200,
                "usage": {"server_tool_use": {"web_search_requests": 1}},
                "raw_response": {"content": [{"type": "server_tool_use", "name": "web_search"}]},
                "content_text": "搜索结果",
                "error": None,
            },
            "pass",
            "web_search_supported",
        ),
        (
            {
                "status_code": 200,
                "raw_response": {"content": [{"type": "web_search_tool_result_error", "error_code": "max_uses_exceeded"}]},
                "content_text": "",
                "error": None,
            },
            "warning",
            "web_search_tool_error",
        ),
        (
            {"status_code": 400, "raw_response": {"type": "error"}, "error": "unsupported tool web_search_20260318"},
            "skipped",
            "web_search_not_supported",
        ),
        (
            {"status_code": 200, "raw_response": {"type": "message"}, "content_text": "当前环境没有真实联网工具", "error": None},
            "skipped",
            "web_search_not_available",
        ),
        (
            {"status_code": 200, "raw_response": {"type": "message", "content": []}, "content_text": "普通回答", "error": None},
            "warning",
            "web_search_evidence_missing",
        ),
        (
            {"status_code": 503, "raw_response": {"type": "error"}, "error": "upstream overloaded", "error_type": "provider_error"},
            "warning",
            "provider_temporarily_unavailable",
        ),
    ],
)
def test_claude_code_web_search_reference_status_matrix(normalized, expected_status, expected_label) -> None:
    from app.services import _claude_code_probe_configs, _claude_code_probe_payload

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "web_search_reference")
    payload = _claude_code_probe_payload(config, None, normalized, score=0, labels=[])

    assert payload["status"] == expected_status
    assert expected_label in payload["labels"]
    assert payload["reason"]
```

- [ ] **Step 2: 增加统一诊断字段与脱敏测试**

```python
def test_claude_code_probe_payload_transmits_redacted_diagnostics() -> None:
    from app.services import _claude_code_probe_configs, _claude_code_probe_payload

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "web_search_reference")
    normalized = {
        "status_code": 429,
        "error_type": "rate_limit_error",
        "error": "rate limited; x-api-key=sk-secret-value",
        "content_text": "",
        "raw_request": {
            "model": "claude-sonnet-4-5",
            "max_tokens": 900,
            "tools": [{"type": "web_search_20260318", "name": "web_search"}],
            "headers": {"x-api-key": "sk-secret-value"},
        },
        "raw_response": {"type": "error", "error": {"message": "rate limited"}},
        "request_protocol": "anthropic_messages",
        "provider_endpoint": "https://api.anthropic.com/v1/messages",
    }

    payload = _claude_code_probe_payload(config, None, normalized, score=0, labels=["request_failed"])
    serialized = json.dumps(payload, ensure_ascii=False)

    assert payload["reason"]
    assert payload["label_explanations"]
    assert payload["http_status"] == 429
    assert payload["error_type"] == "rate_limit_error"
    assert payload["error_detail"]
    assert payload["request_snapshot"]["tools"][0]["name"] == "web_search"
    assert payload["raw_evidence"]["request_protocol"] == "anthropic_messages"
    assert "sk-secret-value" not in serialized
    assert "x-api-key" not in serialized.lower()
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```bash
cd backend
python -m pytest tests/test_api.py -k "web_search_reference_status_matrix or probe_payload_transmits_redacted_diagnostics" -q
```

Expected: FAIL，因为 `reason` 等诊断字段不存在，reference 状态目前只能是 pass/skipped，工具错误和证据缺失无法得到 warning。

### Task 2: 实现 Web Search 正确状态和统一诊断 payload

**Files:**
- Modify: `backend/app/services.py`
- Modify: `backend/app/schemas.py`
- Test: `backend/tests/test_api.py`

- [ ] **Step 1: 扩展 Web Search 证据分类**

在 `_claude_code_web_search_reference_score` 中保持成功证据优先，然后依次识别工具错误、运营错误、明确能力不支持、模型声明无工具和证据缺失。返回值仍为 `(score, labels)`，状态由 labels 决定：

```python
if has_server_tool_use or has_web_search_result or has_citation or has_usage:
    labels = ["web_search_supported"]
    if has_tool_error:
        labels.append("web_search_tool_error")
    return 100.0, labels
if has_tool_error:
    return 0.0, ["web_search_tool_error"]
operational_label = operational_failure_label_for_item({
    "error": normalized.get("error"),
    "http_status": normalized.get("status_code"),
})
if operational_label:
    return 0.0, [operational_label]
if explicit_unsupported:
    return 0.0, ["web_search_not_supported"]
if explicit_no_tool:
    return 0.0, ["web_search_not_available"]
return 0.0, ["web_search_evidence_missing"]
```

不要把 `tool` 这一宽泛 token 单独视为 unsupported；只有明确的 unsupported/not supported/not available/unknown tool 等组合才表示能力不支持。

- [ ] **Step 2: 让 reference 状态区分 pass/warning/skipped**

修改 `_claude_code_probe_status`：

```python
if str(severity) == "reference":
    if "web_search_supported" in label_set and "web_search_tool_error" not in label_set:
        return "pass"
    if label_set.intersection({"web_search_not_supported", "web_search_not_available", "capability_not_supported"}):
        return "skipped"
    return "warning"
```

当成功响应同时包含某次 tool result error 时保留 `warning`，以便用户看到工具执行异常。

- [ ] **Step 3: 增加统一诊断构建 helper**

在 `_claude_code_probe_payload` 附近增加：

```python
def _claude_code_request_snapshot(config: dict[str, Any], normalized: dict[str, Any]) -> dict[str, Any]:
    raw_request = normalized.get("raw_request") if isinstance(normalized.get("raw_request"), dict) else {}
    snapshot = {
        "prompt": config.get("prompt"),
        "system_prompt": config.get("system_prompt"),
        "model": raw_request.get("model"),
        "max_tokens": raw_request.get("max_tokens") or (config.get("request_params") or {}).get("max_tokens"),
        "stream": raw_request.get("stream") if "stream" in raw_request else (config.get("request_params") or {}).get("stream"),
        "thinking": raw_request.get("thinking") or (config.get("request_params") or {}).get("thinking"),
        "tools": raw_request.get("tools") or (config.get("request_params") or {}).get("tools"),
    }
    return redact_secrets({key: value for key, value in snapshot.items() if value is not None})
```

同时增加 `_claude_code_raw_evidence` 和 `_claude_code_probe_reason`。`raw_evidence` 只收集判定需要的字段：response type、content block types、stop reason、usage keys、Web Search 使用次数、协议和 endpoint；`reason` 使用 label 的明确中文说明加上观察到的状态，而不是仅返回标签名。

- [ ] **Step 4: 将诊断字段加入 probe payload**

在 `_claude_code_probe_payload` 返回值加入：

```python
"reason": _claude_code_probe_reason(config, status, final_labels, normalized),
"label_explanations": label_explanations(final_labels),
"http_status": normalized.get("status_code"),
"error_type": normalized.get("error_type"),
"error_detail": redact_secrets(str(normalized.get("error") or "")) or None,
"response_excerpt": redact_secrets(str(normalized.get("content_text") or ""))[:4000] or None,
"request_snapshot": _claude_code_request_snapshot(config, normalized),
"raw_evidence": _claude_code_raw_evidence(normalized),
```

对 repeatability 与 signature interop payload 使用相同字段集合；缺少 normalized 字段时返回 `None` 或空对象，保证 job schema 稳定。

- [ ] **Step 5: 扩展 Pydantic 响应模型**

给 `ClaudeCodeProbeResultRead` 和 `ClaudeCodeJobProbeRead` 增加一致的可选字段：

```python
reason: str | None = None
label_explanations: list[dict[str, str]] = Field(default_factory=list)
http_status: int | None = None
error_type: str | None = None
error_detail: str | None = None
response_excerpt: str | None = None
request_snapshot: dict[str, Any] = Field(default_factory=dict)
raw_evidence: dict[str, Any] = Field(default_factory=dict)
```

为相关字段加 field serializer 或确保服务层已调用 `redact_secrets`，使 API 最终序列化再次脱敏。

- [ ] **Step 6: 补充标签解释**

在 `LABEL_EXPLANATIONS` 中新增：

```python
"web_search_supported": "检测到 Anthropic server-side Web Search 调用或 usage 证据。",
"web_search_tool_error": "Web Search 已被调用，但 server tool 返回了错误；需要结合错误码复核。",
"web_search_not_available": "模型明确说明当前环境没有真实联网或搜索工具；作为能力参考跳过。",
"web_search_evidence_missing": "响应没有包含 server-side Web Search block、引用或使用次数，无法证明真实联网。",
"identity_uncertain": "模型只给出通用 AI 助手身份，未明确说明 Claude/Anthropic。",
```

- [ ] **Step 7: 运行目标测试并确认 GREEN**

Run:

```bash
cd backend
python -m pytest tests/test_api.py -k "web_search_reference_status_matrix or probe_payload_transmits_redacted_diagnostics or web_search_reference_detects_server_tool_evidence or optional_capability_400" -q
```

Expected: PASS。

### Task 3: 增加自然身份探针并保持低权重

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`

- [ ] **Step 1: 写身份探针失败测试**

```python
def test_claude_fingerprint_has_natural_identity_probes() -> None:
    from app.services import _claude_code_probe_configs

    configs = {item["key"]: item for item in _claude_code_probe_configs(None)}
    assert configs["identity_direct"]["prompt"] == "你是谁？由哪家公司开发？请简短回答。"
    assert configs["identity_greeting"]["prompt"] == "你好，请简单介绍一下你自己。"
    assert configs["identity_direct"]["severity"] == "weak"
    assert configs["identity_greeting"]["severity"] == "weak"
    assert configs["identity_direct"]["category"] == "identity"


@pytest.mark.parametrize(
    ("text", "expected_status", "expected_label"),
    [
        ("我是 Claude，由 Anthropic 开发。", "pass", None),
        ("我是 ChatGPT，由 OpenAI 开发。", "warning", "identity_mismatch"),
        ("你好，我是一个 AI 助手。", "warning", "identity_uncertain"),
    ],
)
def test_claude_fingerprint_identity_probe_is_weak_signal(text, expected_status, expected_label) -> None:
    from app.services import _claude_code_probe_configs, _claude_code_probe_payload

    config = next(item for item in _claude_code_probe_configs(None) if item["key"] == "identity_greeting")
    normalized = {"status_code": 200, "content_text": text, "raw_response": {"type": "message"}, "error": None}
    payload = _claude_code_probe_payload(config, None, normalized, score=100, labels=[])

    assert payload["status"] == expected_status
    if expected_label:
        assert expected_label in payload["labels"]
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd backend
python -m pytest tests/test_api.py -k "natural_identity_probes or identity_probe_is_weak_signal" -q
```

Expected: FAIL，因为 Claude 指纹配置尚无身份探针和身份 post-check。

- [ ] **Step 3: 增加配置与身份后检查**

在 `_claude_code_probe_configs` 中增加两个配置：

```python
{
    "key": "identity_direct",
    "title": "直接身份询问",
    "category": "identity",
    "severity": "weak",
    "prompt": "你是谁？由哪家公司开发？请简短回答。",
    "request_params": {"max_tokens": 160, "temperature": 0},
    "scoring_rules": {},
    "post_check": "identity_reference",
},
{
    "key": "identity_greeting",
    "title": "问候与自我介绍",
    "category": "identity",
    "severity": "weak",
    "prompt": "你好，请简单介绍一下你自己。",
    "request_params": {"max_tokens": 160, "temperature": 0},
    "scoring_rules": {},
    "post_check": "identity_reference",
},
```

把 `identity` 映射到 `behavior` section。在 `_claude_code_probe_payload` 中对 `identity_reference` 调用 helper：明确 Claude/Anthropic 返回 100/无标签；明确其他厂商返回 0/`identity_mismatch`；通用 AI 助手返回 50/`identity_uncertain`。

- [ ] **Step 4: 确认身份警告不推翻核心分类**

扩展现有 `test_claude_code_web_search_reference_failure_does_not_lower_result` 风格的整体验证：把所有核心探针设为通过，仅身份 probe 返回 `identity_uncertain`，断言 `classification_status` 仍为 `claude` 或 `claude_code`、`claude_score` 不因 weak probe 直接降为非 Claude。

- [ ] **Step 5: 运行身份与完整端点测试**

Run:

```bash
cd backend
python -m pytest tests/test_api.py -k "claude_fingerprint and identity or claude_code_test_endpoint_runs_isolated_probe_suite" -q
```

Expected: PASS。

### Task 4: 为历史接口增加日期范围并保持旧历史兼容

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: 写日期过滤失败测试**

创建三条 `ClaudeCodeEvidence`，将 `created_at` 分别设置为范围前、范围内和范围后，然后调用：

```python
response = client.get(
    "/api/claude-code-history",
    params={"from": "2026-07-12T16:00:00Z", "to": "2026-07-13T15:59:59.999Z"},
)
```

断言只返回范围内记录，并增加 `from >= to` 返回 422 的测试。另创建一个旧 `result_payload`（probe 只有 `key/status/evidence_excerpt`），断言列表和详情仍返回 200。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd backend
python -m pytest tests/test_api.py -k "claude_code_history_date_range or claude_code_history_legacy_payload" -q
```

Expected: FAIL，因为接口忽略时间参数。

- [ ] **Step 3: 实现服务层过滤**

修改函数签名：

```python
def claude_code_evidence_list(
    db: Session,
    *,
    from_time: datetime | None = None,
    to_time: datetime | None = None,
) -> list[dict[str, Any]]:
    statement = select(ClaudeCodeEvidence)
    if from_time is not None:
        statement = statement.where(ClaudeCodeEvidence.created_at >= from_time)
    if to_time is not None:
        statement = statement.where(ClaudeCodeEvidence.created_at <= to_time)
    items = list(db.scalars(statement.order_by(ClaudeCodeEvidence.created_at.desc())).all())
```

避免在服务层对旧 payload 强制补写；只使用 `.get()` 读取缺失字段。

- [ ] **Step 4: 实现 FastAPI 查询参数**

```python
@app.get("/api/claude-code-history", response_model=list[ClaudeCodeEvidenceListItemRead])
def list_claude_code_history(
    from_time: datetime | None = Query(default=None, alias="from"),
    to_time: datetime | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    if from_time and to_time and from_time >= to_time:
        raise HTTPException(status_code=422, detail="from must be earlier than to")
    return claude_code_evidence_list(db, from_time=from_time, to_time=to_time)
```

- [ ] **Step 5: 运行历史测试并确认 GREEN**

Run:

```bash
cd backend
python -m pytest tests/test_api.py -k "claude_code_history" -q
```

Expected: PASS。

### Task 5: 扩展前端类型/API并实现可测试的每日历史工具

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/api.test.ts`
- Create: `frontend/src/claudeFingerprintHistory.ts`
- Create: `frontend/src/claudeFingerprintHistory.test.ts`

- [ ] **Step 1: 写 API 查询参数失败测试**

在 `frontend/src/api.test.ts` 增加：

```typescript
it('loads Claude fingerprint history within an ISO time range', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  await api.claudeCodeHistory({
    from: '2026-07-12T16:00:00.000Z',
    to: '2026-07-13T15:59:59.999Z',
  });

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/claude-code-history?from=2026-07-12T16%3A00%3A00.000Z&to=2026-07-13T15%3A59%3A59.999Z',
    expect.any(Object),
  );
});
```

- [ ] **Step 2: 写每日分组和诊断回退失败测试**

```typescript
it('groups Claude fingerprint history by local day with probe totals', () => {
  const groups = groupClaudeFingerprintHistory([
    historyItem('a', '2026-07-13T01:00:00+08:00', 1, 2),
    historyItem('b', '2026-07-13T20:00:00+08:00', 0, 1),
    historyItem('c', '2026-07-12T12:00:00+08:00', 2, 0),
  ]);
  expect(groups[0]).toMatchObject({ date: '2026-07-13', runCount: 2, failCount: 1, warningCount: 3 });
});

it('falls back to legacy evidence when structured reason is missing', () => {
  expect(probeDiagnosticText({ status: 'warning', labels: [], evidence_excerpt: 'legacy warning' })).toBe('legacy warning');
});
```

- [ ] **Step 3: 运行前端目标测试并确认 RED**

Run:

```bash
cd frontend
npm test -- src/api.test.ts src/claudeFingerprintHistory.test.ts
```

Expected: FAIL，因为 API 不接受 filters，工具文件尚不存在。

- [ ] **Step 4: 扩展类型和 API**

给 `ClaudeCodeProbeResult` 与 `ClaudeCodeJobProbe` 增加和后端一致的可选字段，并增加：

```typescript
export type ClaudeCodeHistoryFilters = { from?: string; to?: string };
```

修改 API：

```typescript
claudeCodeHistory: (filters: ClaudeCodeHistoryFilters = {}) =>
  request<ClaudeCodeHistoryItem[]>(`/api/claude-code-history${queryString(filters)}`),
```

- [ ] **Step 5: 实现日期/分组/回退工具**

`frontend/src/claudeFingerprintHistory.ts` 导出：

```typescript
export function localDayRangeIso(range: [Dayjs, Dayjs] | null): ClaudeCodeHistoryFilters
export function groupClaudeFingerprintHistory(items: ClaudeCodeHistoryItem[]): ClaudeCodeHistoryDayGroup[]
export function probeDiagnosticText(probe: ClaudeCodeProbeLike): string
```

`localDayRangeIso` 使用 `startOf('day').toISOString()` 和 `endOf('day').toISOString()`；group key 使用本地 `dayjs(created_at).format('YYYY-MM-DD')`，按日期降序，统计每条历史的 `fail_count` / `warning_count` 和通过数 `max(probe_count - fail_count - warning_count, 0)`。

- [ ] **Step 6: 运行前端目标测试并确认 GREEN**

Run:

```bash
cd frontend
npm test -- src/api.test.ts src/claudeFingerprintHistory.test.ts
```

Expected: PASS。

### Task 6: 在 Claude 指纹表格中增加完整展开详情

**Files:**
- Modify: `frontend/src/pages/ClaudeCodeCheck.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/claudeCodeDiagnostics.ts`
- Test: `frontend/src/claudeCodeDiagnostics.test.ts`

- [ ] **Step 1: 先补诊断优先级测试**

在 `claudeCodeDiagnostics.test.ts` 断言 `probeDiagnosis` 优先使用后端 `reason`，其次使用 `error_detail`，最后才回退 `evidence_excerpt/detail/标签说明`。更新输入类型以接受新字段。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd frontend
npm test -- src/claudeCodeDiagnostics.test.ts
```

Expected: FAIL，因为当前 `probeDiagnosis` 不读取 `reason` 和 `error_detail`。

- [ ] **Step 3: 实现共享详情组件**

在 `ClaudeCodeCheck.tsx` 增加 `ProbeDetailPanel`，入参使用 `ClaudeCodeProbeResult | ClaudeCodeJobProbe`。按规格依次渲染：

```tsx
<Alert type={probe.status === 'fail' ? 'error' : 'warning'} message="判定原因" description={probeDiagnosticText(probe)} />
<Descriptions size="small" column={2}>
  <Descriptions.Item label="HTTP 状态">{probe.http_status ?? '-'}</Descriptions.Item>
  <Descriptions.Item label="错误类型">{probe.error_type ?? '-'}</Descriptions.Item>
  <Descriptions.Item label="请求协议">{probe.request_protocol ?? '-'}</Descriptions.Item>
  <Descriptions.Item label="Endpoint">{probe.provider_endpoint ?? '-'}</Descriptions.Item>
</Descriptions>
<Collapse items={[
  { key: 'error', label: '完整上游错误', children: <pre>{probe.error_detail || '-'}</pre> },
  { key: 'request', label: '脱敏请求快照', children: <pre>{jsonText(probe.request_snapshot)}</pre> },
  { key: 'evidence', label: '结构化原始证据', children: <pre>{jsonText(probe.raw_evidence)}</pre> },
  { key: 'response', label: '响应摘要', children: <pre>{probe.response_excerpt || probe.evidence_excerpt || '-'}</pre> },
]} />
```

表格使用 Ant Design `expandable={{ expandedRowRender: item => <ProbeDetailPanel probe={item} /> }}`。`ProbeTable`、`JobProbeTable` 和 `MultimodalProbeTable` 都使用同一组件；运行中 queued/running 且无详情的行不显示展开按钮。

- [ ] **Step 4: 修正行内摘要与分组计数展示**

`ProbeEvidenceText` 首选 `reason`，保留 ellipsis 仅用于快速浏览。分组百分比的分母排除 skipped reference 探针，或明确显示“通过率（不含跳过）”；标题的 pass/fail/warning/skipped 继续直接取后端 section counts，保证 Web tool error 计入 warning 而不是 warning 0。

- [ ] **Step 5: 添加紧凑样式**

在 `styles.css` 增加 `.claude-probe-detail`、`.claude-probe-detail-pre`、`.claude-probe-detail-meta`，为长错误设置 `white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto;`，避免撑破表格。

- [ ] **Step 6: 运行诊断测试和 TypeScript 构建**

Run:

```bash
cd frontend
npm test -- src/claudeCodeDiagnostics.test.ts
npm run build
```

Expected: PASS。

### Task 7: 将历史抽屉升级为按天查看

**Files:**
- Modify: `frontend/src/pages/ClaudeCodeCheck.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/claudeFingerprintHistory.test.ts`

- [ ] **Step 1: 接入默认最近 7 天日期范围**

增加 state：

```typescript
const [historyDateRange, setHistoryDateRange] = useState<[Dayjs, Dayjs] | null>([
  dayjs().subtract(6, 'day').startOf('day'),
  dayjs().endOf('day'),
]);
const historyFilters = useMemo(() => localDayRangeIso(historyDateRange), [historyDateRange]);
```

Query key 必须包含 `from/to`：

```typescript
const history = useQuery({
  queryKey: ['claudeCodeHistory', historyFilters.from, historyFilters.to],
  queryFn: () => api.claudeCodeHistory(historyFilters),
});
```

- [ ] **Step 2: 增加日期范围控件和按天标题**

历史抽屉顶部加入 `DatePicker.RangePicker`，允许清空（清空即全部历史）。将 `filteredHistory.map` 替换为 `groupClaudeFingerprintHistory(filteredHistory).map`，每天渲染：

```tsx
<div className="claude-history-day-head">
  <Typography.Text strong>{dayjs(group.date).format('YYYY年M月D日')}</Typography.Text>
  <Space wrap>
    <Tag>{group.runCount} 次</Tag>
    <Tag color="green">通过 {group.passCount}</Tag>
    <Tag color="red">失败 {group.failCount}</Tag>
    <Tag color="orange">警告 {group.warningCount}</Tag>
  </Space>
</div>
```

其下继续复用 `HistoryCard`。当天无数据时显示“所选日期没有 Claude 指纹检测记录”，搜索或风险过滤导致无结果时显示“当前筛选条件没有匹配记录”。

- [ ] **Step 3: 保持筛选和选择状态**

选择历史后只关闭 drawer，不重置日期、风险、搜索或当前渠道筛选。删除当前记录后 refetch 当前日期范围，并清空已删除详情。

- [ ] **Step 4: 运行日期工具测试与构建**

Run:

```bash
cd frontend
npm test -- src/claudeFingerprintHistory.test.ts src/api.test.ts
npm run build
```

Expected: PASS。

### Task 8: 全量回归、浏览器视觉验证与文档更新

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-13-claude-fingerprint-probe-detail.md`（勾选完成项）

- [ ] **Step 1: 更新 README 的 Claude 指纹说明**

补充：Web Search 是能力参考且使用 server tool 证据判定；警告可展开查看完整已脱敏原因；历史支持按日查看；身份自报为弱信号。

- [ ] **Step 2: 运行后端全量测试**

Run:

```bash
cd backend
python -m pytest -q
```

Expected: PASS，无失败和未处理 warning。

- [ ] **Step 3: 运行前端全量测试与生产构建**

Run:

```bash
cd frontend
npm test
npm run build
```

Expected: 全部 PASS，Vite build 成功。

- [ ] **Step 4: 启动本地服务并做视觉验证**

启动后端与前端：

```bash
cd backend
AUTO_SCHEDULER_ENABLED=false uvicorn app.main:app --port 8000
```

```bash
cd frontend
npm run dev
```

在浏览器打开 `/claude-code-check`，使用已有历史或确定性测试数据验证：

- Web Search 官方成功证据显示“通过”。
- unsupported 显示“跳过”，工具错误/证据缺失显示“警告”。
- 警告行展开后可见原因、HTTP、错误、请求快照和原始证据。
- 历史抽屉默认最近 7 天，可选单日/范围，并按日期显示统计。
- 身份两项出现在行为分组且权重为 weak。
- 1440px 与较窄桌面宽度下表格、展开区和抽屉无重叠或不可读文本。

- [ ] **Step 5: 检查敏感信息和工作区状态**

Run:

```bash
rg -n "sk-[A-Za-z0-9]" backend frontend docs -g '!frontend/node_modules' -g '!frontend/dist' -g '!*.db'
git diff --check
git status --short
```

Expected: 不出现真实凭据；`git diff --check` 无输出；只包含本任务预期文件。

- [ ] **Step 6: 使用 verification-before-completion 完成最终审计**

逐条对照设计文档的完成标准，记录 Web Search、警告详情、每日历史、身份探针、旧历史兼容和密钥脱敏各自的测试/运行证据，确认无缺项后再声明完成。
