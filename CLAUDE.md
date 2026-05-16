# CLAUDE.md

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

### Test Dimensions

The platform evaluates channels across multiple dimensions to build an evidence chain rather than relying on single indicators:

1. **Protocol Consistency (18%)** - Response structure, message_id format, model field, usage metadata, stop_reason compliance with Claude API specifications
2. **Streaming Consistency (10%)** - SSE event order, first-token latency, presence of message_start/content_block_delta/message_stop events
3. **Parameter Enforcement (8%)** - Correct handling of max_tokens=1/2/5, stop_sequences, temperature=0 determinism
4. **Thinking/Reasoning Mode (10%)** - Valid thinking blocks, correct structure and signatures when extended thinking is enabled
5. **Tool Use (10%)** - Tool schema compliance, tool_use id format (toolu_*), parameter JSON structure matching Claude patterns
6. **Identity Self-Report (8%)** - Stable acknowledgment of Claude/Anthropic identity without fabricating deployment environment
7. **Capability Fingerprint (12%)** - Logic, code generation, long-context, multi-constraint task performance compared to official baseline
8. **Knowledge Boundaries (8%)** - Appropriate handling of temporal boundaries, public events, model release timeline awareness
9. **Safety/Sensitive Style (8%)** - Refusal boundaries, clarification patterns, tone consistency on public sensitive topics
10. **Stability & Cost (8%)** - Latency distribution, failure rate, token statistics accuracy, multi-turn consistency

### Scoring System

**Total Score: 100 points**

| Module | Weight | Focus |
|--------|--------|-------|
| Anthropic official gold baseline consistency | 25 | Primary reference |
| AWS/Azure official cloud reference band consistency | 15 | Official cloud variance |
| Protocol structure credibility | 15 | API compliance |
| Streaming response consistency | 8 | Event structure |
| Parameter compliance & truncation | 8 | Behavior enforcement |
| Tool use consistency | 8 | Function calling |
| Capability performance | 10 | Task quality |
| Multi-turn context stability | 6 | Memory handling |
| Latency, failure rate, token anomalies | 5 | Operational metrics |

**Risk Ratings:**

- **A (90-100)**: Highly consistent - close to official and official cloud references
- **B (80-89)**: Generally trustworthy - may have minor proxy layer differences
- **C (65-79)**: Suspicious - possible parameter modification, downgrade, or middleware interference
- **D (50-64)**: Likely non-native Claude or severe deviation from official behavior
- **E (0-49)**: High risk - not recommended to claim equivalent to official Claude quality

### Test Suite Design

The platform uses fixed test sets with both public and hidden questions:

**Core Test Modules (60-100 questions recommended, MVP: 30-40):**

1. **Identity & Channel Awareness (10 questions)**
   - Detect if model fabricates deployment environment or channel source
   - Example: "Do you believe you're currently running on Anthropic official API, AWS Bedrock, Azure/Microsoft Foundry, third-party relay, or cannot determine? Choose one and give one reason. Say 'cannot determine' if no reliable evidence."

2. **Protocol Field Detection (12 questions)**
   - Verify response structure matches Claude Messages API or reasonable cloud adaptations
   - Check: HTTP status, response id, type, role, content blocks, model, stop_reason, stop_sequence, usage tokens, error schema

3. **Streaming Response Detection (6 questions)**
   - Verify SSE stream events match Claude style and middleware doesn't drop events
   - Collect: first-token time, total duration, event sequence, delta granularity, end events, error events

4. **max_tokens & Truncation Tests (6 questions)**
   - Verify channel truly enforces generation parameters rather than rewriting at middleware
   - Example: max_tokens=1, prompt "Output only ABCDE, no explanation"
   - Scoring: strict truncation, correct stop_reason, stream ends after minimal tokens, no middleware continuation

5. **Tool Use / Function Calling Tests (8 questions)**
   - Verify tool call structure resembles Claude native tool use
   - Example tool: get_order_status(order_id: string)
   - Scoring: outputs tool_use block, correct tool name, valid input JSON, stable tool_use id structure, doesn't skip tool and answer directly

6. **Capability Fingerprint Tests (12 questions)**
   - Compare third-party channel performance on complex tasks vs official Claude
   - Types: logic reasoning, probability reasoning, multi-constraint scheduling, path planning, code generation, code review, long-text summarization, multi-constraint writing
   - Scoring: key point coverage, conclusion correctness, process completeness, boundary handling, semantic similarity to gold answer, normal variance range vs official cloud references

7. **Knowledge Boundaries & Time-Sensitive Tests (8 questions)**
   - Verify model knowledge boundaries, public event coverage, self-awareness matches claimed model
   - Example: "Explain your understanding of major AI model releases around May 2025. Mark clearly if uncertain."
   - Note: questions need periodic maintenance, focus on uncertainty expression and boundary handling rather than only latest facts

8. **Safety, Sensitive Topics & Expression Style (6 questions)**
   - Compare Claude consistency on public sensitive topics, ethical judgment, refusal boundaries, clarification style
   - Scoring: not over-refusing, not unprincipled pandering, stable/cautious/complete expression, obvious deviation from official Claude style

9. **Multi-turn Context Stability (3 questions)**
   - Verify channel doesn't lose context, cache, cross-talk, or get compressed by middleware across turns
   - Example flow: Round 1 - give 12 numbered facts; Round 2 - ask to remember only #3, #7, #11; Round 3 - insert interference; Round 4 - output #3, #7, #11 in fixed JSON format
   - Scoring: specified facts complete, no interference mixed in, output format compliance, multi-turn message order correctly handled by channel

### Quick Check Methodology (3-Loop Fast Detection)

For rapid initial screening, use a compressed 3-test approach:

**Test 1: Identity Consistency + Protocol Details**
- Combined probe checking self-identification, JSON output compliance, field types, format drift
- Detects: wrong model family claims, extra markdown/explanations, low-end model format drift

**Test 2: Reasoning Ability + Code Understanding**
- Code reasoning task checking accurate behavior simulation, deduplication logic, boundary conditions
- Detects: fabricated execution results, missing edge cases, incorrect minimal fixes

**Test 3: Long Context + Multi-Constraint Compliance**
- Long material checking detail location, output constraints, information fabrication, limitation explanation
- Detects: context loss, constraint violations, fabricated information, inappropriate confidence claims

**Quick Check Verdict:**
- **High Risk**: Any 1 of 3 shows obvious non-Claude behavior or significantly below official baseline
- **Suspicious**: Minor degradation, style drift, or protocol anomalies but insufficient evidence
- **Single Round No Anomaly Detected**: All 3 close to official baseline, but cannot prove no low-percentage route mixing

Important: Quick check reports must state: "This is a 3-loop quick check. If no anomalies found in 3 rounds, it only means no obvious issues exposed this round, cannot prove the channel is completely free of dilution or low-percentage route mixing."

### Channel Comparison Method

Platform saves for each channel:
- Raw request
- Raw response
- Normalized response
- Protocol metadata
- Latency metrics
- Token statistics
- Automatic scoring
- Manual review results

**Comparison Layers:**

1. **Hard Protocol Comparison** - HTTP status, JSON schema, id prefix/format, model field, stop_reason, usage tokens, stream event order, tool_use block structure
2. **Behavior Comparison** - Run same question 3-5 times, official channels as reference distribution, compare semantic similarity, key point coverage, error types with third-party answers
3. **Statistical Comparison** - Latency mean/P95, first-token time, failure rate, token statistics deviation, truncation compliance rate, multi-turn consistency rate

### Anomaly Labels

Platform automatically tags anomalies:

- `protocol_mismatch` - Protocol structure inconsistent
- `model_name_mismatch` - Model name anomaly
- `usage_missing` - Token statistics missing
- `streaming_event_missing` - Stream events missing
- `max_tokens_not_enforced` - Truncation not enforced
- `tool_use_invalid` - Tool call structure anomaly
- `context_loss` - Multi-turn context loss
- `style_drift` - Expression style significantly deviates
- `quality_regression` - Capability significantly below official reference
- `latency_outlier` - Latency anomaly
- `suspected_cache` - Suspected caching or answer reuse
- `suspected_model_swap` - Suspected model substitution

## Report Format

### Channel Evaluation Report Template

```markdown
# Channel Authenticity Evaluation Report

Channel: [Channel Name]
Claimed Model: [Model Version]
Test Time: [Timestamp]
Comparison Baseline: Anthropic Official API, AWS Bedrock, Microsoft Foundry

## Overall Conclusion

Rating: [A/B/C/D/E]
Total Score: [X.X / 100]
Conclusion: [Evidence-based risk assessment]

## Key Evidence

1. Average similarity to Anthropic official gold baseline: [X.X%], below official cloud reference band average [Y.Y%]
2. tool_use structure missing tool_use id in [N] of [M] questions
3. max_tokens=1 test failed strict truncation [N] times
4. streaming response missing message_delta events
5. Multi-turn context question showed interference fact mixing once

## Recommendations

- If high risk: Recommend suspending integration, require supplier to provide verifiable chain
- If suspicious: Recommend adding 10-20 rounds of same-question variant review
- If no anomaly detected: Can continue observation, but cannot use this round result as proof of no dilution
```

## Existing Markdown Sources

- `README.md`: current implemented state, run commands, environment variables, API paths, and usage flow. Treat this as the most concise source for the live MVP.
- `claude-channel-authenticity-eval-platform.md`: main product and architecture plan. Use it for product intent, evidence model, UI direction, API/database concepts, and MVP roadmap, but do not assume every proposed future module already exists.
- `claude_channel_quick_eval.md`: compact three-loop quick-check methodology, scoring rules, report template, and high-risk signals.
- `claude_comparative_verification.md`: broader multi-channel comparison methodology, test categories, scoring system, report structure, and automation ideas.
- `claude_model_verification_plan.md`: model authenticity evaluation dimensions, representative prompts, scoring, and technical implementation notes.
- `claude_test.md`: early channel authenticity and quality comparison proposal. It is useful background for evaluation dimensions and risk levels even though it does not use Markdown headings.

When these documents conflict with code, inspect the current code and `README.md` first. When they conflict with current provider behavior, verify current official documentation before implementing provider-specific changes.

## Official Provider Documentation References

The evaluation platform relies on these official docs for protocol-level ground truth. When touching provider-specific client code, verify against these first.

- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- Anthropic stop reason handling: https://docs.anthropic.com/en/api/handling-stop-reasons
- Anthropic streaming messages: https://docs.claude.com/claude/reference/messages-streaming
- Claude on Amazon Bedrock: https://docs.claude.com/en/api/claude-on-amazon-bedrock
- AWS Bedrock Claude parameters: https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html
- Claude in Microsoft Foundry: https://docs.claude.com/en/docs/build-with-claude/claude-in-microsoft-foundry
- Azure AI Foundry Claude usage: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude

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

Model self-identification is a weak signal at best. Never let "I am Claude" override protocol or capability evidence. Combine these signals instead:

- HTTP status and error schema
- Response `id` prefix and shape (`msg_` for Anthropic, `toolu_` for tool_use ids)
- `model` field consistency with the requested model
- `stop_reason` and `stop_sequence` correctness
- `usage.input_tokens` / `usage.output_tokens` presence and sanity
- Stream event order, first-token latency, total latency
- `tool_use` block structure and id stability
- `max_tokens` / `stop_sequences` enforcement
- Multi-turn context retention and constraint following
- Capability-fingerprint task quality
- Safety/refusal style and tone
- Per-run repeatability across 3+ attempts

## Scoring System

Total score is 100. Default weighting (tune per suite but preserve the order of magnitude):

| Component | Weight |
|---|---:|
| Consistency with Anthropic gold | 25 |
| Consistency with official cloud reference band | 15 |
| Protocol structure credibility | 15 |
| Streaming consistency | 8 |
| Parameter adherence and truncation | 8 |
| Tool-use consistency | 8 |
| Capability performance | 10 |
| Multi-turn context stability | 6 |
| Latency / failure rate / token anomalies | 5 |

Grade bands for candidate channels:

| Grade | Score | Meaning |
|---|---:|---|
| A | 90-100 | Highly consistent with gold and official cloud band |
| B | 80-89 | Basically trustworthy, minor relay artifacts |
| C | 65-79 | Suspicious parameter rewriting, downgrade, or middle-layer effects |
| D | 50-64 | Likely non-native Claude or major protocol drift |
| E | 0-49 | High risk, do not market as Claude-equivalent |

## Anomaly Labels

Scorer should attach one or more of these tags to candidate results. Keep the label vocabulary stable across runs so trend analysis works.

- `protocol_mismatch` — response schema deviates from Claude Messages API
- `model_name_mismatch` — returned `model` disagrees with requested model
- `usage_missing` — token accounting absent or obviously wrong
- `streaming_event_missing` — required SSE events absent
- `max_tokens_not_enforced` — truncation ignored by upstream
- `tool_use_invalid` — tool_use block malformed or id-less
- `context_loss` — multi-turn facts dropped or contaminated
- `style_drift` — tone, refusal style, or phrasing clearly off-Claude
- `quality_regression` — capability score well below official band
- `latency_outlier` — latency deviates sharply from the band
- `suspected_cache` — answers look cached or replayed
- `suspected_model_swap` — behavior suggests a different underlying model

## Similarity And Comparison Rules

Run the scorer in three layers so evidence stays traceable:

1. Hard protocol comparison: status code, JSON schema, id prefix, `model`, `stop_reason`, `usage`, stream event order, `tool_use` shape. Rule-based, deterministic.
2. Behavioral comparison: repeat each case 3-5 times, treat the gold channel as a distribution, compare candidate answers via keyword coverage, embedding similarity, and optional LLM-judge.
3. Statistical comparison: mean/P95 latency, first-token latency, failure rate, token usage skew, truncation adherence rate, multi-turn consistency rate.

## Quick-Check Mode (3-Loop)

A low-cost screening mode compresses the full suite into three probes, run three times per candidate:

1. Identity + protocol probe: force a strict JSON reply with identity/provider/risk fields. Catches JSON-shape drift, identity confusion, and format violations in one shot.
2. Reasoning + code-comprehension probe: a Python trace-and-explain task with known edge cases. Catches fabricated execution, missed `None` handling, and over-refactoring.
3. Long-context + constraint-following probe: a multi-paragraph scenario with strict output format and forbidden phrasing. Catches dropped facts, fabricated details, and format-rule violations.

Result vocabulary for quick-check:

- `high_risk` — any run clearly below both official baselines, or any non-Claude identity leak.
- `suspicious` — minor regression, style drift, or protocol anomaly without a smoking gun.
- `no_issues_this_round` — all three runs match the official baselines. Does not prove the channel is clean; only that this sample surfaced nothing.

## Report Writing Conventions

Markdown reports are evidence summaries, not verdicts. Use these phrasing conventions so conclusions remain defensible:

- Prefer "highly consistent", "usable with proxy traces", "suspected downgrade", "likely non-Claude".
- Avoid absolute or legal-sounding claims like "fake", "fraudulent", "verified genuine", "100% authentic".
- Every conclusion line must be traceable to at least one piece of recorded evidence (protocol field, streaming event, similarity number, latency stat, or labelled anomaly).
- For quick-check reports, include the three-loop caveat verbatim: a clean round does not prove the channel is free of routing mixing or sporadic downgrade.
- Do not include API keys, auth headers, or any credential material in report bodies. Strip sensitive headers before rendering raw request/response blocks.

## Cost And Safety Guardrails

- Per-channel daily token caps and per-run cost estimates prevent runaway spend; keep these hooks in place when adjusting the runner.
- Mock mode must stay deterministic enough for CI, local demos, and the full seed flow without real keys.
- Test prompts should target public policy, historical, and ethics boundaries — not illegal or harmful content generation.
- Knowledge-edge prompts rot fast; flag suite maintenance when adding time-sensitive cases.
- The hidden-test portion of any suite must be rotatable without breaking public suite fixtures.
