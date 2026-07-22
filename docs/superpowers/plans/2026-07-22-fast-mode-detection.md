# Claude Fast Mode Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evidence-based Fast mode compatibility assessment to the existing Claude Code fingerprint test without treating beta headers, service tiers, latency, or OAuth status as proof of official origin.

**Architecture:** Reuse the existing Claude Code probe runner and normalized provider response. Add pure statistical/classification helpers plus a bounded Standard/Fast probe pair, return a separate `fast_mode_assessment` field, and render it in the existing result view. Fast mode evidence is independent of the Claude authenticity score and is persisted only through the existing redacted result payload.

**Tech Stack:** FastAPI, Pydantic v2, pytest, React 19, TypeScript, Ant Design, Vitest.

---

### Task 1: Define backend Fast mode classification behavior

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`

- [ ] **Step 1: Write failing unit tests** for `fast_mode_assessment` classification covering: repeated latency improvement -> `fast_consistent`; accepted request without improvement -> `fast_downgrade_suspected`; explicit provider/model rejection -> `fast_unsupported_expected`; insufficient samples -> `fast_inconclusive`; beta header alone does not pass.
- [ ] **Step 2: Run the focused tests and confirm they fail** with the missing helper or missing assessment field.
- [ ] **Step 3: Implement pure helpers** that calculate P50 latency, token throughput, improvement ratios, and status using only normalized evidence; preserve the evidence boundary that `usage.service_tier` and `anthropic-beta` are not Fast proof.
- [ ] **Step 4: Run the focused tests and confirm they pass.**

### Task 2: Add bounded Standard/Fast probe execution and API evidence

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/app/services.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/main.py` only if request fields are required

- [ ] **Step 1: Write failing tests** for default fast mode assessment shape, redacted request/response evidence, model support checks, and `probe_depth=standard` using three paired samples without changing existing probe counts unexpectedly.
- [ ] **Step 2: Run the focused tests and confirm they fail.**
- [ ] **Step 3: Implement a bounded Fast mode runner** using the existing `invoke_channel` path, with configurable quick/deep sample counts, deterministic mock responses, and interleaved Standard/Fast execution. Record model, beta header names, service tier, optional speed, request id, latency, first-token latency, output token count, and fallback/error signals. Never persist credentials.
- [ ] **Step 4: Add `fast_mode_assessment` to the Pydantic read model** and include it in the `create_claude_code_test` result. Keep Fast labels out of `_claude_code_score` and `_claude_code_risk_level`.
- [ ] **Step 5: Run backend focused tests and the relevant existing Claude tests.**

### Task 3: Add frontend types and Fast mode evidence panel

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/ClaudeCodeCheck.tsx`
- Modify: `frontend/src/claudeCodeDiagnostics.ts` if label text is centralized there
- Modify: `frontend/src/claudeCodeDiagnostics.test.ts`

- [ ] **Step 1: Write failing frontend tests** for status/label mapping and rendering the Standard/Fast metrics without assuming `speed` or a stable beta header.
- [ ] **Step 2: Run the focused frontend tests and confirm they fail.**
- [ ] **Step 3: Add the `FastModeAssessment` TypeScript shape and a compact result panel** showing status, confidence, sample counts, P50/P95 metrics, improvement ratios, model consistency, fallback count, anomaly tags, and the official-origin caveat.
- [ ] **Step 4: Run focused frontend tests and confirm they pass.**

### Task 4: Verify and document behavior

**Files:**
- Modify: `README.md` or `docs/claude-code-vs-claude-api-parameter-response-differences.md` only if the implemented API shape needs documentation.

- [ ] **Step 1: Run backend test suite.**
- [ ] **Step 2: Run frontend tests and production build.**
- [ ] **Step 3: Review the diff for credential leakage, accidental base-score changes, and unsupported claims about OAuth, beta headers, or service tiers.**
- [ ] **Step 4: Report exact verification results and any remaining provider-dependent limitations.**
