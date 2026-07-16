# Claude Code Origin Differentiation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish ordinary Claude API compatibility from Claude Code gateway compatibility and translated/reverse-proxy behavior without claiming that transparent forwarding can be uniquely identified.

**Architecture:** Add a dedicated gateway-contract probe layer next to the existing model-response probes. The layer performs safe requests using Claude Code-specific request headers/body structure and optional discovery/token-count endpoints, records only redacted request/response metadata, and produces a separate `access_path_assessment` rather than changing the base Claude authenticity score.

**Tech Stack:** FastAPI, SQLAlchemy, httpx, pytest, React 19, TypeScript, Ant Design, Vitest.

---

### Task 1: Lock the classification boundary with failing tests

**Files:**
- Modify: `backend/tests/test_api.py`

- [ ] Add tests proving that direct `api.anthropic.com` is `anthropic_api_direct`, a custom host with Claude Code contract evidence is `claude_code_gateway_like`, OpenAI translation evidence is `translated_gateway`, and a custom host with only normal Messages responses is `transparent_unresolved`.
- [ ] Run `python -m pytest tests/test_api.py -k "access_path_assessment" -q` and confirm RED.

### Task 2: Add Claude Code gateway-contract probes

**Files:**
- Modify: `backend/app/services.py`
- Modify: `backend/app/schemas.py`

- [ ] Add safe probe helpers for Claude Code request headers, attribution system block, `/v1/messages/count_tokens`, and optional `/v1/models?limit=1000` discovery.
- [ ] Keep credential values redacted and persist only header names, status, request IDs, body-field names, and bounded error excerpts.
- [ ] Add `access_path_assessment`, `access_path_label`, `access_path_reason`, and `access_path_evidence` to result payloads.
- [ ] Run the new backend tests and existing Claude fingerprint tests; confirm GREEN.

### Task 3: Present access-path evidence separately in Claude Fingerprint

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/ClaudeCodeCheck.tsx`
- Modify: `frontend/src/claudeFingerprintSpec.ts`
- Modify: `frontend/src/claudeFingerprintSpec.test.ts`

- [ ] Add failing tests for the new assessment vocabulary and transparent-forwarding caveat.
- [ ] Add an access-path summary next to Claude/ClaudeCode scores and an evidence table showing client headers, attribution, token count, model discovery, and translation traces.
- [ ] Make the page explicitly state that transparent OAuth/API forwarding cannot be distinguished from direct upstream by response-only probes.
- [ ] Run frontend tests and build; confirm GREEN.

### Task 4: Verify and document

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-15-claude-official-reverse-fingerprint-spec.md`

- [ ] Add current official Gateway Protocol findings and public translation-proxy observations.
- [ ] Run backend and frontend full suites, production build, secret scan, and browser visual verification.
