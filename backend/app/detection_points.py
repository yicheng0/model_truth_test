"""Detection-point registry and evidence aggregation helpers.

The registry is deliberately data-only so suite metadata can be validated without
starting an HTTP client or making claims about upstream provenance.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date
from typing import Any, Iterable


DETECTION_POINT_ORDER = [
    "fable5_behavior",
    "kiro_bedrock",
    "claude_code_client",
    "anthropic_origin",
    "calibration",
]

DETECTION_POINTS: dict[str, dict[str, Any]] = {
    "fable5_behavior": {
        "key": "fable5_behavior",
        "title": "Fable 5 行为边界",
        "evidence_tier": "protocol",
        "official_doc_refs": [
            "https://platform.claude.com/docs/en/about-claude/models/overview",
            "https://platform.claude.com/docs/en/build-with-claude/thinking",
            "https://platform.claude.com/docs/en/api/errors",
        ],
        "source_checked_at": str(date.today()),
        "time_sensitive": True,
    },
    "kiro_bedrock": {
        "key": "kiro_bedrock",
        "title": "Kiro / Bedrock 线索",
        "evidence_tier": "behavior",
        "official_doc_refs": [
            "https://kiro.dev/docs/models/",
            "https://kiro.dev/docs/getting-started/authentication/",
        ],
        "source_checked_at": str(date.today()),
        "time_sensitive": True,
    },
    "claude_code_client": {
        "key": "claude_code_client",
        "title": "Claude Code 客户端契约",
        "evidence_tier": "protocol",
        "official_doc_refs": [
            "https://code.claude.com/docs/en/llm-gateway-protocol",
            "https://code.claude.com/docs/en/authentication",
        ],
        "source_checked_at": str(date.today()),
        "time_sensitive": True,
    },
    "anthropic_origin": {
        "key": "anthropic_origin",
        "title": "Anthropic 官方来源证据",
        "evidence_tier": "control_plane",
        "official_doc_refs": [
            "https://platform.claude.com/docs/en/api/errors",
            "https://platform.claude.com/docs/en/api/messages",
        ],
        "source_checked_at": str(date.today()),
        "time_sensitive": False,
    },
    "calibration": {
        "key": "calibration",
        "title": "能力与安全校准",
        "evidence_tier": "behavior",
        "official_doc_refs": [
            "https://platform.claude.com/docs/en/about-claude/models/overview",
        ],
        "source_checked_at": str(date.today()),
        "time_sensitive": True,
    },
}

_STATUS_ORDER = {
    "fail": 5,
    "warning": 4,
    "operationally_inconclusive": 3,
    "insufficient_evidence": 2,
    "not_applicable": 1,
    "pass": 0,
}


def detection_point_metadata(rules: dict[str, Any] | None) -> dict[str, Any] | None:
    """Return validated detection-point metadata for explicitly opted-in cases."""

    if not isinstance(rules, dict) or rules.get("detection_point_mode") is not True:
        return None
    key = str(rules.get("detection_point") or "").strip()
    if key not in DETECTION_POINTS:
        return None
    definition = DETECTION_POINTS[key]
    return {
        **definition,
        "positive_control": bool(rules.get("positive_control")),
        "negative_control": bool(rules.get("negative_control")),
        "tamper_control": bool(rules.get("tamper_control")),
        "calibration_only": bool(rules.get("calibration_only")),
        "expected_error_category": rules.get("expected_error_category"),
    }


def is_detection_point_case(case: Any) -> bool:
    return detection_point_metadata(getattr(case, "scoring_rules", None)) is not None


def detection_point_sort_key(case: Any) -> tuple[int, int, str, str]:
    rules = getattr(case, "scoring_rules", None) or {}
    point = str(rules.get("detection_point") or "")
    try:
        point_order = DETECTION_POINT_ORDER.index(point)
    except ValueError:
        point_order = len(DETECTION_POINT_ORDER)
    return (point_order, int(getattr(case, "sort_order", 1000) or 1000), str(getattr(case, "module", "")), str(getattr(case, "id", "")))


def merge_detection_point_status(statuses: Iterable[str]) -> str:
    normalized = [str(status).strip() for status in statuses if str(status).strip()]
    if not normalized:
        return "insufficient_evidence"
    if all(status in {"not_applicable", "skipped"} for status in normalized):
        return "not_applicable"
    if any(status == "fail" for status in normalized):
        return "fail"
    if any(status == "warning" for status in normalized):
        return "warning"
    if any(status == "operationally_inconclusive" for status in normalized):
        return "operationally_inconclusive"
    if any(status == "insufficient_evidence" for status in normalized):
        return "insufficient_evidence"
    if any(status == "pass" for status in normalized):
        return "pass"
    return max(normalized, key=lambda status: _STATUS_ORDER.get(status, 2))


def build_detection_point_assessment(
    probes: Iterable[dict[str, Any]],
    *,
    control_plane_evidence: dict[str, Any] | None = None,
    inbound_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Aggregate already-redacted probe rows without making provenance claims."""

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for probe in probes:
        rules = probe.get("scoring_rules") if isinstance(probe.get("scoring_rules"), dict) else probe
        metadata = detection_point_metadata(rules)
        key = metadata["key"] if metadata else str(probe.get("detection_point") or "")
        if key in DETECTION_POINTS:
            grouped[key].append(probe)

    items: list[dict[str, Any]] = []
    all_labels: set[str] = set()
    for key in DETECTION_POINT_ORDER:
        definition = DETECTION_POINTS[key]
        rows = grouped.get(key, [])
        statuses = [str(row.get("status") or "insufficient_evidence") for row in rows]
        labels = sorted({str(label) for row in rows for label in (row.get("labels") or []) if str(label)})
        all_labels.update(labels)
        evidence_refs = [str(row.get("evidence_ref") or row.get("key") or "") for row in rows if row.get("evidence_ref") or row.get("key")]
        items.append({
            **definition,
            "status": merge_detection_point_status(statuses),
            "sample_count": len(rows),
            "pass_count": sum(status == "pass" for status in statuses),
            "warning_count": sum(status == "warning" for status in statuses),
            "fail_count": sum(status == "fail" for status in statuses),
            "skipped_count": sum(status in {"skipped", "not_applicable"} for status in statuses),
            "labels": labels,
            "evidence_refs": evidence_refs,
            "observed_summary": [row.get("observed") or row.get("reason") for row in rows if row.get("observed") or row.get("reason")][:5],
        })

    control = control_plane_evidence if isinstance(control_plane_evidence, dict) else {}
    has_control_plane = bool(
        control.get("endpoint_host")
        and control.get("request_id")
        and (control.get("billing_or_audit_ref") or control.get("account_or_workspace_ref"))
    )
    inbound_observed = bool(isinstance(inbound_request, dict) and inbound_request.get("observed") is True)
    client_likelihood = "unobservable"
    if inbound_observed:
        headers = {str(key).lower() for key in (inbound_request.get("header_names") or [])}
        if {"x-claude-code-session-id", "anthropic-beta"}.issubset(headers):
            client_likelihood = "claude_code_like"
        elif "anthropic-version" in headers:
            client_likelihood = "api_direct_like"

    fable_rows = grouped.get("fable5_behavior", [])
    fable_statuses = [str(row.get("status") or "insufficient_evidence") for row in fable_rows]
    fable_operational = any(status == "operationally_inconclusive" for status in fable_statuses)
    fable_controls = {
        control: [row for row in fable_rows if bool((row.get("scoring_rules") if isinstance(row.get("scoring_rules"), dict) else row).get(control))]
        for control in ("positive_control", "negative_control", "tamper_control")
    }
    controls_complete = all(fable_controls.values())
    controls_pass = controls_complete and all(
        str(row.get("status") or "insufficient_evidence") == "pass"
        for rows in fable_controls.values()
        for row in rows
    )
    if fable_operational and not controls_pass:
        model_identity = "operationally_inconclusive"
    elif controls_pass and not {"protocol_mismatch", "model_name_mismatch"}.intersection(all_labels):
        model_identity = "fable5_consistent"
    elif fable_rows:
        model_identity = "fable5_inconsistent" if any(status == "fail" for status in fable_statuses) else "fable5_inconclusive"
    else:
        model_identity = "insufficient_evidence"
    access_path = "transparent_unresolved"
    endpoint_host = str(control.get("endpoint_host") or "").lower()
    if endpoint_host == "api.anthropic.com":
        access_path = "anthropic_endpoint_configured"
    elif "bedrock" in endpoint_host or "kiro" in endpoint_host:
        access_path = "official_cloud_reference"
    elif client_likelihood == "claude_code_like":
        access_path = "claude_code_gateway_like"
    resource_identity = "insufficient_evidence"
    if has_control_plane and endpoint_host == "api.anthropic.com":
        resource_identity = "anthropic_api_key_configured"
    elif "bedrock" in endpoint_host or "kiro" in endpoint_host:
        resource_identity = "cloud_provider_credentials"
    return {
        "detection_points": {"items": items},
        "identity_assessment": {
            "model_identity": model_identity,
            "client_likelihood": client_likelihood,
            "access_path": access_path,
            "resource_identity": resource_identity,
            "origin_verified": has_control_plane and endpoint_host == "api.anthropic.com",
            "origin_classification": (
                "anthropic_api_direct_verified"
                if has_control_plane and endpoint_host == "api.anthropic.com"
                else "configured_not_verified"
                if endpoint_host == "api.anthropic.com"
                else "transparent_unresolved"
            ),
            "control_plane_evidence": {key: control.get(key) for key in ("endpoint_host", "request_id", "observed_at", "account_or_workspace_ref", "billing_or_audit_ref") if control.get(key)},
            "evidence_refs": sorted({ref for item in items for ref in item["evidence_refs"]}),
            "limitations": [
                "Fable 5 行为、协议字段和 signature 不能单独证明官方直连。",
                "Claude Code 客户端只有在入口侧捕获到请求证据时才可判定；主动探针本身只能返回 unobservable。",
                "Kiro/Bedrock 线索保留为访问路径或标签，不自动推出模型替换。",
            ],
        },
    }


def probes_from_results(results: Iterable[Any], cases: dict[str, Any]) -> list[dict[str, Any]]:
    """Project stored Result rows into redacted detection-point probe rows.

    This intentionally uses only persisted labels/metrics and case metadata; it
    does not infer provider provenance from model text or a single response field.
    """
    operational_labels = {
        "request_failed", "provider_request_failed", "provider_quota_exhausted",
        "provider_temporarily_unavailable", "timeout", "authentication_failed",
    }
    protocol_labels = {
        "protocol_mismatch", "model_name_mismatch", "usage_missing",
        "streaming_event_missing", "tool_use_invalid", "max_tokens_not_enforced",
    }
    rows: list[dict[str, Any]] = []
    for result in results:
        case = cases.get(getattr(result, "test_case_id", ""))
        rules = getattr(case, "scoring_rules", None) if case else None
        metadata = detection_point_metadata(rules)
        if not metadata:
            continue
        labels = [str(label) for label in (getattr(result, "labels", None) or []) if str(label)]
        normalized = getattr(result, "normalized_response", None) or {}
        if set(labels).intersection(operational_labels):
            status = "operationally_inconclusive"
        elif set(labels).intersection(protocol_labels) or normalized.get("error"):
            status = "fail"
        else:
            status = "pass"
        rows.append({
            "key": getattr(result, "id", None),
            "scoring_rules": rules,
            "status": status,
            "labels": labels,
            "evidence_ref": getattr(result, "id", None),
            "observed": normalized.get("content_text") or normalized.get("error") or None,
        })
    return rows
