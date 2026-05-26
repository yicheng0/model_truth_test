# AGENTS.md

This file is the first-read development guide for coding agents working in this repository. Keep changes aligned with the project facts below before writing code.

## Project Snapshot

This repository is a Claude channel authenticity and quality evaluation platform MVP. It compares multiple Claude access channels under the same test suite, request parameters, and run settings, then produces evidence-based risk ratings instead of claiming a simple 100% true/false verdict.

Current implementation:

- Frontend: React 19, TypeScript, Vite, React Router, TanStack Query, Ant Design, Recharts, lucide-react.
- Backend: FastAPI, SQLAlchemy 2.x, Pydantic v2, httpx, boto3, pytest.
- Storage: SQLite by default for local development, PostgreSQL through Docker Compose.
- Built-in seed data includes the `claude_full_35` test suite. The ID is historical; the current built-in suite contains 32 representative cases.
- Channel roles include Anthropic gold baseline, official cloud references, candidate third-party channels, and negative samples.
- Mock mode is supported and must keep working without real API keys.
- Runtime API keys are passed per run and must not be persisted.
- Reports are generated as Markdown and are evidence summaries, not absolute truth claims.

## Core Product Rules

- Anthropic official API is the gold baseline.
- AWS Bedrock Claude and Azure/Microsoft Foundry Claude are official cloud reference channels. They may differ from Anthropic direct API, so treat them as a reference band rather than exact duplicates.
- Third-party aggregators, proxies, and OpenAI-compatible Claude endpoints are candidate channels under evaluation.
- Negative sample channels are allowed for calibration when the goal is to verify that tests can distinguish non-Claude behavior.
- Do not judge authenticity from model self-identification alone. Combine protocol fields, stream shape, stop reasons, usage metadata, tool-use structure, latency, repeatability, content similarity, safety style, and ability fingerprints.
- Phrase conclusions as risk and confidence ratings such as highly consistent, usable with proxy traces, suspicious downgrade, or likely non-Claude.

## Implementation Rules

- Prefer the existing project structure over large reorganizations. The current backend is mostly in `backend/app/main.py`, `backend/app/models.py`, `backend/app/schemas.py`, `backend/app/services.py`, and `backend/app/suite_seed.py`.
- Keep frontend API access centralized in `frontend/src/api.ts` and shared domain shapes in `frontend/src/types.ts`.
- New frontend code should use the current React Query + Ant Design patterns already used by the pages.
- New backend endpoints should follow the existing FastAPI/Pydantic response-model style and preserve compatibility with existing routes.
- Use `/api/runs` as the primary run API. Existing `/api/eval-runs` routes are compatibility aliases and should not be broken casually.
- Keep mock execution deterministic enough for tests and local demos.
- Do not remove SQLite local development support while adding or adjusting PostgreSQL behavior.
- Do not introduce a queue, Redis, Celery, Alembic, authentication system, or major service split unless the task explicitly asks for that migration.
- Do not edit generated/vendor/build artifacts such as `frontend/node_modules`, `frontend/dist`, Python `__pycache__`, `.pytest_cache`, or Playwright output unless the task is explicitly about those artifacts.

## Security And Data Rules

- API keys and provider credentials must be runtime-only. Do not store them in the database, generated reports, logs, screenshots, or seeded fixtures.
- Raw requests and raw responses are useful evidence, but they must not include secrets.
- Error messages should preserve enough detail for diagnosis without leaking credentials.
- When using real provider calls, provider/model availability and API details may have changed since the planning documents. Verify against current official provider docs before changing live-call behavior.
- Avoid test prompts or fixtures that request illegal harmful content. Safety tests should focus on public, policy, historical, or ethics-style boundary behavior.

## UI And UX Rules

- This is an evaluation backend console, not a marketing site.
- Keep pages dense, calm, and scannable: tables, filters, status tags, compact summaries, charts, and side-by-side comparisons are preferred.
- Compare views should prioritize differences, evidence, raw response traceability, scoring, labels, and progress state.
- Cards are acceptable for repeated summaries such as channels, cases, reports, and metrics, but avoid decorative nested-card layouts.
- Preserve role color semantics where possible: gold baseline, official cloud reference, candidate, negative sample, trusted, warning, and high-risk states should remain visually distinct.
- Do not add explanatory marketing copy when a direct workflow or data view is more useful.

## Commands

Docker Compose:

```powershell
docker compose up --build
```

Local backend:

```powershell
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
python -m pytest
```

Local frontend:

```powershell
cd frontend
npm install
npm run dev
npm test
npm run build
```

Default local backend database is `backend/claude_eval.db` when `DATABASE_URL` is not set. For Docker Compose, PostgreSQL is exposed through the composed services.

## Testing Methodology

The platform evaluates channels through an evidence chain rather than a single indicator. Important dimensions include:

- Protocol consistency: response structure, message id format, model field, usage metadata, and stop reason behavior.
- Streaming consistency: SSE event order, first-token latency, and presence of Claude-style stream events.
- Parameter enforcement: `max_tokens`, `stop_sequences`, and low-temperature repeatability.
- Thinking/reasoning mode: valid thinking blocks and correct structure when extended thinking is enabled.
- Tool use: tool schema compliance, `tool_use` id format, and JSON parameter structure.
- Identity self-report: stable acknowledgment of Claude/Anthropic identity without fabricated deployment details.
- Capability fingerprint: logic, code, long-context, and multi-constraint task performance compared to official baselines.
- Knowledge boundaries: appropriate uncertainty and temporal-boundary handling.
- Safety/sensitive style: refusal boundaries, clarification patterns, and tone consistency.
- Stability and cost: latency distribution, failure rate, token statistics, and multi-turn consistency.

Default scoring is 100 points. Preserve the approximate weighting order: Anthropic gold baseline consistency, official cloud reference-band consistency, protocol credibility, streaming behavior, parameter adherence, tool-use consistency, capability performance, multi-turn stability, and operational anomalies.

Candidate channel grades:

- A, 90-100: highly consistent with gold and official cloud references.
- B, 80-89: generally trustworthy with possible minor relay artifacts.
- C, 65-79: suspicious parameter rewriting, downgrade, or middleware interference.
- D, 50-64: likely non-native Claude or major protocol drift.
- E, 0-49: high risk and not suitable to market as Claude-equivalent.

## Channel Classification

Every channel has one role per run. Roles drive scoring math and report framing.

| Role | Examples | Purpose |
|---|---|---|
| `gold` | Anthropic official API | Primary baseline for similarity and behavior comparison |
| `official_cloud` | AWS Bedrock Claude, Azure/Microsoft Foundry Claude, optional Vertex AI | Reference band; may legitimately differ from Anthropic direct |
| `candidate` | Third-party relays, aggregators, OpenAI-compatible Claude endpoints, private proxies | Channel under evaluation |
| `negative` | GPT, Gemini, Qwen, DeepSeek, other non-Claude models | Calibrates test discriminability |

## Test Suite Modules

The `claude_full_35` seed covers these modules. New suites should follow the same module taxonomy so scoring rules stay portable.

| Module | Focus | Typical detection targets |
|---|---|---|
| `identity` | Self-reported identity and channel awareness | Fabricated environment claims, wrong vendor, unreliable header claims |
| `protocol` | Response JSON shape | Missing/forged `id`, `model`, `stop_reason`, `usage` fields; OpenAI-shaped payloads |
| `streaming` | SSE event structure | Missing `message_start` / `content_block_delta` / `message_stop`, out-of-order events |
| `truncation` | `max_tokens` and `stop_sequences` enforcement | Relay rewriting past the limit, wrong stop reason |
| `tool_use` | Tool-call block structure | Invalid `tool_use` id format, malformed JSON args, skipped tool calls |
| `capability` | Reasoning, code, long-form tasks | Quality regression vs. gold, different error modes |
| `knowledge` | Time-bounded facts and knowledge edges | Wrong cutoff, fabricated recent events, overconfident future claims |
| `safety` | Policy, ethics, and sensitive-topic style | Over-refusal, sycophancy, style drift from Claude |
| `context` | Multi-turn memory and constraint following | Dropped facts, distractor contamination, format violations |

## Evidence-Based Judgment

Model self-identification is a weak signal. Never let "I am Claude" override protocol or capability evidence. Combine these signals instead:

- HTTP status and error schema.
- Response `id` prefix and shape, including `msg_` for Anthropic messages and `toolu_` for tool-use ids.
- `model` field consistency with the requested model.
- `stop_reason` and `stop_sequence` correctness.
- `usage.input_tokens` and `usage.output_tokens` presence and sanity.
- Stream event order, first-token latency, and total latency.
- `tool_use` block structure and id stability.
- `max_tokens` and `stop_sequences` enforcement.
- Multi-turn context retention and constraint following.
- Capability-fingerprint task quality.
- Safety/refusal style and tone.
- Repeatability across at least three attempts when practical.

Run comparisons in three layers:

1. Hard protocol comparison: status code, JSON schema, id prefix, `model`, `stop_reason`, `usage`, stream event order, and `tool_use` shape.
2. Behavioral comparison: repeat cases, treat official channels as reference distributions, and compare semantic similarity, key point coverage, and error types.
3. Statistical comparison: latency mean/P95, first-token latency, failure rate, token usage skew, truncation adherence rate, and multi-turn consistency rate.

## Quick-Check Mode

A low-cost screening mode compresses the full suite into three probes, run three times per candidate:

1. Identity plus protocol probe: strict JSON reply with identity/provider/risk fields.
2. Reasoning plus code-comprehension probe: trace-and-explain task with known edge cases.
3. Long-context plus constraint-following probe: strict output format and forbidden phrasing.

Quick-check result vocabulary:

- `high_risk`: any run clearly below both official baselines, or any non-Claude identity leak.
- `suspicious`: minor regression, style drift, or protocol anomaly without decisive evidence.
- `no_issues_this_round`: all runs match official baselines. This does not prove the channel is clean; it only means the sample surfaced nothing.

Quick-check reports must state that a clean three-loop round does not prove the channel is free of routing mixing or sporadic downgrade.

## Anomaly Labels

Scorers should attach stable labels so trend analysis works across runs:

- `protocol_mismatch`: response schema deviates from Claude Messages API.
- `model_name_mismatch`: returned `model` disagrees with requested model.
- `usage_missing`: token accounting is absent or obviously wrong.
- `streaming_event_missing`: required SSE events are absent.
- `max_tokens_not_enforced`: truncation is ignored by upstream.
- `tool_use_invalid`: tool-use block is malformed or missing an id.
- `context_loss`: multi-turn facts are dropped or contaminated.
- `style_drift`: tone, refusal style, or phrasing clearly drifts.
- `quality_regression`: capability score is well below the official band.
- `latency_outlier`: latency deviates sharply from the band.
- `suspected_cache`: answers look cached or replayed.
- `suspected_model_swap`: behavior suggests a different underlying model.

## Report Writing Conventions

- Markdown reports are evidence summaries, not absolute verdicts.
- Prefer "highly consistent", "usable with proxy traces", "suspected downgrade", and "likely non-Claude".
- Avoid absolute or legal-sounding claims like "fake", "fraudulent", "verified genuine", or "100% authentic".
- Every conclusion line must be traceable to recorded evidence such as protocol fields, streaming events, similarity numbers, latency stats, or labeled anomalies.
- Do not include API keys, auth headers, or credential material in report bodies. Strip sensitive headers before rendering raw request/response blocks.

## Cost And Safety Guardrails

- Per-channel daily token caps and per-run cost estimates prevent runaway spend; keep these hooks in place when adjusting the runner.
- Mock mode must stay deterministic enough for CI, local demos, and the full seed flow without real keys.
- Test prompts should target public policy, historical, and ethics boundaries, not illegal or harmful content generation.
- Knowledge-edge prompts rot quickly; flag suite maintenance when adding time-sensitive cases.
- The hidden-test portion of any suite must be rotatable without breaking public suite fixtures.

## Source Of Truth

- Treat `README.md` and current code as the first source for implemented behavior.
- Treat planning Markdown files as product and methodology context, not proof that proposed future modules already exist.
- When documents conflict with code, inspect the current code and `README.md` first.
- When changing provider-specific behavior, verify against current official provider documentation before implementation.
