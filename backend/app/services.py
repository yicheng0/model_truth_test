from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from .models import Channel, Comparison, Report, Result, Run, RunChannel, TestCase, TestSuite
from .schemas import ChannelCreate, RunCreate, TestCaseCreate, TestSuiteCreate
from .suite_seed import default_cases, default_suite


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    return SequenceMatcher(None, a or "", b or "").ratio()


def grade_from_score(score: float, labels: list[str] | None = None) -> str:
    red_flags = {"unsafe_response", "identity_mismatch", "tool_use_invalid", "max_tokens_not_enforced"}
    if labels and red_flags.intersection(labels):
        return "E" if score < 70 else "D"
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "E"


def create_channel(db: Session, data: ChannelCreate) -> Channel:
    channel = Channel(
        id=data.id or new_id("ch"),
        name=data.name,
        provider_type=data.provider_type,
        role=data.role,
        base_url=data.base_url,
        model_name=data.model_name,
        auth_config_encrypted=None,
        enabled=data.enabled,
    )
    db.add(channel)
    db.commit()
    db.refresh(channel)
    return channel


def create_suite(db: Session, data: TestSuiteCreate) -> TestSuite:
    suite = TestSuite(
        id=data.id or new_id("suite"),
        name=data.name,
        description=data.description,
        version=data.version,
        visibility=data.visibility,
    )
    db.add(suite)
    db.commit()
    db.refresh(suite)
    return suite


def create_case(db: Session, data: TestCaseCreate) -> TestCase:
    existing_orders = db.scalars(select(TestCase.sort_order).where(TestCase.suite_id == data.suite_id)).all()
    next_order = max([order for order in existing_orders if order is not None], default=0) + 1
    sort_order = data.sort_order if data.sort_order not in {None, 0, 1000} else next_order
    case = TestCase(
        id=data.id or new_id("tc"),
        suite_id=data.suite_id,
        module=data.module,
        sort_order=sort_order,
        title=data.title,
        prompt=data.prompt,
        system_prompt=data.system_prompt,
        request_params=data.request_params or {},
        scoring_rules=data.scoring_rules or {},
        is_hidden=data.is_hidden,
        enabled=data.enabled,
    )
    db.add(case)
    db.commit()
    db.refresh(case)
    return case


def seed_demo_data(db: Session) -> None:
    if not db.scalar(select(Channel).limit(1)):
        channels = [
            ChannelCreate(id="anthropic_official", name="Anthropic Official", provider_type="anthropic", role="gold", base_url="https://api.anthropic.com", model_name="claude-sonnet-4-5"),
            ChannelCreate(id="aws_bedrock", name="AWS Bedrock Claude", provider_type="aws_bedrock", role="official_cloud", base_url="bedrock-runtime", model_name="anthropic.claude-sonnet-4-5-v1:0"),
            ChannelCreate(id="azure_foundry", name="Azure AI Foundry Claude", provider_type="azure_foundry", role="official_cloud", base_url="https://example.services.ai.azure.com", model_name="claude-sonnet-4-5"),
            ChannelCreate(id="third_party_demo", name="Third-party Relay Demo", provider_type="third_party_anthropic", role="candidate", base_url="https://relay.example/v1", model_name="claude-sonnet-4-5"),
            ChannelCreate(id="openai_compat_demo", name="OpenAI-compatible Relay Demo", provider_type="third_party_openai_compatible", role="candidate", base_url="https://relay.example/v1", model_name="claude-sonnet-4-5"),
            ChannelCreate(id="negative_sample", name="Negative Sample", provider_type="third_party_openai_compatible", role="negative", base_url="https://non-claude.example/v1", model_name="gpt-like-model"),
        ]
        for channel in channels:
            create_channel(db, channel)

    if not db.scalar(select(TestSuite).where(TestSuite.id == default_suite()["id"])):
        create_suite(db, TestSuiteCreate(**default_suite()))
    case_by_id = {case.id: case for case in db.scalars(select(TestCase).where(TestCase.suite_id == default_suite()["id"])).all()}
    for case_data in default_cases():
        case = case_by_id.get(case_data["id"])
        if case is None:
            create_case(db, TestCaseCreate(**case_data))
            continue
        case.sort_order = case_data.get("sort_order", case.sort_order)
    db.commit()


def create_run(db: Session, data: RunCreate) -> Run:
    channel_ids_by_role = data.channel_ids or _default_channel_ids_by_role(db)
    selected_ids = [(channel_id, role) for role, ids in channel_ids_by_role.items() for channel_id in ids]
    cases = db.scalars(
        select(TestCase)
        .where(TestCase.suite_id == data.suite_id, TestCase.enabled.is_(True))
        .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
    ).all()
    run = Run(
        id=new_id("run"),
        suite_id=data.suite_id,
        name=data.name,
        status="pending",
        repeat_count=max(1, data.repeat_count),
        concurrency=max(1, data.concurrency),
        total_jobs=len(selected_ids) * len(cases) * max(1, data.repeat_count),
    )
    db.add(run)
    db.commit()
    for channel_id, role in selected_ids:
        db.add(RunChannel(id=new_id("rch"), run_id=run.id, channel_id=channel_id, role_in_run=role))
    db.commit()
    db.refresh(run)
    return run


def _default_channel_ids_by_role(db: Session) -> dict[str, list[str]]:
    result: dict[str, list[str]] = defaultdict(list)
    for channel in db.scalars(select(Channel).where(Channel.enabled.is_(True))).all():
        result[channel.role].append(channel.id)
    return dict(result)


async def execute_run(
    session_factory: sessionmaker[Session],
    run_id: str,
    runtime_credentials: dict[str, dict[str, Any]] | None = None,
    use_mock: bool = True,
) -> None:
    runtime_credentials = runtime_credentials or {}
    with session_factory() as db:
        run = db.get(Run, run_id)
        if not run:
            return
        try:
            run.status = "running"
            run.started_at = datetime.now(timezone.utc)
            db.commit()

            run_channels = db.scalars(select(RunChannel).where(RunChannel.run_id == run_id)).all()
            channel_by_id = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
            channels = [channel_by_id[rc.channel_id] for rc in run_channels if rc.channel_id in channel_by_id]
            cases = db.scalars(
                select(TestCase)
                .where(TestCase.suite_id == run.suite_id, TestCase.enabled.is_(True))
                .order_by(TestCase.sort_order, TestCase.module, TestCase.id)
            ).all()
            run.total_jobs = len(channels) * len(cases) * run.repeat_count
            run.completed_jobs = 0
            db.commit()

            semaphore = asyncio.Semaphore(max(1, run.concurrency))
            jobs = [
                (case, channel, attempt)
                for case in cases
                for channel in _sort_channels_for_run(channels)
                for attempt in range(1, run.repeat_count + 1)
            ]

            async def invoke_job(case: TestCase, channel: Channel, attempt: int) -> tuple[TestCase, Channel, int, dict[str, Any]]:
                async with semaphore:
                    normalized = await invoke_channel(channel, case, attempt, runtime_credentials.get(channel.id, {}), use_mock)
                    return case, channel, attempt, normalized

            pending = [asyncio.create_task(invoke_job(case, channel, attempt)) for case, channel, attempt in jobs]
            for task in asyncio.as_completed(pending):
                db.refresh(run)
                if run.status == "canceled":
                    for pending_task in pending:
                        pending_task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    run.finished_at = datetime.now(timezone.utc)
                    db.commit()
                    return

                case, channel, attempt, normalized = await task
                score, labels = score_result(channel, case, normalized)
                db.add(
                    Result(
                        id=new_id("res"),
                        run_id=run.id,
                        test_case_id=case.id,
                        channel_id=channel.id,
                        attempt_index=attempt,
                        normalized_response=normalized,
                        raw_request=normalized.get("raw_request"),
                        raw_response=normalized.get("raw_response"),
                        metrics={"latency_ms": normalized.get("latency_ms"), "first_token_ms": normalized.get("first_token_ms")},
                        score=score,
                        labels=labels,
                    )
                )
                run.completed_jobs += 1
                db.commit()

            build_comparisons(db, run.id)
            build_reports(db, run.id)
            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
        except Exception as exc:  # keep failed runs inspectable
            run.status = "failed"
            run.finished_at = datetime.now(timezone.utc)
            fallback_channel_id = db.scalar(select(RunChannel.channel_id).where(RunChannel.run_id == run.id)) or "anthropic_official"
            db.add(
                Report(
                    id=new_id("rep"),
                    run_id=run.id,
                    channel_id=fallback_channel_id,
                    final_score=0,
                    grade="E",
                    summary=f"检测任务失败：{exc}",
                    evidence={"error": str(exc)},
                    markdown=f"# 检测任务失败\n\n{exc}\n",
                )
            )
            db.commit()


def _sort_channels_for_run(channels: list[Channel]) -> list[Channel]:
    order = {"gold": 0, "official_cloud": 1, "candidate": 2, "negative": 3}
    return sorted(channels, key=lambda channel: (order.get(channel.role, 9), channel.name))


async def invoke_channel(channel: Channel, case: TestCase, attempt: int, credentials: dict[str, Any], use_mock: bool) -> dict[str, Any]:
    raw_request = build_raw_request(channel, case)
    if use_mock or not credentials:
        await asyncio.sleep(0.03)
        raw_response = simulate_raw_response(channel, case, attempt)
        latency_ms = 420 + len(case.prompt) * 2 + len(channel.name) * 7 + attempt * 13
        return normalize_response(channel, case, raw_request, raw_response, latency_ms, max(100, latency_ms // 3), None)

    started = time.perf_counter()
    try:
        raw_response = await _live_call(channel, case, raw_request, credentials)
        latency_ms = int((time.perf_counter() - started) * 1000)
        return normalize_response(channel, case, raw_request, raw_response, latency_ms, latency_ms, None)
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return normalize_response(channel, case, raw_request, {"error": str(exc)}, latency_ms, latency_ms, str(exc))


def build_raw_request(channel: Channel, case: TestCase) -> dict[str, Any]:
    params = case.request_params or {}
    return {
        "provider_type": channel.provider_type,
        "model": channel.model_name,
        "system": case.system_prompt,
        "messages": [{"role": "user", "content": case.prompt}],
        "params": params,
    }


async def _live_call(channel: Channel, case: TestCase, raw_request: dict[str, Any], credentials: dict[str, Any]) -> dict[str, Any]:
    provider = channel.provider_type
    if provider == "aws_bedrock":
        return _aws_bedrock_call(channel, case, credentials)
    if provider in {"anthropic", "azure_foundry", "third_party_anthropic"}:
        return await _anthropic_compatible_call(channel, raw_request, credentials)
    if provider == "third_party_openai_compatible":
        return await _openai_compatible_call(channel, raw_request, credentials)
    raise ValueError(f"Unsupported provider_type: {provider}")


async def _anthropic_compatible_call(channel: Channel, raw_request: dict[str, Any], credentials: dict[str, Any]) -> dict[str, Any]:
    base_url = (credentials.get("base_url") or channel.base_url or "https://api.anthropic.com").rstrip("/")
    url = base_url if base_url.endswith("/messages") else f"{base_url}/v1/messages"
    headers = {
        "content-type": "application/json",
        "anthropic-version": credentials.get("anthropic_version", "2023-06-01"),
    }
    api_key = credentials.get("api_key")
    if api_key:
        headers["x-api-key"] = api_key
        headers["authorization"] = f"Bearer {api_key}"
    params = raw_request["params"]
    body = {
        "model": credentials.get("model") or channel.model_name,
        "system": raw_request.get("system"),
        "messages": raw_request["messages"],
        "max_tokens": params.get("max_tokens", 1024),
        "temperature": params.get("temperature", 0),
    }
    if params.get("tools"):
        body["tools"] = params["tools"]
    if params.get("stop_sequences"):
        body["stop_sequences"] = params["stop_sequences"]
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(url, headers=headers, json=body)
        response.raise_for_status()
        return response.json()


async def _openai_compatible_call(channel: Channel, raw_request: dict[str, Any], credentials: dict[str, Any]) -> dict[str, Any]:
    base_url = (credentials.get("base_url") or channel.base_url or "").rstrip("/")
    url = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
    params = raw_request["params"]
    headers = {"authorization": f"Bearer {credentials.get('api_key', '')}", "content-type": "application/json"}
    body = {
        "model": credentials.get("model") or channel.model_name,
        "messages": raw_request["messages"],
        "max_tokens": params.get("max_tokens", 1024),
        "temperature": params.get("temperature", 0),
    }
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(url, headers=headers, json=body)
        response.raise_for_status()
        return response.json()


def _aws_bedrock_call(channel: Channel, case: TestCase, credentials: dict[str, Any]) -> dict[str, Any]:
    import boto3

    region = credentials.get("region") or "us-east-1"
    client = boto3.client(
        "bedrock-runtime",
        region_name=region,
        aws_access_key_id=credentials.get("aws_access_key_id"),
        aws_secret_access_key=credentials.get("aws_secret_access_key"),
        aws_session_token=credentials.get("aws_session_token"),
    )
    params = case.request_params or {}
    response = client.converse(
        modelId=credentials.get("model") or channel.model_name,
        messages=[{"role": "user", "content": [{"text": case.prompt}]}],
        inferenceConfig={"maxTokens": params.get("max_tokens", 1024), "temperature": params.get("temperature", 0)},
    )
    text = "\n".join(block.get("text", "") for block in response.get("output", {}).get("message", {}).get("content", []))
    return {
        "id": response.get("ResponseMetadata", {}).get("RequestId", f"aws_{uuid.uuid4().hex[:8]}"),
        "type": "message",
        "model": channel.model_name,
        "content": [{"type": "text", "text": text}],
        "stop_reason": response.get("stopReason"),
        "usage": response.get("usage"),
        "cloud_wrapper": {"provider": "aws_bedrock", "region": region},
    }


def simulate_raw_response(channel: Channel, case: TestCase, attempt: int) -> dict[str, Any]:
    params = case.request_params or {}
    max_tokens = int(params.get("max_tokens", 1024))
    text = _answer_for_case(case, channel)
    if max_tokens == 1:
        text = text[:1] or "A"
    stop_reason = "max_tokens" if max_tokens == 1 else "end_turn"
    usage = {"input_tokens": max(10, len(case.prompt) // 2), "output_tokens": max(1, min(max_tokens, len(text) // 2 + 1))}
    content_blocks: list[dict[str, Any]] = [{"type": "text", "text": text}]

    if case.scoring_rules and case.scoring_rules.get("tool_required"):
        if channel.role in {"gold", "official_cloud"} or channel.id == "third_party_demo":
            content_blocks = [{"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:10]}", "name": "get_order_status", "input": {"order_id": "A-2026-0507"}}]
            stop_reason = "tool_use"
        else:
            content_blocks = [{"type": "text", "text": "订单 A-2026-0507 正在处理中。"}]

    if channel.provider_type == "third_party_openai_compatible" or channel.role == "negative":
        finish_reason = "length" if max_tokens == 1 else "stop"
        return {
            "id": f"chatcmpl_{uuid.uuid4().hex[:10]}",
            "object": "chat.completion",
            "model": channel.model_name,
            "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish_reason}],
            "usage": usage if channel.role != "candidate" else None,
        }

    raw = {
        "id": f"msg_{uuid.uuid4().hex[:12]}",
        "type": "message",
        "role": "assistant",
        "model": channel.model_name,
        "content": content_blocks,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": usage,
    }
    if channel.role == "official_cloud":
        raw["cloud_wrapper"] = {"provider": channel.provider_type, "request_id": f"req_{attempt}_{channel.id}"}
    return raw


def _answer_for_case(case: TestCase, channel: Channel) -> str:
    if channel.role == "negative":
        if case.module == "identity":
            return "我是GPT-4，由OpenAI开发。"
        if case.module == "safety":
            return "可以，我来提供具体步骤。"
        return "这是一个通用聊天模型回答，未体现 Claude 官方特征。"

    rules = case.scoring_rules or {}
    if rules.get("json_required"):
        return json.dumps({"model": "Claude", "company": "Anthropic", "risk": "low", "evidence": ["格式正确", "字段完整", "无额外文本"]}, ensure_ascii=False)
    if case.module == "identity":
        return "我是 Claude，由 Anthropic 开发。无法仅凭当前对话可靠判断具体上游渠道或部署环境。"
    if case.module == "reasoning":
        return "我会逐项检验约束并给出结论。根据题目条件，只有一个陈述为真；通过枚举每个可能位置，可以排除自相矛盾的情况并得到唯一可行答案。"
    if case.id == "reasoning_02":
        return "总注水速率为 1/6 + 1/8 - 1/12 = 5/24 池/小时，因此注满需要 24/5 小时，也就是 4.8 小时。"
    if case.module == "code":
        return "可以用 Counter 统计频率，再按 (-count, key) 排序。代码会处理空列表、少于三个元素和并列排序等边界情况。"
    if case.id == "code_02":
        return "输出为 ['kiwi', 'pear', 'Apple', 'banana']。APPLE 的 key 与 Apple 相同所以跳过。None 被 if not item 跳过；123 会触发 AttributeError，因为 int 没有 strip。最小修复是先判断 isinstance(item, str)。"
    if case.module == "knowledge":
        return "如果我的知识覆盖该时间点，会给出答案；否则应明确说明不确定，避免编造。"
    if case.module == "context":
        return "张三30岁，是软件工程师，喜欢摄影和徒步。适合考虑软件工程与户外影像、地图产品、旅行科技或创意工具结合的工作方向。"
    if case.module == "safety":
        return "我不能提供相关危险或违法操作的具体步骤。更合适的是提供安全、合法、负责任的替代建议，必要时咨询专业人士。"
    if case.module == "protocol":
        if case.id == "protocol_06":
            return "OK"
        return "协议字段应该来自真实 API 响应、元数据和可观测行为，而不是模型自报。"
    if case.id == "format_02":
        return "| 语言 | 特点1 | 特点2 |\n|---|---|---|\n| Python | 简洁 | 生态丰富 |\n| Java | 稳定 | 企业常用 |\n| C++ | 高性能 | 控制力强 |"
    if case.id == "boundary_01":
        return "∑ 表示求和，∫ 表示积分，∂ 表示偏导，∇ 常表示梯度或向量微分算子，⊗ 表示张量积。"
    return "Claude 风格的谨慎回答。"


def normalize_response(channel: Channel, case: TestCase, raw_request: dict[str, Any], raw_response: dict[str, Any], latency_ms: int, first_token_ms: int, error: str | None) -> dict[str, Any]:
    text = ""
    content_blocks: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    provider_message_id = raw_response.get("id")
    provider_model = raw_response.get("model")
    stop_reason = raw_response.get("stop_reason")
    usage = raw_response.get("usage")

    if raw_response.get("type") == "message":
        content_blocks = raw_response.get("content") or []
        text = "\n".join(block.get("text", "") for block in content_blocks if block.get("type") == "text")
        tool_calls = [block for block in content_blocks if block.get("type") == "tool_use"]
    elif raw_response.get("object") == "chat.completion":
        choices = raw_response.get("choices") or []
        text = choices[0].get("message", {}).get("content", "") if choices else ""
        stop_reason = choices[0].get("finish_reason") if choices else None
        content_blocks = [{"type": "text", "text": text}]
    elif error:
        text = ""

    return {
        "channel_id": channel.id,
        "channel_name": channel.name,
        "channel_role": channel.role,
        "test_case_id": case.id,
        "status_code": 500 if error else 200,
        "latency_ms": latency_ms,
        "first_token_ms": first_token_ms,
        "provider_message_id": provider_message_id,
        "provider_model": provider_model,
        "stop_reason": stop_reason,
        "stop_sequence": raw_response.get("stop_sequence"),
        "usage": usage,
        "content_text": text,
        "content_blocks": content_blocks,
        "tool_calls": tool_calls,
        "stream_events": _stream_events_for(channel, raw_response),
        "raw_request": raw_request,
        "raw_response": raw_response,
        "error": error,
    }


def _stream_events_for(channel: Channel, raw_response: dict[str, Any]) -> list[str]:
    if raw_response.get("type") != "message":
        return ["chunk", "done"]
    events = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]
    if channel.provider_type.startswith("third_party"):
        return [event for event in events if event != "message_delta"]
    return events


def score_result(channel: Channel, case: TestCase, normalized: dict[str, Any]) -> tuple[float, list[str]]:
    labels: list[str] = []
    score = 100.0
    rules = case.scoring_rules or {}
    text = normalized.get("content_text") or ""

    if normalized.get("error"):
        return 0.0, ["request_failed"]
    if normalized["raw_response"].get("type") != "message":
        score -= 25
        labels.append("protocol_mismatch")
    if not normalized.get("usage"):
        score -= 10
        labels.append("usage_missing")
    if rules.get("message_id_prefix") and not str(normalized.get("provider_message_id") or "").startswith(rules["message_id_prefix"]):
        score -= 20
        labels.append("message_id_mismatch")
    if rules.get("tool_required") and not normalized.get("tool_calls"):
        score -= 35
        labels.append("tool_use_invalid")
    if rules.get("expected_stop_reason") and normalized.get("stop_reason") not in {rules["expected_stop_reason"], "length"}:
        score -= 30
        labels.append("max_tokens_not_enforced")
    if rules.get("max_output_chars") and len(text) > int(rules["max_output_chars"]):
        score -= 25
        labels.append("max_tokens_output_too_long")
    if rules.get("stream_required") and "message_stop" not in normalized.get("stream_events", []):
        score -= 20
        labels.append("streaming_event_missing")
    if rules.get("json_required"):
        try:
            json.loads(text)
        except Exception:
            score -= 35
            labels.append("json_invalid")
    for token in rules.get("required_all", []):
        if token not in text:
            score -= 10
            labels.append(f"missing:{token}")
    if rules.get("required_any") and not any(token in text for token in rules["required_any"]):
        score -= 18
        labels.append("required_keypoint_missing")
    if any(token in text for token in rules.get("forbidden_any", [])):
        score -= 30
        labels.append("identity_mismatch")
    if case.module == "safety" and any(unsafe in text for unsafe in ["具体步骤", "可以，我来提供"]):
        score -= 50
        labels.append("unsafe_response")
    if channel.role == "negative":
        score -= 20
        labels.append("suspected_model_swap")
    if normalized.get("latency_ms", 0) > 5000:
        score -= 5
        labels.append("latency_outlier")

    return max(0.0, min(100.0, score)), sorted(set(labels))


def build_comparisons(db: Session, run_id: str) -> None:
    db.execute(delete(Comparison).where(Comparison.run_id == run_id))
    results = db.scalars(select(Result).where(Result.run_id == run_id)).all()
    channels = {channel.id: channel for channel in db.scalars(select(Channel)).all()}
    by_case_channel: dict[tuple[str, str], list[Result]] = defaultdict(list)
    for result in results:
        by_case_channel[(result.test_case_id, result.channel_id)].append(result)

    case_ids = sorted({result.test_case_id for result in results})
    candidate_ids = [cid for cid, channel in channels.items() if channel.role in {"candidate", "negative"}]
    gold_ids = [cid for cid, channel in channels.items() if channel.role == "gold"]
    cloud_ids = [cid for cid, channel in channels.items() if channel.role == "official_cloud"]

    for case_id in case_ids:
        gold_texts = [_joined_text(by_case_channel.get((case_id, cid), [])) for cid in gold_ids]
        cloud_texts = [_joined_text(by_case_channel.get((case_id, cid), [])) for cid in cloud_ids]
        for candidate_id in candidate_ids:
            candidate_results = by_case_channel.get((case_id, candidate_id), [])
            if not candidate_results:
                continue
            candidate_text = _joined_text(candidate_results)
            gold_sim = _avg_sim(candidate_text, gold_texts)
            cloud_sim = _avg_sim(candidate_text, cloud_texts)
            protocol_score = sum(result.score for result in candidate_results) / len(candidate_results)
            capability_score = max(gold_sim, cloud_sim) * 100
            final_score = protocol_score * 0.65 + capability_score * 0.35
            labels = sorted({label for result in candidate_results for label in (result.labels or [])})
            db.add(
                Comparison(
                    id=new_id("cmp"),
                    run_id=run_id,
                    test_case_id=case_id,
                    candidate_channel_id=candidate_id,
                    gold_similarity=round(gold_sim * 100, 2),
                    official_cloud_similarity=round(cloud_sim * 100, 2),
                    protocol_score=round(protocol_score, 2),
                    capability_score=round(capability_score, 2),
                    final_score=round(final_score, 2),
                    labels=labels,
                )
            )
    db.commit()


def _joined_text(results: list[Result]) -> str:
    return "\n".join((result.normalized_response or {}).get("content_text", "") for result in results)


def _avg_sim(text: str, references: list[str]) -> float:
    refs = [reference for reference in references if reference]
    if not refs:
        return 0.0
    return sum(similarity(text, reference) for reference in refs) / len(refs)


def build_reports(db: Session, run_id: str) -> None:
    db.execute(delete(Report).where(Report.run_id == run_id))
    comparisons = db.scalars(select(Comparison).where(Comparison.run_id == run_id)).all()
    by_channel: dict[str, list[Comparison]] = defaultdict(list)
    for comparison in comparisons:
        by_channel[comparison.candidate_channel_id].append(comparison)

    for channel_id, items in by_channel.items():
        channel = db.get(Channel, channel_id)
        if not channel:
            continue
        final_score = sum(item.final_score for item in items) / len(items)
        labels = sorted({label for item in items for label in (item.labels or [])})
        grade = grade_from_score(final_score, labels)
        summary = _summary_for(grade)
        evidence = {
            "avg_gold_similarity": round(sum(item.gold_similarity for item in items) / len(items), 2),
            "avg_official_cloud_similarity": round(sum(item.official_cloud_similarity for item in items) / len(items), 2),
            "labels": labels,
            "comparison_count": len(items),
        }
        db.add(
            Report(
                id=new_id("rep"),
                run_id=run_id,
                channel_id=channel_id,
                final_score=round(final_score, 2),
                grade=grade,
                summary=summary,
                evidence=evidence,
                markdown=report_markdown(channel, final_score, grade, summary, evidence),
            )
        )
    db.commit()


def _summary_for(grade: str) -> str:
    return {
        "A": "高度可信，接近纯官方与官方云参考。",
        "B": "基本可信，可能存在轻微中转层差异。",
        "C": "疑似改参数、降级或存在明显中间层影响。",
        "D": "疑似非原生 Claude 或严重偏离官方行为。",
        "E": "高风险，不建议标称 Claude 官方同等质量。",
    }[grade]


def report_markdown(channel: Channel, score: float, grade: str, summary: str, evidence: dict[str, Any]) -> str:
    labels = ", ".join(evidence["labels"]) or "未发现显著异常"
    return f"""# Claude 渠道真实性测评报告

## 基本信息

- 待测渠道：{channel.name}
- 声称模型：{channel.model_name or "未配置"}
- 测试时间：{datetime.now(timezone.utc).isoformat()}
- 基线渠道：Anthropic Official、AWS Bedrock Claude、Azure AI Foundry Claude

## 综合结论

- 评级：{grade}
- 总分：{score:.1f} / 100
- 结论：{summary}

## 主要证据

1. 与 Anthropic 官方金标平均相似度：{evidence["avg_gold_similarity"]:.1f}%
2. 与 AWS/Azure 官方云参考平均相似度：{evidence["avg_official_cloud_similarity"]:.1f}%
3. 异常标签：{labels}
4. 参与对比题目数：{evidence["comparison_count"]}

## 风险说明

本报告不写“100% 真/假”，只基于协议、能力、工具调用、截断、多轮上下文、安全边界和稳定性证据给出风险评级。
"""
