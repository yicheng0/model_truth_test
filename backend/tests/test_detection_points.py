from app.detection_points import (
    DETECTION_POINT_ORDER,
    DETECTION_POINTS,
    detection_point_metadata,
    merge_detection_point_status,
    detection_point_sort_key,
    is_detection_point_case,
    build_detection_point_assessment,
)
from types import SimpleNamespace
from app.suite_seed import default_cases
from app.schemas import RunCreate
from app.services import seed_demo_data
from app.models import Base, TestCase
from sqlalchemy import create_engine
from sqlalchemy.orm import Session


def test_detection_point_registry_has_stable_five_group_order():
    assert DETECTION_POINT_ORDER == [
        "fable5_behavior",
        "kiro_bedrock",
        "claude_code_client",
        "anthropic_origin",
        "calibration",
    ]
    assert set(DETECTION_POINTS) == set(DETECTION_POINT_ORDER)
    assert all(DETECTION_POINTS[key]["official_doc_refs"] for key in DETECTION_POINT_ORDER)


def test_detection_point_metadata_requires_explicit_mode_marker():
    assert detection_point_metadata({"detection_point_mode": True, "detection_point": "fable5_behavior"})["key"] == "fable5_behavior"
    assert detection_point_metadata({"detection_point": "fable5_behavior"}) is None
    assert detection_point_metadata({"detection_point_mode": True, "detection_point": "unknown"}) is None


def test_detection_point_status_merge_keeps_operational_failures_inconclusive():
    assert merge_detection_point_status(["pass", "warning"]) == "warning"
    assert merge_detection_point_status(["fail", "operationally_inconclusive"]) == "fail"
    assert merge_detection_point_status(["operationally_inconclusive", "not_applicable"]) == "operationally_inconclusive"
    assert merge_detection_point_status([]) == "insufficient_evidence"


def test_detection_point_case_requires_explicit_marker_and_sorts_by_registry():
    old_case = SimpleNamespace(id="old", sort_order=1, module="protocol", scoring_rules={})
    fable_case = SimpleNamespace(id="fable", sort_order=20, module="protocol", scoring_rules={"detection_point_mode": True, "detection_point": "fable5_behavior"})
    calibration_case = SimpleNamespace(id="cal", sort_order=1, module="code", scoring_rules={"detection_point_mode": True, "detection_point": "calibration"})
    assert is_detection_point_case(old_case) is False
    assert is_detection_point_case(fable_case) is True
    assert sorted([calibration_case, fable_case], key=detection_point_sort_key) == [fable_case, calibration_case]


def test_seeded_cases_cover_all_detection_points_and_fable_controls():
    cases = default_cases()
    marked = [case for case in cases if (case.get("scoring_rules") or {}).get("detection_point_mode") is True]
    points = {case["scoring_rules"].get("detection_point") for case in marked}
    assert points == set(DETECTION_POINT_ORDER)
    fable = [case for case in marked if case["scoring_rules"].get("detection_point") == "fable5_behavior"]
    assert any(case["scoring_rules"].get("positive_control") for case in fable)
    assert any(case["scoring_rules"].get("negative_control") for case in fable)
    assert any(case["scoring_rules"].get("tamper_control") for case in fable)


def test_detection_point_run_scope_requires_three_or_five_repeats():
    valid = RunCreate(name="points", suite_id="suite", test_scope="detection_points", repeat_count=3)
    assert valid.test_scope == "detection_points"
    assert RunCreate(name="points", suite_id="suite", test_scope="detection_points").repeat_count == 3
    try:
        RunCreate(name="points", suite_id="suite", test_scope="detection_points", repeat_count=1)
    except ValueError as exc:
        assert "repeat_count" in str(exc)
    else:
        raise AssertionError("detection_points must reject repeat_count=1")


def _probe(point, status="pass", labels=None, **kwargs):
    return {
        "scoring_rules": {"detection_point_mode": True, "detection_point": point, **kwargs},
        "status": status,
        "labels": labels or [],
        "evidence_ref": f"{point}-ref",
        "observed": "structured evidence",
    }


def test_fable_identity_requires_positive_negative_and_tamper_controls():
    assessment = build_detection_point_assessment([
        _probe("fable5_behavior", positive_control=True),
        _probe("fable5_behavior", negative_control=True),
        _probe("fable5_behavior", tamper_control=True),
    ])
    assert assessment["identity_assessment"]["model_identity"] == "fable5_consistent"
    assert assessment["identity_assessment"]["origin_verified"] is False


def test_single_anthropic_error_phrase_does_not_prove_official_origin():
    assessment = build_detection_point_assessment([
        _probe("fable5_behavior", observed="Anthropic error wording"),
    ])
    identity = assessment["identity_assessment"]
    assert identity["model_identity"] == "fable5_inconclusive"
    assert identity["origin_verified"] is False


def test_kiro_leak_is_preserved_without_model_swap_claim():
    assessment = build_detection_point_assessment([
        _probe("kiro_bedrock", status="warning", labels=["kiro_identity_leak"]),
    ])
    identity = assessment["identity_assessment"]
    assert "kiro_identity_leak" in assessment["detection_points"]["items"][1]["labels"]
    assert identity["model_identity"] != "model_swap_suspected"


def test_active_probe_without_inbound_capture_keeps_client_unobservable():
    assessment = build_detection_point_assessment([
        _probe("claude_code_client", observed="gateway-compatible response"),
    ])
    assert assessment["identity_assessment"]["client_likelihood"] == "unobservable"


def test_inbound_claude_code_headers_are_client_like_only():
    assessment = build_detection_point_assessment(
        [_probe("claude_code_client")],
        inbound_request={"observed": True, "header_names": ["x-claude-code-session-id", "anthropic-beta"]},
    )
    identity = assessment["identity_assessment"]
    assert identity["client_likelihood"] == "claude_code_like"
    assert identity["origin_verified"] is False


def test_origin_requires_endpoint_request_id_and_billing_or_audit_closure():
    partial = build_detection_point_assessment(
        [], control_plane_evidence={"endpoint_host": "api.anthropic.com", "request_id": "req_1"}
    )
    complete = build_detection_point_assessment(
        [], control_plane_evidence={"endpoint_host": "api.anthropic.com", "request_id": "req_1", "billing_or_audit_ref": "audit_1"}
    )
    assert partial["identity_assessment"]["origin_verified"] is False
    assert complete["identity_assessment"]["origin_verified"] is True


def test_operational_failure_is_inconclusive_not_protocol_failure():
    assessment = build_detection_point_assessment([
        _probe("fable5_behavior", status="operationally_inconclusive", labels=["provider_temporarily_unavailable"]),
    ])
    identity = assessment["identity_assessment"]
    assert assessment["detection_points"]["items"][0]["status"] == "operationally_inconclusive"
    assert identity["model_identity"] == "operationally_inconclusive"


def test_seed_backfills_detection_metadata_without_overwriting_custom_rules():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        seed_demo_data(db)
        seeded = db.query(TestCase).filter(TestCase.suite_id == "claude_full_35").first()
        assert seeded is not None
        rules = dict(seeded.scoring_rules or {})
        rules["custom_owner_note"] = "keep-me"
        for key in ("detection_point_mode", "detection_point", "positive_control", "negative_control", "tamper_control"):
            rules.pop(key, None)
        seeded.scoring_rules = rules
        db.commit()
        seed_demo_data(db)
        db.refresh(seeded)
        assert seeded.scoring_rules["custom_owner_note"] == "keep-me"
        assert seeded.scoring_rules["detection_point_mode"] is True
