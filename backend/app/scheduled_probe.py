from __future__ import annotations

import re
from typing import Any


EXPECTED_SCHEDULED_PROBE_KEYS = {
    "thinking_temperature",
    "web_search",
    "thinking_adaptive_enabled",
}

EXPECTED_CLAUDE_PROBE_LABELS = {
    "provider_error_variant",
    "unexpected_error_response",
    "thinking_adaptive_enabled_wrong_error",
}
PROVIDER_TEMPORARILY_UNAVAILABLE_LABEL = "provider_temporarily_unavailable"
PROVIDER_QUOTA_EXHAUSTED_LABEL = "provider_quota_or_balance_exhausted"
PROVIDER_REQUEST_FAILED_LABEL = "provider_request_failed"
OPERATIONAL_FAILURE_LABELS = {
    PROVIDER_TEMPORARILY_UNAVAILABLE_LABEL,
    PROVIDER_QUOTA_EXHAUSTED_LABEL,
    PROVIDER_REQUEST_FAILED_LABEL,
}
TEMPORARY_PROVIDER_UNAVAILABLE_PATTERN = re.compile(
    r"\b503\b|service unavailable|no available channel|overloaded|temporar(?:y|ily) unavailable|upstream unavailable|provider unavailable|资源池暂无可用|暂无可用通道",
    re.IGNORECASE,
)
PROVIDER_QUOTA_EXHAUSTED_PATTERN = re.compile(
    r"用户额度不足|额度不足|余额不足|剩余额度|quota(?:\s+or\s+balance)?\s+(?:is\s+)?(?:exhausted|insufficient|exceeded)|credit(?:s)?\s+(?:are\s+)?(?:exhausted|insufficient)|insufficient\s+(?:quota|balance|credit)|billing quota",
    re.IGNORECASE,
)
PROVIDER_REQUEST_FAILED_PATTERN = re.compile(
    r"\b5\d\d\b|internal server error|gateway timeout|bad gateway|request timeout|timed out|connection (?:failed|error|reset)|network error",
    re.IGNORECASE,
)
BLOCKING_SCHEDULED_PROBE_LABELS = {
    "thinking_adaptive_not_supported",
    "thinking_temperature_not_rejected",
    "web_search_not_rejected",
    "thinking_adaptive_enabled_not_rejected",
    "signature_interop_failed",
}
NATIVE_PARAMETER_UNSUPPORTED_PATTERN = re.compile(
    r"400 bad request|invalid request|unsupported|not supported|temperature|thinking\.adaptive\.enabled|web_search|tool",
    re.IGNORECASE,
)


def operational_failure_label(error_text: str | None, *, http_status: Any | None = None) -> str | None:
    text = str(error_text or "")
    combined = f"{http_status or ''} {text}".strip()
    if re.search(r"缺少\s*api\s*key|missing\s+api\s*key|authentication required|unauthorized|invalid api key", combined, re.IGNORECASE):
        return None
    if PROVIDER_QUOTA_EXHAUSTED_PATTERN.search(combined):
        return PROVIDER_QUOTA_EXHAUSTED_LABEL
    if TEMPORARY_PROVIDER_UNAVAILABLE_PATTERN.search(combined):
        return PROVIDER_TEMPORARILY_UNAVAILABLE_LABEL
    try:
        status = int(http_status) if http_status is not None else None
    except (TypeError, ValueError):
        status = None
    if (status is not None and status >= 500) or PROVIDER_REQUEST_FAILED_PATTERN.search(combined):
        return PROVIDER_REQUEST_FAILED_LABEL
    return None


def operational_failure_label_for_item(item: dict[str, Any]) -> str | None:
    labels = {str(label) for label in (item.get("labels") or []) if isinstance(label, str)}
    matched = labels.intersection(OPERATIONAL_FAILURE_LABELS)
    if matched:
        return next(label for label in OPERATIONAL_FAILURE_LABELS if label in matched)
    error_text = " ".join(
        str(item.get(field) or "")
        for field in ("error", "reason", "raw_error", "evidence_excerpt")
        if str(item.get(field) or "").strip()
    )
    return operational_failure_label(error_text, http_status=item.get("error_http_status") or item.get("status_code"))


def only_operational_failures(model_requests: list[dict[str, Any]], labels: set[str]) -> bool:
    if not labels or not labels.issubset(OPERATIONAL_FAILURE_LABELS):
        return False
    return any(operational_failure_label_for_item(item) for item in model_requests)


def scheduled_probe_markdown(channel: Any, score: float, grade: str, summary: str, evidence: dict[str, Any]) -> str:
    labels = ", ".join(evidence.get("labels") or []) or "未发现显著异常"
    model_requests = evidence.get("model_requests") if isinstance(evidence.get("model_requests"), list) else []
    if not model_requests and isinstance(evidence.get("model_request"), dict):
        model_requests = [evidence["model_request"]]
    model_rows = "\n".join(
        f"| {_scheduled_probe_display_title(item)} | {item.get('channel_name') or '-'} ({item.get('channel_id') or '-'}) | {_probe_status_text(item)} | {item.get('completed_at') or item.get('created_at') or '-'} | {item.get('response_id') or item.get('message_id') or '-'} | {item.get('request_id') or '-'} | {item.get('request_protocol') or '-'} | {item.get('provider_endpoint') or '-'} | {', '.join(item.get('labels') or []) or '-'} | {item.get('error') or '-'} |"
        for item in model_requests
        if isinstance(item, dict)
    ) or "| - | - | - | - | - | - | - | - | - | - |"
    signature = evidence.get("signature_interop") or {}
    signature_time = signature.get("completed_at") or signature.get("created_at") or evidence.get("completed_at") or "-"
    identity_request = next(
        (item for item in model_requests if isinstance(item, dict) and item.get("key") == "identity_self_report"),
        {},
    )
    identity_response_text = signature.get("identity_response_text") or identity_request.get("response_text") or "-"
    identity_message_id = signature.get("identity_message_id") or identity_request.get("response_id") or identity_request.get("message_id") or "-"
    identity_request_id = signature.get("identity_request_id") or identity_request.get("request_id") or "-"
    identity_status = signature.get("identity_status") or _probe_status_text(identity_request) if identity_request else signature.get("identity_status") or "-"
    identity_labels = signature.get("identity_labels") or identity_request.get("labels") or []
    classification_label = evidence.get("classification_label") or evidence.get("detected_provider_hint") or "未分类"
    classification_reason = evidence.get("classification_reason") or "-"
    ai_judge = evidence.get("ai_judge") if isinstance(evidence.get("ai_judge"), dict) else None
    ai_judge_section = ""
    if ai_judge:
        ai_judge_section = f"""
## AI 疑难复核

- 裁判渠道：{ai_judge.get('judge_channel_name') or ai_judge.get('judge_channel_id') or '本地兜底'}
- 是否真实调用：{'是' if ai_judge.get('attempted') else '否'}
- 复核判定：{ai_judge.get('classification_label') or ai_judge.get('classification_status') or '-'}
- 置信度：{ai_judge.get('confidence') if ai_judge.get('confidence') is not None else '-'}
- 说明：{ai_judge.get('reason') or '-'}
"""
    return f"""# {channel.name} - 自动巡检资源报告

## 基本信息

- 渠道：{channel.name}
- 渠道 ID：{channel.id}
- 声称模型：{channel.model_name or "未配置"}
- 判定：{classification_label}
- 判定说明：{classification_reason}
- 评级：{grade}
- 总分：{score:.1f} / 100
- 结论：{summary}
- 异常标签：{labels}

## 真实模型请求

| 探针 | 渠道 | 状态 | 时间 | 上游响应 ID（Message ID） | Request ID | 请求协议 | Provider endpoint | 标签 | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{model_rows}

{ai_judge_section}
## Thinking Signature 互通

- 身份探针状态：{identity_status}
- 身份探针回复：{identity_response_text}
- 身份上游响应 ID（Message ID）：{identity_message_id}
- 身份 Request ID：{identity_request_id}
- 身份标签：{", ".join(identity_labels) or "-"}
- 状态：{signature.get("status") or "-"}
- 检测时间：{signature_time}
- Source 渠道：{signature.get("source_channel_name") or "-"} ({signature.get("source_channel_id") or "-"})
- 来源上游响应 ID（Message ID）：{signature.get("source_message_id") or "-"}
- 来源 Request ID：{signature.get("source_request_id") or "-"}
- 来源渠道类型：{signature.get("source_message_channel_type") or "-"}
- Relay 渠道：{signature.get("relay_channel_name") or "-"} ({signature.get("relay_channel_id") or "-"})
- Relay 上游响应 ID（Message ID）：{signature.get("relay_message_id") or "-"}
- Relay Request ID：{signature.get("relay_request_id") or "-"}
- Relay 渠道类型：{signature.get("relay_message_channel_type") or "-"}
- Signature 前缀：{", ".join(signature.get("signature_prefixes") or []) or "-"}
- 协议 profile：source={signature.get("source_protocol_profile") or "-"} / relay={signature.get("relay_protocol_profile") or "-"}
- 请求归一化：{"; ".join(signature.get("request_normalization_notes") or []) or "-"}
- 判定：{signature.get("reason") or "-"}
"""


def _scheduled_probe_display_title(item: dict[str, Any]) -> str:
    title = str(item.get("title") or item.get("key") or "-")
    key = str(item.get("key") or "")
    legacy_aliases = {
        "thinking_temperature": "Thinking temperature 冲突",
        "thinking_adaptive_enabled": "thinking.adaptive.enabled",
    }
    legacy = legacy_aliases.get(key)
    if legacy and legacy not in title:
        return f"{title}（原 {legacy}）"
    return title


def _probe_status_text(item: dict[str, Any]) -> str:
    labels = {str(label) for label in (item.get("labels") or []) if isinstance(label, str)}
    operational_label = operational_failure_label_for_item(item)
    if operational_label == PROVIDER_TEMPORARILY_UNAVAILABLE_LABEL:
        return "资源暂不可用"
    if operational_label == PROVIDER_QUOTA_EXHAUSTED_LABEL:
        return "额度不足"
    if operational_label == PROVIDER_REQUEST_FAILED_LABEL:
        return "检测失败"
    if "kiro_identity_leak" in labels:
        return "Kiro 身份泄漏"
    if labels == {"identity_uncertain"}:
        return "身份待确认"
    if labels.intersection({"provider_error_variant"}) or _probe_parameter_unsupported(item):
        return "符合预期"
    if labels:
        return "真伪异常"
    return "通过"


def _probe_parameter_unsupported(item: dict[str, Any]) -> bool:
    labels = {str(label) for label in (item.get("labels") or []) if isinstance(label, str)}
    if "provider_error_variant" in labels:
        return True
    error_text = " ".join(
        str(item.get(field) or "")
        for field in ("error", "response_text", "raw_response_text")
        if str(item.get(field) or "").strip()
    ).lower()
    return bool(NATIVE_PARAMETER_UNSUPPORTED_PATTERN.search(error_text))


def _scheduled_probe_all_parameter_unsupported(model_requests: list[dict[str, Any]]) -> bool:
    # The "every probe returned a generic parameter-unsupported/400 form → AWS
    # resource" inference is only valid when the whole sweep ran. A per-schedule
    # subset can omit probes, so requiring the full registry set here avoids
    # misreading a single Claude-native rejection as the AWS generic shape;
    # subset runs are still classified by the Claude-native and AWS-message-id
    # branches below, which are count-agnostic.
    parameter_requests = [item for item in model_requests if str(item.get("key") or "") in EXPECTED_SCHEDULED_PROBE_KEYS]
    request_keys = {str(item.get("key") or "") for item in parameter_requests}
    if request_keys != EXPECTED_SCHEDULED_PROBE_KEYS:
        return False
    return all(_probe_parameter_unsupported(item) for item in parameter_requests)


def scheduled_probe_classification(
    model_requests: list[dict[str, Any]],
    signature_evidence: dict[str, Any],
    labels: list[str],
    score: float,
) -> dict[str, Any]:
    label_set = set(labels)
    normalized_score = _safe_float(score)
    if "kiro_identity_leak" in label_set:
        return {
            "status": "anomaly",
            "label": "疑似 Kiro 路由混入",
            "reason": "身份探针响应明确泄漏 Kiro 身份，按路由混入高风险处理。",
            "score": 0,
        }
    if "identity_mismatch" in label_set:
        return {
            "status": "anomaly",
            "label": "身份自报不一致",
            "reason": "身份探针明确自报为非 Claude/Anthropic 产品，作为身份异常证据进入复审。",
            "score": min(normalized_score, 40),
        }
    identity_request = next((item for item in model_requests if str(item.get("key") or "") == "identity_self_report"), None)
    identity_operational_label = operational_failure_label_for_item(identity_request) if identity_request else None
    identity_failure_blockers = label_set.difference(OPERATIONAL_FAILURE_LABELS | {"provider_error_variant", "identity_uncertain"})
    if identity_operational_label and not identity_failure_blockers:
        if identity_operational_label == PROVIDER_QUOTA_EXHAUSTED_LABEL:
            display_label = "额度不足"
            reason = "本轮无法判定：固定身份请求因额度或余额不足失败，巡检证据不完整。"
        elif identity_operational_label == PROVIDER_TEMPORARILY_UNAVAILABLE_LABEL:
            display_label = "资源暂不可用"
            reason = "本轮无法判定：固定身份请求遇到上游资源暂不可用，巡检证据不完整。"
        else:
            display_label = "检测失败"
            reason = "本轮无法判定：固定身份请求失败，巡检证据不完整。"
        return {
            "status": "operational_issue",
            "label": display_label,
            "reason": reason,
            "score": 90,
        }
    provider_hint = scheduled_provider_hint_from_evidence(model_requests, signature_evidence, labels)
    parameter_requests = [item for item in model_requests if str(item.get("key") or "") in EXPECTED_SCHEDULED_PROBE_KEYS]
    probe_count = len({str(item.get("key") or "") for item in parameter_requests if str(item.get("key") or "")}) or len(parameter_requests)
    probe_count_text = f"{probe_count} 项" if probe_count else "所选"
    signature_operational_label = operational_failure_label_for_item(signature_evidence)
    if only_operational_failures(model_requests, label_set) or (label_set and label_set.issubset(OPERATIONAL_FAILURE_LABELS) and signature_operational_label):
        if PROVIDER_QUOTA_EXHAUSTED_LABEL in label_set:
            display_label = "额度不足"
            reason = "本轮无法判定：资源额度或余额不足，已作为运营问题记录，不参与真伪判断。"
        elif PROVIDER_TEMPORARILY_UNAVAILABLE_LABEL in label_set:
            display_label = "资源暂不可用"
            reason = "本轮无法判定：上游资源暂不可用或资源池暂无可用通道，已作为运营问题记录。"
        else:
            display_label = "检测失败"
            reason = "本轮无法判定：请求失败且未获得可用于真伪判断的响应，已作为运营问题记录。"
        return {
            "status": "operational_issue",
            "label": display_label,
            "reason": reason,
            "score": max(normalized_score, 90),
        }
    if not parameter_requests and (signature_evidence.get("status") == "skipped" or signature_evidence.get("ok")):
        return {
            "status": "claude_signature",
            "label": "身份探针完成，Signature 互通通过" if signature_evidence.get("ok") else "身份探针完成",
            "reason": str(signature_evidence.get("reason") or "固定身份探针已完成；模型自报仅作为辅助证据。"),
            "score": max(normalized_score, 95),
        }
    if _scheduled_probe_all_parameter_unsupported(model_requests):
        return {
            "status": "aws_resource",
            "label": "AWS 资源",
            "reason": f"{probe_count_text}自动巡检探针均命中参数不支持/原生拒绝形态，资源按 AWS 路径处理；4.7/4.8 adaptive thinking 新协议已归一化。",
            "score": max(normalized_score, 95),
        }
    if _scheduled_probe_has_native_aws_shape(model_requests, label_set):
        return {
            "status": "aws_resource",
            "label": "AWS 资源",
            "reason": "巡检探针存在 AWS/Bedrock message id 或签名证据，虽有中间层错误，仍按低置信 AWS 资源处理并交由 AI 复核。",
            "score": max(normalized_score, 90),
        }
    if _has_expected_claude_probe(model_requests, label_set) and "signature_interop_failed" not in label_set:
        return {
            "status": "claude",
            "label": "Claude 资源",
            "reason": f"{probe_count_text}自动巡检探针均命中 Claude 原生参数拒绝形态，资源按 Claude 路径处理；4.7/4.8 adaptive thinking 新协议已归一化。",
            "score": max(normalized_score, 95),
        }
    if label_set.intersection(BLOCKING_SCHEDULED_PROBE_LABELS) or label_set.intersection({"unexpected_error_response", "thinking_adaptive_enabled_wrong_error"}):
        normalized_score = min(normalized_score, 40)
    if "signature_interop_failed" in label_set:
        if _has_expected_claude_probe(model_requests, label_set):
            return {
                "status": "claude",
                "label": "Claude 资源（Signature 链路不可验证）",
                "reason": "Claude 基础资源探针命中原生参数拒绝形态，但 Thinking Signature 互通未通过；该失败仅表示 ClaudeCode/原生 thinking 链路不可验证，不单独等同于非 Claude。",
                "score": max(min(normalized_score, 85), 75),
            }
        normalized_score = min(normalized_score, 60)
    return {
        "status": "anomaly",
        "label": provider_hint,
        "reason": "巡检探针未命中预期 Claude/AWS 资源形态，需要复审；Signature 失败仅表示 ClaudeCode/原生 thinking 链路不可验证，不单独等同于非 Claude。",
        "score": normalized_score,
    }


def _scheduled_probe_has_native_aws_shape(model_requests: list[dict[str, Any]], labels: set[str]) -> bool:
    if not labels.intersection({"thinking_temperature_not_rejected", "unexpected_error_response", "provider_error_variant"}):
        return False
    return any(
        str(item.get("message_id") or "").startswith("msg_bdrk_")
        or str(item.get("message_channel_type") or "") == "AWS Bedrock"
        for item in model_requests
    )


def scheduled_probe_needs_ai_judge(model_requests: list[dict[str, Any]], labels: list[str], classification: dict[str, Any]) -> bool:
    if not model_requests:
        return False
    label_set = {str(label) for label in labels}
    if "kiro_identity_leak" in label_set:
        return False
    if str(classification.get("status") or "") == "operational_issue" or only_operational_failures(model_requests, label_set):
        return False
    if str(classification.get("status") or "") == "anomaly":
        return True
    unsupported = [_probe_parameter_unsupported(item) for item in model_requests]
    if any(unsupported) and not all(unsupported):
        return True
    error_text = "\n".join(str(item.get("error") or "") for item in model_requests).lower()
    if "overloaded" in error_text:
        return True
    message_types = {str(item.get("message_channel_type") or "") for item in model_requests}
    if "thinking_temperature_not_rejected" in label_set and any(
        str(item.get("message_id") or "").startswith(("msg_bdrk_", "msg_")) or str(item.get("message_channel_type") or "") in {"AWS Bedrock", "Anthropic"}
        for item in model_requests
    ):
        return True
    blocking = label_set.intersection(BLOCKING_SCHEDULED_PROBE_LABELS | {"unexpected_error_response", "thinking_adaptive_enabled_wrong_error"})
    return bool(blocking and message_types.intersection({"AWS Bedrock", "Anthropic"}))


def _has_expected_claude_probe(model_requests: list[dict[str, Any]], labels: set[str]) -> bool:
    if "provider_error_variant" in labels:
        return True
    for item in model_requests:
        item_labels = {str(label) for label in (item.get("labels") or []) if isinstance(label, str)}
        error = str(item.get("error") or "").lower()
        if item_labels.intersection(EXPECTED_CLAUDE_PROBE_LABELS):
            if "temperature" in error and "thinking" in error:
                return True
            if item_labels == {"provider_error_variant"}:
                return True
    return False


def scheduled_provider_hint_from_evidence(model_requests: list[dict[str, Any]], signature_evidence: dict[str, Any], labels: list[str]) -> str:
    types = [
        " ".join(str(item.get("message_channel_type") or "") for item in model_requests),
        str(signature_evidence.get("source_message_channel_type") or ""),
        str(signature_evidence.get("relay_message_channel_type") or ""),
    ]
    joined = " ".join(types).lower()
    if PROVIDER_QUOTA_EXHAUSTED_LABEL in labels:
        return "额度不足"
    if PROVIDER_TEMPORARILY_UNAVAILABLE_LABEL in labels:
        return "资源暂不可用"
    if PROVIDER_REQUEST_FAILED_LABEL in labels:
        return "检测失败"
    if "thinking_temperature_not_rejected" in labels or "thinking_adaptive_not_supported" in labels or "thinking_adaptive_enabled_not_rejected" in labels:
        return "疑似 adaptive thinking 中间层改写"
    if "signature_interop_failed" in labels:
        return "ClaudeCode Signature 链路不可验证"
    if "bedrock" in joined or "aws" in joined:
        return "疑似 AWS/Bedrock"
    if "vertex" in joined:
        return "疑似 Vertex"
    if "claude" in joined or "anthropic" in joined:
        return "疑似 Claude/Anthropic"
    return "来源特征不明确"


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else default
