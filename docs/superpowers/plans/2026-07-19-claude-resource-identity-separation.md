# Claude Resource Identity Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Claude model/API compatibility, Claude Code gateway compatibility, and locally verified Claude Code authentication so API-key and OAuth-backed resources no longer receive the same misleading “Claude Code resource” verdict.

**Architecture:** Remote relay tests remain response-only and produce model, gateway-contract, and upstream-integrity evidence. A new `resource_identity` assessment uses only caller-known connection metadata for remote tests, while the local Claude Code CLI check adds a sanitized `claude auth status --json` observation and explicitly records that its existing `--bare` sandbox run does not inherit OAuth/keychain credentials. Legacy fields remain readable but are marked deprecated and no longer drive the primary classification.

**Tech Stack:** FastAPI, Pydantic v2, Python subprocess/asyncio, pytest, React 19, TypeScript, Ant Design, Vitest.

---

### Task 1: Remote resource identity classification

**Files:**
- Modify: `backend/app/services.py`
- Test: `backend/tests/test_api.py`

- [ ] **Step 1: Write failing tests** for official endpoint + explicit API key, custom gateway credentials, signature-only evidence, and transparent unresolved routing.
- [ ] **Step 2: Run** `python3 -m pytest -q backend/tests/test_api.py -k resource_identity` and confirm failures because `resource_identity` is absent.
- [ ] **Step 3: Implement** `_claude_resource_identity_assessment` with classifications `anthropic_api_key_configured`, `gateway_credential_configured`, `cloud_provider_credentials`, and `insufficient_evidence`; always keep `claude_code_oauth_confirmed=false` for remote tests.
- [ ] **Step 4: Remove signature from Claude Code identity logic** by replacing `is_claude_code_like` with `claude_code_gateway_compatible`; retain `is_claude_code_like` only as a deprecated false compatibility field for historical consumers.
- [ ] **Step 5: Run focused backend tests** and confirm the official API and gateway no longer receive `classification_status=claude_code` from signature support.

### Task 2: Sanitized local CLI authentication evidence

**Files:**
- Modify: `backend/app/claude_code_check.py`
- Modify: `backend/app/schemas.py`
- Test: `backend/tests/test_claude_code_check.py`

- [ ] **Step 1: Write failing tests** for `oauth_token/firstParty`, API-key status, invalid JSON, and command failure; assert no token-like fields are returned.
- [ ] **Step 2: Run** `python3 -m pytest -q backend/tests/test_claude_code_check.py` and confirm failures on the missing auth evidence.
- [ ] **Step 3: Execute** `claude auth status --json` before the sandbox run, allowlist only `loggedIn`, `authMethod`, `apiProvider`, and compute `classification`, `confidence`, `evidence_source`.
- [ ] **Step 4: Add** `execution_auth_context` showing `bare_mode=true`, `oauth_used_by_probe=false`, and the documented limitation that `--bare` ignores OAuth/keychain.
- [ ] **Step 5: Extend Pydantic response schemas** without persisting tokens or credential values.

### Task 3: Frontend verdict separation and historical compatibility

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/ClaudeCodeCheck.tsx`
- Modify: `frontend/src/claudeFingerprintSpec.ts`
- Test: `frontend/src/claudeFingerprintSpec.test.ts`
- Test: `frontend/src/claudeCodeDiagnostics.test.ts`

- [ ] **Step 1: Write failing frontend tests** asserting resource identity labels do not derive from signature and legacy `is_claude_code_like` displays as compatibility, not source.
- [ ] **Step 2: Run** the focused Vitest files and confirm the new helpers/types are missing.
- [ ] **Step 3: Rename UI concepts** from “ClaudeCode 得分/链路” to “Claude Code 网关兼容度”; display resource identity as a separate card with evidence source and limitations.
- [ ] **Step 4: Keep historical payload support** by mapping old `claude_code` verdicts to “历史兼容判定（不代表资源来源）”.
- [ ] **Step 5: Add local CLI auth evidence display** only when returned by the local CLI endpoint.

### Task 4: Research and product boundary documentation

**Files:**
- Modify: `docs/claude-code-vs-claude-api-parameter-response-differences.md`
- Modify: `docs/claude-fingerprint-industry-research-and-api-diff.md`
- Modify: `README.md`

- [ ] **Step 1: Document official authentication precedence**: Claude.ai OAuth, Console/API key, cloud provider credentials, gateway credentials, and `ANTHROPIC_BASE_URL` without replacement credentials.
- [ ] **Step 2: Add a detection matrix** distinguishing caller-known configuration, local CLI evidence, response-only evidence, and control-plane confirmation.
- [ ] **Step 3: State that `--bare` excludes OAuth/keychain** and that local auth status cannot be projected onto an unrelated remote endpoint test.
- [ ] **Step 4: Document unsupported conclusions**: no response-only proof of API Key versus OAuth, no signature-based Claude Code resource verdict, and no credential-value persistence.

### Task 5: Verification and integration

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run** `python3 -m pytest -q` from `backend`.
- [ ] **Step 2: Run** frontend Vitest, TypeScript compilation, and Vite production build.
- [ ] **Step 3: Run** `git diff --check` and a secret scan for API keys, Authorization values, OAuth tokens, and complete signatures.
- [ ] **Step 4: Request code review**, fix all critical/important findings, and rerun affected tests.
- [ ] **Step 5: Merge into `main`, rerun final verification, push `origin/main`, and remove the worktree.
