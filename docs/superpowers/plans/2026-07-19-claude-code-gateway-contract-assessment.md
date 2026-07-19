# Claude Code Gateway Contract Assessment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evidence-based Claude Code gateway contract assessment that classifies response-error wrapping, SSE buffering, model-alias capability mismatch, attribution observability, and usage-comparison boundaries without changing Claude authenticity or official-origin conclusions.

**Architecture:** Extend the existing deep integrity probes with richer response-shape and stream timing evidence, then derive a separate `gateway_contract` summary from both standard and deep probe rows. Keep the summary inside `upstream_integrity`, display it independently in the Claude Code console, and treat every finding as gateway compatibility evidence rather than official-origin proof.

**Tech Stack:** FastAPI, Python 3.13, pytest, React 19, TypeScript, Ant Design, Vitest.

---

### Task 1: Define Gateway Contract Assessment

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`

- [ ] **Step 1: Write failing unit tests**

Add tests for `_claude_gateway_contract_assessment()` proving that it:

```python
def test_gateway_contract_assessment_classifies_contract_anomalies() -> None:
    result = _claude_gateway_contract_assessment(
        [
            {"key": "claude_code_headers", "status": "pass", "raw_evidence": {"request_header_names": ["anthropic-beta", "x-claude-code-session-id"]}},
            {"key": "claude_code_attribution", "status": "pass", "request_snapshot": {"system_block_count": 2, "attribution_first": True}},
            {"key": "parameter_error_matrix", "error_envelope_mismatch_count": 2, "alias_capability_mismatch_count": 1},
            {"key": "sse_lifecycle", "stream_buffered_count": 2},
            {"key": "usage_tokenizer_matrix", "usage_scope": "single_request"},
        ]
    )
    assert result["status"] == "warning"
    assert result["official_origin_confirmed"] is False
    assert result["labels"] == [
        "gateway_model_alias_capability_mismatch",
        "stream_buffered_by_gateway",
        "upstream_error_rewrapped",
    ]
```

Also test a clean contract and confirm attribution is reported as sent-but-unverified rather than claimed preserved.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_api.py -k gateway_contract_assessment -q
```

Expected: import failure because `_claude_gateway_contract_assessment` does not exist.

- [ ] **Step 3: Implement the minimal assessment helper**

Add a helper in `backend/app/services.py` returning:

```python
{
    "status": "pass" | "warning" | "insufficient_evidence",
    "labels": [...],
    "checks": [...],
    "evidence_refs": [...],
    "official_origin_confirmed": False,
    "interpretation": "...",
}
```

The helper must never retain API keys, authorization values, complete signatures, or full system prompts.

- [ ] **Step 4: Run tests and confirm GREEN**

Run the Task 1 test command and expect all selected tests to pass.

### Task 2: Record Error-Envelope and Alias-Capability Differences

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`

- [ ] **Step 1: Write failing response-shape tests**

Add tests proving `_integrity_response_shape()` records `error_message_family`, `error_envelope_native`, and returned model identity, and `_integrity_shapes_match()` rejects a candidate that wraps the same 400 as `{code, msg}` or returns a mismatched model alias.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_api.py -k 'integrity_response_shape or integrity_shapes_match' -q
```

Expected: assertions fail because the new fields and comparisons are absent.

- [ ] **Step 3: Implement richer shape comparison**

Normalize only stable error tokens such as `thinking`, `adaptive`, `output_config`, `tool_choice`, `max_tokens`, and `unknown field`; do not store full upstream error text. Count:

- `error_envelope_mismatch_count` when official uses the native Anthropic envelope but candidate does not.
- `alias_capability_mismatch_count` when an adaptive/effort case differs and the requested candidate model is an alias or its returned model differs.

- [ ] **Step 4: Verify GREEN**

Run the Task 2 tests and the existing parameter matrix tests.

### Task 3: Detect Buffered SSE

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`

- [ ] **Step 1: Write failing timing tests**

Add tests proving `_signature_messages_call()` preserves `first_event_ms` for streaming responses and `_integrity_stream_probe()` counts buffering only when candidate first-event latency is close to total latency and materially worse than the official reference.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_api.py -k 'signature_messages_call_stream_timing or integrity_stream_probe_buffer' -q
```

- [ ] **Step 3: Implement streaming transport timing**

Use `httpx.AsyncClient.stream()` in `_signature_messages_call()` when `payload.stream` is true, measure the first non-empty SSE `data:` chunk, preserve total latency separately, and add only numeric timing fields to metadata.

- [ ] **Step 4: Verify GREEN**

Run Task 3 tests plus existing SSE evidence tests.

### Task 4: Expose Contract Assessment in Result and UI

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/ClaudeCodeCheck.tsx`
- Modify: `frontend/src/claudeCodeDiagnostics.ts`
- Modify: `frontend/src/claudeCodeDiagnostics.test.ts`

- [ ] **Step 1: Write failing backend and frontend tests**

Assert `create_claude_code_test()` includes `upstream_integrity.gateway_contract`. Add label metadata tests for:

- `upstream_error_rewrapped`
- `stream_buffered_by_gateway`
- `gateway_model_alias_capability_mismatch`

- [ ] **Step 2: Verify RED**

Run focused backend pytest and frontend Vitest commands.

- [ ] **Step 3: Wire the assessment into results and UI**

Attach the assessment after standard probes and recompute it after deep probes. Extend the TypeScript type and show a compact alert below the existing gateway fingerprint with check status and labels. State explicitly that the assessment measures gateway contract preservation, not official origin.

- [ ] **Step 4: Verify GREEN**

Run focused backend and frontend tests.

### Task 5: Document and Verify

**Files:**
- Modify: `docs/claude-fingerprint-industry-research-and-api-diff.md`
- Create: `docs/claude-code-vs-claude-api-parameter-response-differences.md`

- [ ] **Step 1: Bring the two implementation documents into the branch**

Preserve the evidence boundary, add the `gateway_contract` result shape, and describe which findings are observable versus inherently unverified.

- [ ] **Step 2: Run complete verification**

```bash
cd backend
.venv/bin/python -m pytest
cd ../frontend
pnpm test
pnpm run build
```

Also run `git diff --check` and scan changed files for credential-like values.

- [ ] **Step 3: Review requirement coverage**

Confirm gateway headers, model discovery, count_tokens, attribution, error wrapping, SSE buffering, alias mismatch, and usage granularity remain separate from `official_origin_confirmed`, which must stay `false`.
