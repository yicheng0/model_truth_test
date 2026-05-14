from __future__ import annotations

import os
import asyncio
import json

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_claude_eval.db")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")
os.environ.setdefault("SKIP_BUILTIN_CHANNEL_CLEANUP", "1")

from fastapi.testclient import TestClient
import httpx
from sqlalchemy import delete, func, select

from app.database import SessionLocal, init_db
from app.main import app, cors_origins
from app.models import BaselineResult, BaselineSnapshot, Channel, ChannelAlert, ChannelTaxonomySetting, Comparison, FeishuBroadcastSetting, Report, Result, Run, RunChannel, ScheduledChannelTest, TestCase as TestCaseModel, TestSuite as TestSuiteModel
from app.schemas import ChannelCreate, RunCreate, TestCaseCreate
from app.services import _anthropic_compatible_call, _anthropic_messages_url, _aws_bedrock_messages_call, _live_call, _merged_channel_credentials, _openai_compatible_call, apply_repeat_consistency_scores, build_raw_request, classify_claude_message_id, create_alerts_for_run, create_case, create_channel, create_run, execute_run, execute_scheduled_channel_test, invoke_channel, score_result, seed_demo_data


def reset_database() -> None:
    init_db()
    with SessionLocal() as db:
        for model in [ChannelTaxonomySetting, FeishuBroadcastSetting, ChannelAlert, ScheduledChannelTest, Report, Comparison, BaselineResult, BaselineSnapshot, Result, RunChannel, Run, TestCaseModel, TestSuiteModel, Channel]:
            db.execute(delete(model))
        db.commit()
        seed_demo_data(db)
        seed_test_channels(db)


def seed_test_channels(db) -> None:  # noqa: ANN001
    channels = [
        ChannelCreate(id="anthropic_official", name="Anthropic Official", provider_type="anthropic", role="gold", base_url="https://api.anthropic.com", model_name="claude-sonnet-4-5", is_reference=True),
        ChannelCreate(id="aws_bedrock", name="AWS Bedrock Claude", provider_type="aws_bedrock", role="official_cloud", base_url="bedrock-runtime", model_name="anthropic.claude-sonnet-4-5-v1:0", is_reference=True),
        ChannelCreate(id="azure_foundry", name="Azure AI Foundry Claude", provider_type="azure_foundry", role="official_cloud", base_url="https://example.services.ai.azure.com", model_name="claude-sonnet-4-5", is_reference=True),
        ChannelCreate(id="third_party_demo", name="Third-party Relay Demo", provider_type="third_party_anthropic", role="candidate", base_url="https://relay.example/v1", model_name="claude-sonnet-4-5"),
        ChannelCreate(id="openai_compat_demo", name="OpenAI-compatible Relay Demo", provider_type="third_party_openai_compatible", role="candidate", base_url="https://relay.example/v1", model_name="claude-sonnet-4-5"),
        ChannelCreate(id="negative_sample", name="Negative Sample", provider_type="third_party_openai_compatible", role="negative", base_url="https://non-claude.example/v1", model_name="gpt-like-model"),
    ]
    for channel in channels:
        create_channel(db, channel)


def create_ready_baseline(client: TestClient, name: str = "managed baseline") -> tuple[str, dict, dict]:
    suite_id = client.get("/api/suites").json()[0]["id"]
    run = client.post(
        "/api/baselines/build",
        json={"name": name, "suite_id": suite_id, "channel_ids": {"gold": ["anthropic_official"]}, "use_mock": True},
    ).json()
    snapshot = next(item for item in client.get("/api/baselines", params={"suite_id": suite_id}).json() if item["source_run_id"] == run["id"])
    return suite_id, run, snapshot


def manual_thinking_temperature_probe_case() -> TestCaseModel:
    return TestCaseModel(
        id="manual_thinking_temperature_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="AWS thinking temperature 纯度探针",
        prompt="请用一句话回答：这是 thinking temperature 纯度探针。",
        request_params={
            "max_tokens": 2048,
            "temperature": 0.2,
            "thinking": {"type": "enabled", "budget_tokens": 1024},
            "reasoning_effort": "medium",
        },
        scoring_rules={
            "expected_error_any": [
                "temperature may only be set to 1 when thinking is enabled",
                "temperature",
                "thinking",
            ],
            "expected_error_contains": "temperature may only be set to 1 when thinking is enabled",
            "expected_error_variant_any": ["temperature", "thinking"],
        },
        is_hidden=False,
        enabled=True,
    )


def manual_thinking_adaptive_enabled_probe_case() -> TestCaseModel:
    return TestCaseModel(
        id="manual_thinking_adaptive_enabled_probe",
        suite_id="manual_model_request_probe",
        module="manual_probe",
        title="thinking.adaptive.enabled 纯度探针",
        prompt="回复OK",
        request_params={
            "max_tokens": 2000,
            "temperature": 0,
            "thinking": {
                "type": "enabled",
                "adaptive": {"enabled": True},
                "budget_tokens": 8000,
                "max_tokens": 2000,
            },
        },
        scoring_rules={
            "expected_error_any": [
                "adaptive",
                "enabled",
                "output_config.effort",
                "not supported",
                "ValidationException",
                "thinking",
            ],
            "expected_error_missing_label": "thinking_adaptive_enabled_not_rejected",
            "expected_error_variant_label": "provider_error_variant",
        },
        is_hidden=False,
        enabled=True,
    )


def test_health_check_reports_database_ok() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_mock_run_generates_results_comparisons_and_reports() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs",
            json={
                "name": "pytest mock run",
                "suite_id": suite_id,
                "channel_ids": {
                    "gold": ["anthropic_official"],
                    "candidate": ["third_party_demo"],
                },
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert response.status_code == 200
        run = response.json()

        detail = client.get(f"/api/runs/{run['id']}/results")
        assert detail.status_code == 200
        payload = detail.json()

    assert payload["run"]["status"] == "completed"
    assert payload["run"]["completed_jobs"] == payload["run"]["total_jobs"]
    assert len(payload["results"]) == payload["run"]["total_jobs"]
    assert payload["comparisons"]
    assert payload["reports"]


def test_default_suite_is_optimized_28_and_removes_stale_default_cases() -> None:
    reset_database()
    with SessionLocal() as db:
        suite = db.get(TestSuiteModel, "claude_full_35")
        create_case(
            db,
            TestCaseCreate(
                id="identity_03",
                suite_id="claude_full_35",
                module="identity",
                title="stale case",
                prompt="stale",
                enabled=True,
            ),
        )
        seed_demo_data(db)
        case_ids = list(db.scalars(select(TestCaseModel.id).where(TestCaseModel.suite_id == "claude_full_35").order_by(TestCaseModel.sort_order)).all())

    assert suite is not None
    assert suite.version == "2026.05-optimized-28"
    assert len(case_ids) == 28
    assert "identity_03" not in case_ids
    assert case_ids[:5] == ["websearch_01", "identity_01", "identity_02", "identity_04", "identity_10"]
    assert "protocol_09" not in case_ids
    with SessionLocal() as db:
        quick_count = sum(
            1
            for case in db.scalars(select(TestCaseModel).where(TestCaseModel.suite_id == "claude_full_35")).all()
            if (case.scoring_rules or {}).get("quick") is True
        )
    assert quick_count == 8


def test_quick_run_uses_only_quick_cases() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs",
            json={
                "name": "pytest quick run",
                "suite_id": suite_id,
                "test_scope": "quick",
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert response.status_code == 200
        run = response.json()
        payload = client.get(f"/api/runs/{run['id']}/results").json()

    assert payload["run"]["test_scope"] == "quick"
    assert payload["run"]["total_jobs"] == 16
    assert len(payload["results"]) == 16


def test_score_result_supports_optimized_rules() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = db.get(TestCaseModel, "protocol_02")
        assert channel is not None and case is not None
        score, labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_test",
                "tool_calls": [{"type": "tool_use", "name": "wrong_tool", "input": {"order_id": "bad"}}],
                "stop_reason": "tool_use",
                "stream_events": ["message_stop"],
                "content_text": "",
                "status_code": 200,
            },
        )

        json_case = db.get(TestCaseModel, "format_01")
        json_score, json_labels = score_result(
            channel,
            json_case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_test",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": '{"risk":"low"}',
                "status_code": 200,
            },
        )

        stop_case = db.get(TestCaseModel, "protocol_04")
        stop_score, stop_labels = score_result(
            channel,
            stop_case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_test",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "stream_events": ["message_stop"],
                "content_text": "第一句。第二句。",
                "status_code": 200,
            },
        )

    assert score < 100
    assert "tool_name_mismatch" in labels
    assert "tool_input_mismatch" in labels
    assert json_score < 100
    assert "json_missing:evidence" in json_labels
    assert stop_score < 100
    assert "stop_sequence_not_enforced" in stop_labels
    assert "stop_sequence_leaked" in stop_labels


def test_score_result_validates_thinking_temperature_expected_error() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None

        exact_score, exact_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "`temperature` may only be set to 1 when thinking is enabled"}},
                "error": "`temperature` may only be set to 1 when thinking is enabled",
                "status_code": 500,
                "content_text": "",
            },
        )
        variant_score, variant_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "Thinking is not compatible with a custom temperature value"}},
                "error": "Thinking is not compatible with a custom temperature value",
                "status_code": 500,
                "content_text": "",
            },
        )
        normal_score, normal_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_bdrk_01ok",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": "ok",
                "status_code": 200,
            },
        )

    assert exact_score == 100
    assert exact_labels == []
    assert variant_score == 100
    assert variant_labels == ["provider_error_variant"]
    assert normal_score == 0
    assert normal_labels == ["thinking_temperature_not_rejected"]


def test_score_result_validates_thinking_adaptive_enabled_expected_error() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_adaptive_enabled_probe_case()
        assert channel is not None

        variant_score, variant_labels = score_result(
            channel,
            case,
            {
                "raw_response": {
                    "error": {
                        "message": '"***.***.enabled" is not supported for this model. Use "***.***.adaptive" and "output_config.effort" to control thinking behavior.'
                    }
                },
                "error": '"***.***.enabled" is not supported for this model. Use "***.***.adaptive" and "output_config.effort" to control thinking behavior.',
                "status_code": 400,
                "content_text": "",
            },
        )
        normal_score, normal_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 16, "output_tokens": 6},
                "provider_message_id": "msg_bdrk_01ok",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": "OK",
                "status_code": 200,
            },
        )

    assert variant_score == 100
    assert variant_labels == ["provider_error_variant"]
    assert normal_score == 0
    assert normal_labels == ["thinking_adaptive_enabled_not_rejected"]


def test_websearch_seed_case_uses_web_search_probe_payload() -> None:
    reset_database()
    with SessionLocal() as db:
        case = db.get(TestCaseModel, "websearch_01")

    assert case is not None
    assert case.title == "Web Search AWS 纯度报错探针"
    assert case.request_params["max_tokens"] == 900
    assert case.request_params["stream"] is True
    assert case.request_params["tools"][0]["type"] == "web_search_20260209"
    assert case.scoring_rules["expected_error_missing_label"] == "web_search_not_rejected"


def test_score_result_validates_web_search_expected_error() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = db.get(TestCaseModel, "websearch_01")
        assert channel is not None and case is not None

        exact_score, exact_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "web search is not available on this channel"}},
                "error": "web search is not available on this channel",
                "status_code": 500,
                "content_text": "",
            },
        )
        variant_score, variant_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"error": {"message": "unsupported tool web_search_20260209"}},
                "error": "unsupported tool web_search_20260209",
                "status_code": 500,
                "content_text": "",
            },
        )
        normal_score, normal_labels = score_result(
            channel,
            case,
            {
                "raw_response": {"type": "message"},
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "provider_message_id": "msg_bdrk_01ok",
                "tool_calls": [],
                "stop_reason": "end_turn",
                "stream_events": ["message_stop"],
                "content_text": "最新更新：标题、发布日期、链接",
                "status_code": 200,
            },
        )

    assert exact_score == 100
    assert exact_labels == ["provider_error_variant"]
    assert variant_score == 100
    assert variant_labels == ["provider_error_variant"]
    assert normal_score == 0
    assert normal_labels == ["web_search_not_rejected"]


def test_repeat_consistency_penalizes_drift_between_attempts() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(
            db,
            RunCreate(
                name="consistency run",
                suite_id=suite_id,
                channel_ids={"gold": ["anthropic_official"]},
                repeat_count=2,
                concurrency=1,
                use_mock=True,
            ),
        )
        db.add(
            Result(
                id="res_consistency_1",
                run_id=run.id,
                test_case_id="protocol_05",
                channel_id="anthropic_official",
                attempt_index=1,
                normalized_response={"content_text": "天空是蓝色的，因为瑞利散射。"},
                raw_request={},
                raw_response={},
                metrics={},
                score=100,
                labels=[],
            )
        )
        db.add(
            Result(
                id="res_consistency_2",
                run_id=run.id,
                test_case_id="protocol_05",
                channel_id="anthropic_official",
                attempt_index=2,
                normalized_response={"content_text": "完全不同的回答，讨论数据库事务隔离级别。"},
                raw_request={},
                raw_response={},
                metrics={},
                score=100,
                labels=[],
            )
        )
        db.commit()
        apply_repeat_consistency_scores(db, run.id)
        second = db.get(Result, "res_consistency_2")

    assert second is not None
    assert second.score == 80
    assert "repeat_inconsistent" in second.labels


def test_execute_run_honors_concurrency_and_result_count() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(
            db,
            RunCreate(
                name="direct mock run",
                suite_id=suite_id,
                channel_ids={"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                repeat_count=2,
                concurrency=8,
                use_mock=True,
            ),
        )
        run_id = run.id

    import asyncio

    asyncio.run(execute_run(SessionLocal, run_id, use_mock=True))

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
        report_count = db.scalar(select(func.count()).select_from(Report).where(Report.run_id == run_id))

    assert run is not None
    assert run.status == "completed"
    assert result_count == run.total_jobs
    assert report_count >= 1


def test_baseline_build_then_candidate_eval_reuses_snapshot() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run_response = client.post(
            "/api/baselines/build",
            json={
                "name": "pytest reusable baseline",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "official_cloud": ["aws_bedrock"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert baseline_run_response.status_code == 200
        baseline_run = baseline_run_response.json()

        baselines = client.get("/api/baselines", params={"suite_id": suite_id}).json()
        snapshot = next(item for item in baselines if item["source_run_id"] == baseline_run["id"])
        assert snapshot["status"] == "ready"

        eval_response = client.post(
            "/api/runs",
            json={
                "name": "pytest candidate eval",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert eval_response.status_code == 200
        run = eval_response.json()
        payload = client.get(f"/api/runs/{run['id']}/results").json()

    assert payload["run"]["mode"] == "candidate_eval"
    assert payload["baseline_snapshot"]["id"] == snapshot["id"]
    assert payload["baseline_results"]
    assert payload["comparisons"]
    assert payload["reports"][0]["evidence"]["baseline_snapshot_id"] == snapshot["id"]
    evidence = payload["reports"][0]["evidence"]
    assert evidence["dimension_scores"]["authenticity"] is not None
    assert evidence["confidence"] in {"medium", "high"}
    assert isinstance(evidence["label_explanations"], list)


def test_baseline_snapshot_name_can_be_updated() -> None:
    reset_database()
    with TestClient(app) as client:
        _suite_id, _run, snapshot = create_ready_baseline(client, "old baseline name")
        response = client.patch(f"/api/baselines/{snapshot['id']}", json={"name": " renamed baseline "})

    assert response.status_code == 200
    assert response.json()["name"] == "renamed baseline"


def test_unreferenced_baseline_snapshot_can_be_deleted_with_results() -> None:
    reset_database()
    with TestClient(app) as client:
        _suite_id, _run, snapshot = create_ready_baseline(client, "delete me")
        delete_response = client.delete(f"/api/baselines/{snapshot['id']}")
        get_response = client.get(f"/api/baselines/{snapshot['id']}")

    with SessionLocal() as db:
        result_count = db.scalar(select(func.count()).select_from(BaselineResult).where(BaselineResult.baseline_snapshot_id == snapshot["id"]))

    assert delete_response.status_code == 200
    assert delete_response.json() == {"deleted": True}
    assert get_response.status_code == 404
    assert result_count == 0


def test_delete_baseline_snapshot_rejects_candidate_eval_reference() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, _run, snapshot = create_ready_baseline(client, "referenced baseline")
        eval_response = client.post(
            "/api/runs",
            json={
                "name": "uses baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        delete_response = client.delete(f"/api/baselines/{snapshot['id']}")

    assert eval_response.status_code == 200
    assert delete_response.status_code == 409


def test_delete_baseline_snapshot_rejects_scheduled_test_reference() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, _run, snapshot = create_ready_baseline(client, "scheduled referenced baseline")
        schedule_response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "uses baseline schedule",
                "channel_id": "third_party_demo",
                "suite_id": suite_id,
                "baseline_snapshot_id": snapshot["id"],
                "interval_minutes": 60,
            },
        )
        delete_response = client.delete(f"/api/baselines/{snapshot['id']}")

    assert schedule_response.status_code == 200
    assert delete_response.status_code == 409


def test_delete_source_run_rejects_when_generated_baseline_is_referenced() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, run, snapshot = create_ready_baseline(client, "source protected baseline")
        eval_response = client.post(
            "/api/runs",
            json={
                "name": "uses generated baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        delete_response = client.delete(f"/api/runs/{run['id']}")

    assert eval_response.status_code == 200
    assert delete_response.status_code == 409


def test_candidate_eval_requires_valid_baseline() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        response = client.post(
            "/api/runs",
            json={
                "name": "missing baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )

    assert response.status_code == 400
    assert "baseline_snapshot_id" in response.json()["detail"]


def test_candidate_eval_rejects_stale_baseline_after_case_change() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run = client.post(
            "/api/baselines/build",
            json={
                "name": "stale baseline",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"]},
                "use_mock": True,
            },
        ).json()
        snapshot = next(item for item in client.get("/api/baselines", params={"suite_id": suite_id}).json() if item["source_run_id"] == baseline_run["id"])
        case_id = client.get("/api/test-cases", params={"suite_id": suite_id}).json()[0]["id"]
        patch_response = client.patch(f"/api/test-cases/{case_id}", json={"prompt": "changed prompt invalidates the baseline"})
        assert patch_response.status_code == 200

        response = client.post(
            "/api/runs",
            json={
                "name": "should reject stale baseline",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )

    assert response.status_code == 400
    assert "fingerprint" in response.json()["detail"]


def test_candidate_eval_keeps_baseline_ready_after_channel_config_changes() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id, _run, snapshot = create_ready_baseline(client, "channel config can change")
        patch_response = client.patch(
            "/api/channels/anthropic_official",
            json={
                "is_reference": False,
                "base_url": "https://changed.example/v1",
                "model_name": "changed-model",
                "auth_config": {"api_key": "changed-key"},
            },
        )
        eval_response = client.post(
            "/api/runs",
            json={
                "name": "uses historical baseline after channel change",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        refreshed = client.get(f"/api/baselines/{snapshot['id']}")

    assert patch_response.status_code == 200
    assert eval_response.status_code == 200
    assert refreshed.status_code == 200
    assert refreshed.json()["status"] == "ready"


def test_invalid_baseline_with_results_is_restored_when_only_channel_check_was_stale() -> None:
    reset_database()
    with TestClient(app) as client:
        _suite_id, _run, snapshot = create_ready_baseline(client, "restore invalid baseline")

    with SessionLocal() as db:
        stored = db.get(BaselineSnapshot, snapshot["id"])
        assert stored is not None
        stored.status = "invalid"
        db.commit()

    with TestClient(app) as client:
        response = client.get(f"/api/baselines/{snapshot['id']}")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_scheduled_channel_test_run_now_creates_run_and_alert_when_risky(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)

    async def fake_signature_interop(source, relay, stream=False):  # noqa: ANN001, ARG001
        return {
            "ok": True,
            "status": "pass",
            "reason": "兼容：relay 成功接受 source 的 thinking block signature",
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "source_message_id": "msg_bdrk_01source",
            "source_message_channel_type": "AWS Bedrock",
            "relay_message_id": "msg_vrtx_01relay",
            "relay_message_channel_type": "Vertex",
            "thinking_block_count": 1,
            "signature_prefixes": ["sig-source"],
            "fallback_note": "fallback note",
            "steps": [{"name": "最终判定", "status": "ok", "detail": "兼容", "excerpt": None}],
        }

    monkeypatch.setattr("app.services.test_signature_interop", fake_signature_interop)
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run = client.post(
            "/api/baselines/build",
            json={
                "name": "scheduled baseline",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "official_cloud": ["aws_bedrock"]},
                "use_mock": True,
            },
        ).json()
        snapshot = next(item for item in client.get("/api/baselines", params={"suite_id": suite_id}).json() if item["source_run_id"] == baseline_run["id"])
        schedule_response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "negative sample patrol",
                "channel_id": "negative_sample",
                "suite_id": suite_id,
                "baseline_snapshot_id": snapshot["id"],
                "interval_minutes": 60,
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": True,
            },
        )
        assert schedule_response.status_code == 200
        schedule = schedule_response.json()

        run_now = client.post(f"/api/scheduled-tests/{schedule['id']}/run-now")
        assert run_now.status_code == 200
        updated_schedule = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    assert updated_schedule["last_run_id"]
    assert updated_schedule["last_status"] == "completed"
    assert alerts
    assert alerts[0]["channel_id"] == "negative_sample"
    assert alerts[0]["notification_status"] == "skipped"

    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == updated_schedule["last_run_id"], Report.channel_id == "negative_sample"))

    assert report is not None
    assert report.evidence["signature_interop"]["ok"] is True
    assert report.evidence["signature_interop"]["status"] == "skipped"


def test_scheduled_channel_test_signature_interop_failure_creates_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)

    async def fake_signature_interop(source, relay, stream=False):  # noqa: ANN001, ARG001
        return {
            "ok": False,
            "status": "fail",
            "reason": "signature 不兼容：relay 无法使用 source 生成的 signature",
            "source_channel_id": source.id,
            "relay_channel_id": relay.id,
            "source_message_id": "msg_bdrk_01source",
            "source_message_channel_type": "AWS Bedrock",
            "relay_message_id": None,
            "relay_message_channel_type": "unknown",
            "thinking_block_count": 1,
            "signature_prefixes": ["sig-bad"],
            "fallback_note": "fallback note",
            "steps": [{"name": "最终判定", "status": "fail", "detail": "signature 不兼容", "excerpt": None}],
        }

    monkeypatch.setattr("app.services.test_signature_interop", fake_signature_interop)
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run = client.post(
            "/api/baselines/build",
            json={
                "name": "signature patrol baseline",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "official_cloud": ["aws_bedrock"]},
                "use_mock": True,
            },
        ).json()
        snapshot = next(item for item in client.get("/api/baselines", params={"suite_id": suite_id}).json() if item["source_run_id"] == baseline_run["id"])
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "signature patrol",
                "channel_id": "third_party_demo",
                "suite_id": suite_id,
                "baseline_snapshot_id": snapshot["id"],
                "interval_minutes": 60,
                "repeat_count": 1,
                "concurrency": 4,
                "use_mock": False,
            },
        ).json()

    asyncio.run(execute_scheduled_channel_test(SessionLocal, schedule["id"], advance_next_run=False))

    with TestClient(app) as client:
        updated_schedule = client.get(f"/api/scheduled-tests/{schedule['id']}").json()
        alerts = client.get("/api/alerts", params={"status": "pending_review"}).json()

    signature_alerts = [alert for alert in alerts if "signature_interop_failed" in (alert.get("trigger_labels") or [])]
    assert updated_schedule["last_status"] == "completed"
    assert signature_alerts

    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.run_id == updated_schedule["last_run_id"], Report.channel_id == "third_party_demo"))

    assert report is not None
    assert report.evidence["signature_interop"]["status"] == "fail"
    assert "signature_interop_failed" in report.evidence["labels"]
    assert "Thinking Signature 互通" in (report.markdown or "")


def test_alert_review_updates_status_and_reviewer() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run = client.post(
            "/api/baselines/build",
            json={"name": "review baseline", "suite_id": suite_id, "channel_ids": {"gold": ["anthropic_official"]}, "use_mock": True},
        ).json()
        snapshot = next(item for item in client.get("/api/baselines", params={"suite_id": suite_id}).json() if item["source_run_id"] == baseline_run["id"])
        run = client.post(
            "/api/runs",
            json={
                "name": "review risky run",
                "suite_id": suite_id,
                "mode": "candidate_eval",
                "baseline_snapshot_id": snapshot["id"],
                "channel_ids": {"negative": ["negative_sample"]},
                "use_mock": True,
            },
        ).json()

    import asyncio

    asyncio.run(create_alerts_for_run(SessionLocal, run["id"]))

    with TestClient(app) as client:
        alert = client.get("/api/alerts", params={"status": "pending_review"}).json()[0]
        response = client.patch(
            f"/api/alerts/{alert['id']}/review",
            json={"status": "confirmed_issue", "reviewer_name": "admin", "review_note": "已联系供应商复查"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "confirmed_issue"
    assert payload["reviewer_name"] == "admin"
    assert payload["reviewed_at"]


def test_scheduled_test_rejects_reference_channel() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run = client.post(
            "/api/baselines/build",
            json={"name": "reject baseline", "suite_id": suite_id, "channel_ids": {"gold": ["anthropic_official"]}, "use_mock": True},
        ).json()
        snapshot = next(item for item in client.get("/api/baselines", params={"suite_id": suite_id}).json() if item["source_run_id"] == baseline_run["id"])
        response = client.post(
            "/api/scheduled-tests",
            json={
                "name": "bad patrol",
                "channel_id": "anthropic_official",
                "suite_id": suite_id,
                "baseline_snapshot_id": snapshot["id"],
                "interval_minutes": 60,
            },
        )

    assert response.status_code == 400
    assert "candidate" in response.json()["detail"]


def test_feishu_broadcast_setting_masks_secret_and_preserves_existing_secret() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.patch(
            "/api/settings/feishu-broadcast",
            json={
                "enabled": True,
                "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
                "webhook_secret": "secret-value",
                "app_base_url": "http://localhost:5174/",
                "daily_report_time": "09:00",
                "timezone": "Asia/Shanghai",
            },
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["webhook_configured"] is True
        assert payload["secret_configured"] is True
        assert "test-token" not in payload["webhook_preview"]

        response = client.patch("/api/settings/feishu-broadcast", json={"enabled": False})
        assert response.status_code == 200
        payload = response.json()

    assert payload["enabled"] is False
    assert payload["secret_configured"] is True
    assert payload["app_base_url"] == "http://localhost:5174"


def test_channel_taxonomy_setting_returns_defaults_and_allows_label_updates() -> None:
    reset_database()
    with TestClient(app) as client:
        defaults = client.get("/api/settings/channel-taxonomy")
        updated = client.patch(
            "/api/settings/channel-taxonomy",
            json={
                "role_labels": {"candidate": "客户待测渠道"},
                "provider_type_labels": {"third_party_anthropic": "Claude 中转协议"},
            },
        )
        reset_candidate = client.patch("/api/settings/channel-taxonomy", json={"role_labels": {"candidate": ""}})

    assert defaults.status_code == 200
    default_payload = defaults.json()
    assert default_payload["role_labels"]["candidate"] == "待测第三方"
    assert default_payload["provider_type_labels"] == {}
    assert default_payload["model_options"] == []
    assert updated.status_code == 200
    assert updated.json()["role_labels"]["candidate"] == "客户待测渠道"
    assert updated.json()["provider_type_labels"]["third_party_anthropic"] == "Claude 中转协议"
    assert reset_candidate.status_code == 200
    assert reset_candidate.json()["role_labels"]["candidate"] == "待测第三方"


def test_channel_taxonomy_allows_custom_keys_and_run_uses_reference_semantics() -> None:
    reset_database()
    with TestClient(app) as client:
        custom = client.patch(
            "/api/settings/channel-taxonomy",
            json={
                "role_labels": {"custom_role": "自定义角色"},
                "provider_type_labels": {"custom_provider": "自定义供应商"},
                "model_options": ["custom-model"],
            },
        )
        suite_id = client.get("/api/suites").json()[0]["id"]
        client.patch("/api/settings/channel-taxonomy", json={"role_labels": {"candidate": "客户待测渠道"}})
        response = client.post(
            "/api/runs",
            json={
                "name": "taxonomy labels do not affect role keys",
                "suite_id": suite_id,
                "channel_ids": {"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                "use_mock": True,
            },
        )
        payload = client.get(f"/api/runs/{response.json()['id']}/results").json()

    assert custom.status_code == 200
    assert custom.json()["role_labels"]["custom_role"] == "自定义角色"
    assert custom.json()["provider_type_labels"]["custom_provider"] == "自定义供应商"
    assert custom.json()["model_options"] == ["custom-model"]
    assert response.status_code == 200
    assert payload["run_channels"]
    assert {item["role_in_run"] for item in payload["run_channels"]} == {"reference", "candidate"}
    assert payload["reports"]


def test_channel_create_accepts_custom_provider_type_and_defaults_role() -> None:
    reset_database()
    with TestClient(app) as client:
        created = client.post(
            "/api/channels",
            json={
                "name": "Custom Internal Channel",
                "provider_type": "customer_gateway",
                "model_name": "claude-via-gateway",
                "enabled": True,
            },
        )
        reference = client.post(
            "/api/channels",
            json={
                "name": "Custom Reference Channel",
                "provider_type": "official-internal",
                "model_name": "claude-reference",
                "is_reference": True,
                "enabled": True,
            },
        )

    assert created.status_code == 200
    assert created.json()["provider_type"] == "customer_gateway"
    assert created.json()["role"] == "candidate"
    assert "protocol_type" not in created.json()
    assert reference.status_code == 200
    assert reference.json()["role"] == "gold"


def test_channel_api_key_is_readable_and_updatable() -> None:
    reset_database()
    with TestClient(app) as client:
        created = client.post(
            "/api/channels",
            json={
                "name": "Editable Key Channel",
                "provider_type": "customer_gateway",
                "model_name": "claude-via-gateway",
                "auth_config": {"api_key": "first-key"},
                "enabled": True,
            },
        )
        channel_id = created.json()["id"]
        updated = client.patch(f"/api/channels/{channel_id}", json={"auth_config": {"api_key": "second-key"}})
        cleared = client.patch(f"/api/channels/{channel_id}", json={"auth_config": {}})

    assert created.status_code == 200
    assert created.json()["auth_config"]["api_key"] == "first-key"
    assert updated.status_code == 200
    assert updated.json()["auth_config"]["api_key"] == "second-key"
    assert cleared.status_code == 200
    assert cleared.json()["auth_config"] == {}


def test_runtime_credentials_merge_channel_api_key_and_per_run_override() -> None:
    channel = Channel(
        id="with_key",
        name="With Key",
        provider_type="customer_gateway",
        role="candidate",
        model_name="custom-model",
        auth_config_encrypted={"api_key": "stored-key", "region": "us-east-1"},
        enabled=True,
    )

    assert _merged_channel_credentials(channel, {}) == {"api_key": "stored-key", "region": "us-east-1"}
    assert _merged_channel_credentials(channel, {"api_key": "runtime-key"}) == {"api_key": "runtime-key", "region": "us-east-1"}


def test_live_call_uses_anthropic_messages_for_custom_provider_key(monkeypatch) -> None:
    reset_database()
    called: dict[str, object] = {}

    async def fake_anthropic_call(channel, raw_request, credentials):  # noqa: ANN001
        called["provider_type"] = channel.provider_type
        return {
            "id": "msg_test",
            "type": "message",
            "model": channel.model_name,
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._anthropic_compatible_call", fake_anthropic_call)

    with SessionLocal() as db:
        channel = Channel(
            id="custom_protocol_channel",
            name="Custom Protocol Channel",
            provider_type="customer_gateway",
            role="candidate",
            model_name="custom-model",
            enabled=True,
        )
        db.add(channel)
        db.commit()
        case = db.get(TestCaseModel, "identity_01")
        assert case is not None
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(_live_call(channel, case, raw_request, {}))

    assert called == {"provider_type": "customer_gateway"}
    assert response["type"] == "message"


def test_live_call_dispatches_openai_compatible_provider(monkeypatch) -> None:
    reset_database()
    called: dict[str, object] = {}

    async def fake_openai_call(channel, raw_request, credentials):  # noqa: ANN001
        called["provider_type"] = channel.provider_type
        called["base_url"] = channel.base_url
        return {
            "id": "chatcmpl_test",
            "object": "chat.completion",
            "model": channel.model_name,
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._openai_compatible_call", fake_openai_call)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = db.get(TestCaseModel, "identity_01")
        assert channel is not None and case is not None
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(_live_call(channel, case, raw_request, {"api_key": "test-key"}))

    assert called == {"provider_type": "third_party_openai_compatible", "base_url": "https://relay.example/v1"}
    assert response["object"] == "chat.completion"


def test_live_call_dispatches_aws_bedrock_provider(monkeypatch) -> None:
    reset_database()
    called: dict[str, object] = {}

    def fake_aws_call(channel, case, credentials):  # noqa: ANN001
        called["provider_type"] = channel.provider_type
        called["case_id"] = case.id
        called["region"] = credentials["region"]
        return {
            "id": "aws_test",
            "type": "message",
            "model": channel.model_name,
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._aws_bedrock_call", fake_aws_call)

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = db.get(TestCaseModel, "identity_01")
        assert channel is not None and case is not None
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(_live_call(channel, case, raw_request, {"region": "us-west-2"}))

    assert called == {"provider_type": "aws_bedrock", "case_id": "identity_01", "region": "us-west-2"}
    assert response["type"] == "message"


def test_live_run_without_api_key_records_error_instead_of_mock() -> None:
    reset_database()
    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = db.get(TestCaseModel, "identity_01")
        assert channel is not None and case is not None
        normalized = asyncio.run(invoke_channel(channel, case, 1, {}, use_mock=False))

    assert normalized["request_mode"] == "live"
    assert normalized["request_attempted"] is False
    assert normalized["error"] == "缺少 API Key，未发起正式请求"
    assert normalized["content_text"] == ""


def test_openai_http_error_preserves_upstream_message(monkeypatch) -> None:
    reset_database()

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            return httpx.Response(
                503,
                json={"error": {"code": "model_not_found", "message": "模型 claude-bad 无可用渠道"}},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = db.get(TestCaseModel, "identity_01")
        assert channel is not None and case is not None
        channel.model_name = "claude-bad"
        raw_request = build_raw_request(channel, case)
        response = asyncio.run(invoke_channel(channel, case, 1, {"api_key": "test-key"}, use_mock=False))

    assert "模型 claude-bad 无可用渠道" in response["error"]


def test_channel_models_endpoint_returns_model_ids(monkeypatch) -> None:
    reset_database()

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def get(self, url, headers):  # noqa: ANN001
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={"data": [{"id": "claude-sonnet-4-6"}, {"id": "claude-haiku-4-5-20251001"}]},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Model List Channel",
                "provider_type": "apipro",
                "base_url": "https://api.wenwen-ai.com",
                "model_name": "claude-bad",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.get(f"/api/channels/{channel_id}/models")

    assert response.status_code == 200
    assert response.json() == ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]


def test_signature_interop_endpoint_passes_when_relay_accepts_signature(monkeypatch) -> None:
    reset_database()
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            calls.append({"url": url, "json": json, "headers": headers})
            request = httpx.Request("POST", url)
            if len(calls) == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "msg_bdrk_01source",
                        "type": "message",
                        "model": "claude-opus-4-6",
                        "content": [
                            {"type": "thinking", "thinking": "source thinking", "signature": "sig-source-compatible"},
                            {"type": "text", "text": "source answer"},
                        ],
                    },
                    request=request,
                )
            return httpx.Response(
                200,
                json={
                    "id": "msg_vrtx_01relay",
                    "type": "message",
                    "model": "claude-opus-4-6",
                    "content": [{"type": "text", "text": "relay answer"}],
                },
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Source",
                "provider_type": "anthropic",
                "base_url": "https://source.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "source-key"},
                "enabled": True,
            },
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Relay",
                "provider_type": "anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "relay-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["status"] == "pass"
    assert payload["source_message_channel_type"] == "AWS Bedrock"
    assert payload["relay_message_channel_type"] == "Vertex"
    assert payload["signature_prefixes"] == ["sig-source-compatible"]
    assert [step["name"] for step in payload["steps"]] == [
        "步骤 A：请求 Source thinking",
        "Signature 校验",
        "步骤 B：发送 Relay 复用请求",
        "最终判定",
    ]
    assert payload["steps"][-1]["status"] == "ok"
    assert calls[0]["url"] == "https://source.example/v1/messages"
    assert calls[1]["url"] == "https://relay.example/v1/messages"
    assert calls[1]["json"]["messages"][1]["content"][0]["signature"] == "sig-source-compatible"


def test_signature_interop_endpoint_reports_invalid_signature(monkeypatch) -> None:
    reset_database()
    calls = 0

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            nonlocal calls
            calls += 1
            request = httpx.Request("POST", url)
            if calls == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "msg_01source",
                        "type": "message",
                        "model": "claude-opus-4-6",
                        "content": [{"type": "thinking", "thinking": "source thinking", "signature": "sig-bad"}],
                    },
                    request=request,
                )
            return httpx.Response(
                400,
                json={"type": "error", "error": {"message": "Invalid `signature` in `thinking` block", "request_id": "req_123"}},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Source",
                "provider_type": "anthropic",
                "base_url": "https://source.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "source-key"},
                "enabled": True,
            },
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Relay",
                "provider_type": "anthropic",
                "base_url": "https://relay.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "relay-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is False
    assert payload["status"] == "fail"
    assert "signature 不兼容" in payload["reason"]
    assert "req_123" in payload["relay_raw_excerpt"]
    assert payload["source_message_channel_type"] == "Anthropic"
    assert payload["steps"][-1]["status"] == "fail"
    assert "signature 不兼容" in payload["steps"][-1]["detail"]


def test_signature_interop_rejects_source_without_signature(monkeypatch) -> None:
    reset_database()

    class FakeClient:
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN001
            return self

        async def __aexit__(self, *args):  # noqa: ANN002
            return None

        async def post(self, url, headers, json):  # noqa: ANN001
            request = httpx.Request("POST", url)
            return httpx.Response(
                200,
                json={"id": "msg_01source", "type": "message", "model": "claude-opus-4-6", "content": [{"type": "thinking", "thinking": "no signature"}]},
                request=request,
            )

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with TestClient(app) as client:
        source_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Source",
                "provider_type": "anthropic",
                "base_url": "https://source.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "source-key"},
                "enabled": True,
            },
        ).json()["id"]
        relay_id = client.post(
            "/api/channels",
            json={
                "name": "Signature Relay",
                "provider_type": "anthropic",
                "base_url": "https://relay.example",
                "model_name": "claude-opus-4-6",
                "auth_config": {"api_key": "relay-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            "/api/channels/signature-interop-test",
            json={"source_channel_id": source_id, "relay_channel_id": relay_id},
        )

    assert response.status_code == 400
    assert "缺少 signature" in response.json()["detail"]


def test_classify_claude_message_id_prefixes() -> None:
    assert classify_claude_message_id("msg_bdrk_01abc") == "AWS Bedrock"
    assert classify_claude_message_id("msg_vrtx_01abc") == "Vertex"
    assert classify_claude_message_id("msg_01abc") == "Anthropic"
    assert classify_claude_message_id("chatcmpl_abc") == "未知"


def test_simulate_message_response_defaults_to_aws() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post("/api/channels/simulate-message-response", json={})

    payload = response.json()
    assert response.status_code == 200
    assert payload["provider"] == "aws"
    assert payload["message_id"].startswith("msg_bdrk_01")
    assert payload["message_channel_type"] == "AWS Bedrock"
    assert payload["raw_response"]["id"] == payload["message_id"]
    assert payload["raw_response"]["type"] == "message"
    assert payload["raw_request"]["messages"][0]["role"] == "user"


def test_simulate_message_response_supports_all_claude_id_prefixes() -> None:
    reset_database()
    expected = {
        "aws": ("msg_bdrk_01", "AWS Bedrock"),
        "vertex": ("msg_vrtx_01", "Vertex"),
        "anthropic": ("msg_01", "Anthropic"),
    }
    with TestClient(app) as client:
        for provider, (prefix, channel_type) in expected.items():
            response = client.post("/api/channels/simulate-message-response", json={"provider": provider})
            payload = response.json()

            assert response.status_code == 200
            assert payload["provider"] == provider
            assert payload["message_id"].startswith(prefix)
            assert payload["message_channel_type"] == channel_type


def test_simulate_message_response_rejects_unknown_provider() -> None:
    reset_database()
    with TestClient(app) as client:
        response = client.post("/api/channels/simulate-message-response", json={"provider": "azure"})

    assert response.status_code == 400
    assert "Unsupported simulated provider" in response.json()["detail"]


def test_model_request_test_persists_manual_probe_result(monkeypatch) -> None:
    reset_database()

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        return (
            {
                "id": "msg_01manualprobe",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "真实响应内容"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 8, "output_tokens": 4},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Manual Probe Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={
                "prompt": "请返回一句真实内容",
                "system_prompt": "你是测试助手",
                "request_params": {"max_tokens": 32, "temperature": 0},
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["message_id"] == "msg_01manualprobe"
    assert payload["message_channel_type"] == "Anthropic"
    assert payload["request_protocol"] == "anthropic_messages"
    assert payload["run"]["mode"] == "manual_probe"
    assert payload["run"]["status"] == "completed"
    assert payload["result"]["normalized_response"]["content_text"] == "真实响应内容"
    assert payload["result"]["raw_request"]["messages"][0]["content"] == "请返回一句真实内容"

    with SessionLocal() as db:
        run = db.get(Run, payload["run"]["id"])
        result = db.get(Result, payload["result"]["id"])
        case = db.get(TestCaseModel, payload["result"]["test_case_id"])

    assert run is not None
    assert run.completed_jobs == 1
    assert result is not None
    assert result.raw_response["id"] == "msg_01manualprobe"
    assert case is not None
    assert case.system_prompt == "你是测试助手"


def test_manual_probe_is_hidden_from_default_suite_and_case_lists(monkeypatch) -> None:
    reset_database()

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        return (
            {
                "id": "msg_01hiddenmanualprobe",
                "type": "message",
                "role": "assistant",
                "model": channel.model_name,
                "content": [{"type": "text", "text": "manual response"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 3, "output_tokens": 2},
            },
            "anthropic_messages",
            "https://relay.example/v1/messages",
        )

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Hidden Manual Probe Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={"prompt": "manual probe", "request_params": {"max_tokens": 32, "temperature": 0}},
        )
        payload = response.json()
        manual_case_id = payload["result"]["test_case_id"]

        suites = client.get("/api/suites").json()
        test_suites = client.get("/api/test-suites").json()
        test_cases = client.get("/api/test-cases").json()
        explicit_cases = client.get("/api/suites/manual_model_request_probe/cases").json()
        run_detail = client.get(f"/api/runs/{payload['run']['id']}/results").json()

    assert response.status_code == 200
    assert "manual_model_request_probe" not in {suite["id"] for suite in suites}
    assert "manual_model_request_probe" not in {suite["id"] for suite in test_suites}
    assert manual_case_id not in {case["id"] for case in test_cases}
    assert manual_case_id in {case["id"] for case in explicit_cases}
    assert run_detail["run"]["id"] == payload["run"]["id"]
    assert run_detail["results"][0]["id"] == payload["result"]["id"]


def test_model_request_test_persists_expected_error_probe_result(monkeypatch) -> None:
    reset_database()

    async def fake_live_call(channel, case, raw_request, credentials):  # noqa: ANN001
        raise RuntimeError("400 Bad Request; response body: `temperature` may only be set to 1 when thinking is enabled")

    monkeypatch.setattr("app.services._live_call_with_metadata", fake_live_call)

    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Expected Error Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "auth_config": {"api_key": "test-key"},
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={
                "prompt": "probe",
                "request_params": {
                    "max_tokens": 2048,
                    "temperature": 0.2,
                    "thinking": {"type": "enabled", "budget_tokens": 1024},
                    "expected_error_contains": "temperature may only be set to 1 when thinking is enabled",
                },
            },
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["run"]["status"] == "completed"
    assert payload["result"]["score"] == 100
    assert payload["result"]["labels"] == []
    assert "temperature" in payload["result"]["normalized_response"]["error"]


def test_model_request_test_persists_missing_key_failure() -> None:
    reset_database()
    with TestClient(app) as client:
        channel_id = client.post(
            "/api/channels",
            json={
                "name": "Missing Key Channel",
                "provider_type": "third_party_anthropic",
                "base_url": "https://relay.example/v1",
                "model_name": "claude-sonnet-4-5",
                "enabled": True,
            },
        ).json()["id"]
        response = client.post(
            f"/api/channels/{channel_id}/model-request-test",
            json={"prompt": "hello", "request_params": {"max_tokens": 16, "temperature": 0}},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["run"]["status"] == "failed"
    assert payload["result"]["labels"] == ["request_failed"]
    assert payload["result"]["normalized_response"]["request_attempted"] is False
    assert "缺少 API Key" in payload["result"]["normalized_response"]["error"]


def test_auto_protocol_falls_back_to_openai_compatible(monkeypatch) -> None:
    reset_database()
    calls: list[str] = []

    async def failing_anthropic(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("anthropic")
        raise RuntimeError("anthropic unavailable")

    async def successful_openai(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("openai")
        return {
            "id": "chatcmpl_test",
            "object": "chat.completion",
            "model": channel.model_name,
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    monkeypatch.setattr("app.services._anthropic_compatible_call", failing_anthropic)
    monkeypatch.setattr("app.services._openai_compatible_call", successful_openai)

    with SessionLocal() as db:
        channel = Channel(
            id="apipro_auto",
            name="APIPro Auto",
            provider_type="AWS官",
            role="reference",
            base_url="https://api.wenwen-ai.com/",
            model_name="claude-test",
            enabled=True,
        )
        db.add(channel)
        db.commit()
        case = db.get(TestCaseModel, "identity_01")
        assert case is not None
        normalized = asyncio.run(invoke_channel(channel, case, 1, {"api_key": "test-key"}, use_mock=False))

    assert calls == ["anthropic", "openai"]
    assert normalized["content_text"] == "ok"
    assert normalized["request_protocol"] == "openai_chat_completions"
    assert normalized["provider_endpoint"] == "https://api.wenwen-ai.com/v1/chat/completions"


def test_anthropic_request_passes_thinking_params(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"type": "message", "content": [], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None
        asyncio.run(_anthropic_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["json"]["temperature"] == 0.2
    assert captured["json"]["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert "expected_error_contains" not in captured["json"]


def test_anthropic_request_passes_adaptive_enabled_thinking_probe(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"type": "message", "content": [], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "anthropic_official")
        case = manual_thinking_adaptive_enabled_probe_case()
        assert channel is not None
        case.request_params = {
            **(case.request_params or {}),
            "expected_error_missing_label": "thinking_adaptive_enabled_not_rejected",
        }
        asyncio.run(_anthropic_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["json"]["max_tokens"] == 2000
    assert captured["json"]["thinking"] == {
        "type": "enabled",
        "adaptive": {"enabled": True},
        "budget_tokens": 8000,
        "max_tokens": 2000,
    }
    assert "expected_error_missing_label" not in captured["json"]


def test_openai_request_passes_reasoning_effort_and_thinking(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"object": "chat.completion", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None
        asyncio.run(_openai_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["url"] == "https://relay.example/v1/chat/completions"
    assert captured["json"]["temperature"] == 0.2
    assert captured["json"]["reasoning_effort"] == "medium"
    assert captured["json"]["thinking"] == {"type": "enabled", "budget_tokens": 1024}


def test_openai_request_passes_tools_and_stream(monkeypatch) -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeResponse:
        text = "{}"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"object": "chat.completion", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"input_tokens": 1, "output_tokens": 1}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None

        async def __aenter__(self):  # noqa: ANN201
            return self

        async def __aexit__(self, *args) -> None:  # noqa: ANN002
            return None

        async def post(self, url, headers=None, json=None):  # noqa: ANN001
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr("app.services.httpx.AsyncClient", FakeClient)

    with SessionLocal() as db:
        channel = db.get(Channel, "openai_compat_demo")
        case = db.get(TestCaseModel, "websearch_01")
        assert channel is not None and case is not None
        asyncio.run(_openai_compatible_call(channel, build_raw_request(channel, case), {"api_key": "test-key"}))

    assert captured["json"]["tools"][0]["type"] == "web_search_20260209"
    assert captured["json"]["stream"] is True


def test_aws_thinking_probe_uses_raw_messages_body() -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody()}

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_temperature_probe_case()
        assert channel is not None
        payload = _aws_bedrock_messages_call(FakeAwsClient(), channel, case, {}, case.request_params)

    body = json.loads(captured["body"])
    assert captured["modelId"] == "anthropic.claude-sonnet-4-5-v1:0"
    assert body["anthropic_version"] == "bedrock-2023-05-31"
    assert body["temperature"] == 0.2
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert body["messages"][0]["content"] == "请用一句话回答：这是 thinking temperature 纯度探针。"
    assert payload["id"] == "msg_bdrk_01ok"


def test_aws_adaptive_enabled_probe_uses_raw_messages_body() -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody()}

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = manual_thinking_adaptive_enabled_probe_case()
        assert channel is not None
        params = {
            **(case.request_params or {}),
            "expected_error_missing_label": "thinking_adaptive_enabled_not_rejected",
        }
        payload = _aws_bedrock_messages_call(FakeAwsClient(), channel, case, {}, params)

    body = json.loads(captured["body"])
    assert captured["modelId"] == "anthropic.claude-sonnet-4-5-v1:0"
    assert body["anthropic_version"] == "bedrock-2023-05-31"
    assert body["max_tokens"] == 2000
    assert body["thinking"] == {
        "type": "enabled",
        "adaptive": {"enabled": True},
        "budget_tokens": 8000,
        "max_tokens": 2000,
    }
    assert "expected_error_missing_label" not in body
    assert payload["id"] == "msg_bdrk_01ok"


def test_aws_web_search_probe_uses_raw_messages_body() -> None:
    reset_database()
    captured: dict[str, object] = {}

    class FakeBody:
        def read(self) -> bytes:
            return b'{"id":"msg_bdrk_01ok","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}'

    class FakeAwsClient:
        def invoke_model(self, **kwargs):  # noqa: ANN001, ANN201
            captured.update(kwargs)
            return {"body": FakeBody()}

    with SessionLocal() as db:
        channel = db.get(Channel, "aws_bedrock")
        case = db.get(TestCaseModel, "websearch_01")
        assert channel is not None and case is not None
        payload = _aws_bedrock_messages_call(FakeAwsClient(), channel, case, {}, case.request_params or {})

    body = json.loads(captured["body"])
    assert body["max_tokens"] == 900
    assert body["stream"] is True
    assert body["tools"][0]["name"] == "web_search"
    assert payload["id"] == "msg_bdrk_01ok"


def test_execute_run_stops_channel_after_preflight_failure(monkeypatch) -> None:
    reset_database()
    calls: list[str] = []

    async def failing_anthropic(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("anthropic")
        raise RuntimeError("anthropic unavailable")

    async def failing_openai(channel, raw_request, credentials):  # noqa: ANN001
        calls.append("openai")
        raise RuntimeError("openai unavailable")

    monkeypatch.setattr("app.services._anthropic_compatible_call", failing_anthropic)
    monkeypatch.setattr("app.services._openai_compatible_call", failing_openai)

    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        channel = Channel(
            id="apipro_failing",
            name="APIPro Failing",
            provider_type="AWS官",
            role="reference",
            base_url="https://api.wenwen-ai.com/",
            model_name="claude-test",
            auth_config_encrypted={"api_key": "test-key"},
            is_reference=True,
            enabled=True,
        )
        db.add(channel)
        db.commit()
        run = create_run(
            db,
            RunCreate(
                name="preflight failure",
                suite_id=suite_id,
                channel_ids={"reference": [channel.id]},
                repeat_count=1,
                concurrency=4,
                use_mock=False,
                mode="baseline_build",
            ),
        )
        run_id = run.id

    asyncio.run(execute_run(SessionLocal, run_id, use_mock=False))

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
        labels = db.scalar(select(Result.labels).where(Result.run_id == run_id).limit(1))

    assert calls == ["anthropic", "openai"]
    assert run is not None
    assert run.status == "completed"
    assert result_count == run.total_jobs
    assert labels == ["channel_preflight_failed", "request_failed"]


def test_anthropic_messages_url_accepts_base_version_or_full_endpoint() -> None:
    assert _anthropic_messages_url(None) == "https://api.anthropic.com/v1/messages"
    assert _anthropic_messages_url("https://api.anthropic.com") == "https://api.anthropic.com/v1/messages"
    assert _anthropic_messages_url("https://api.anthropic.com/v1") == "https://api.anthropic.com/v1/messages"
    assert _anthropic_messages_url("https://relay.example/v1/messages") == "https://relay.example/v1/messages"
    assert _anthropic_messages_url("https://relay.example/messages") == "https://relay.example/messages"


def test_custom_reference_channel_can_build_baseline() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        created = client.post(
            "/api/channels",
            json={
                "name": "Custom Reference",
                "provider_type": "custom_provider",
                "role": "review_control",
                "model_name": "custom-model",
                "is_reference": True,
                "enabled": True,
            },
        )
        run = client.post(
            "/api/baselines/build",
            json={"name": "custom reference baseline", "suite_id": suite_id, "channel_ids": {"reference": [created.json()["id"]]}, "use_mock": True},
        )
        payload = client.get(f"/api/runs/{run.json()['id']}/results").json()

    assert created.status_code == 200
    assert created.json()["is_reference"] is True
    assert run.status_code == 200
    assert {item["role_in_run"] for item in payload["run_channels"]} == {"reference"}
    assert payload["baseline_snapshot"]["channel_ids"] == [created.json()["id"]]


def test_smart_patrol_report_counts_scheduled_run_and_alert(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        baseline_run = client.post(
            "/api/baselines/build",
            json={"name": "report baseline", "suite_id": suite_id, "channel_ids": {"gold": ["anthropic_official"]}, "use_mock": True},
        ).json()
        snapshot = next(item for item in client.get("/api/baselines", params={"suite_id": suite_id}).json() if item["source_run_id"] == baseline_run["id"])
        schedule = client.post(
            "/api/scheduled-tests",
            json={
                "name": "report patrol",
                "channel_id": "negative_sample",
                "suite_id": suite_id,
                "baseline_snapshot_id": snapshot["id"],
                "interval_minutes": 60,
                "use_mock": True,
            },
        ).json()
        client.post(f"/api/scheduled-tests/{schedule['id']}/run-now")
        report = client.get("/api/scheduled-tests/report").json()
        markdown = client.get("/api/scheduled-tests/report.md")

    assert report["run_count"] >= 1
    assert report["alert_count"] >= 1
    assert report["pending_review_count"] >= 1
    assert report["channel_summaries"]
    assert markdown.status_code == 200
    assert "智能巡检汇总报告" in markdown.text


def test_running_run_must_be_canceled_before_delete() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        run = create_run(db, RunCreate(name="running run", suite_id=suite_id, use_mock=True))
        run.status = "running"
        db.commit()
        run_id = run.id

    with TestClient(app) as client:
        blocked = client.delete(f"/api/runs/{run_id}")
        canceled = client.post(f"/api/runs/{run_id}/cancel")

    assert blocked.status_code == 409
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"


def test_cancel_run_is_idempotent_and_does_not_reopen_terminal_runs() -> None:
    reset_database()
    with SessionLocal() as db:
        suite_id = db.scalar(select(TestSuiteModel.id))
        pending = create_run(db, RunCreate(name="pending run", suite_id=suite_id, use_mock=True))
        completed = create_run(db, RunCreate(name="completed run", suite_id=suite_id, use_mock=True))
        completed.status = "completed"
        db.commit()
        pending_id = pending.id
        completed_id = completed.id

    with TestClient(app) as client:
        first_cancel = client.post(f"/api/runs/{pending_id}/cancel")
        second_cancel = client.post(f"/api/runs/{pending_id}/cancel")
        completed_cancel = client.post(f"/api/runs/{completed_id}/cancel")

    assert first_cancel.status_code == 200
    assert first_cancel.json()["status"] == "canceled"
    assert second_cancel.status_code == 200
    assert second_cancel.json()["status"] == "canceled"
    assert completed_cancel.status_code == 200
    assert completed_cancel.json()["status"] == "completed"

    with SessionLocal() as db:
        pending = db.get(Run, pending_id)
        completed = db.get(Run, completed_id)

    assert pending is not None
    assert pending.status == "canceled"
    assert pending.finished_at is not None
    assert completed is not None
    assert completed.status == "completed"


def test_execute_run_stops_remaining_jobs_when_canceled(monkeypatch) -> None:
    reset_database()

    async def scenario() -> str:
        started = asyncio.Event()
        started_count = 0

        async def slow_invoke(channel, case, attempt, credentials, use_mock):  # noqa: ANN001
            nonlocal started_count
            started_count += 1
            started.set()
            await asyncio.sleep(30)
            return {"content_text": "late response", "raw_request": {}, "raw_response": {}, "latency_ms": 1, "first_token_ms": 1}

        monkeypatch.setattr("app.services.invoke_channel", slow_invoke)

        with SessionLocal() as db:
            suite_id = db.scalar(select(TestSuiteModel.id))
            run = create_run(
                db,
                RunCreate(
                    name="cancelable run",
                    suite_id=suite_id,
                    channel_ids={"gold": ["anthropic_official"], "candidate": ["third_party_demo"]},
                    repeat_count=2,
                    concurrency=2,
                    use_mock=True,
                ),
            )
            run_id = run.id

        task = asyncio.create_task(execute_run(SessionLocal, run_id, use_mock=True))
        await asyncio.wait_for(started.wait(), timeout=2)

        with SessionLocal() as db:
            run = db.get(Run, run_id)
            assert run is not None
            assert run.status == "running"
            run.status = "canceled"
            db.commit()

        await asyncio.wait_for(task, timeout=3)

        with SessionLocal() as db:
            run = db.get(Run, run_id)
            result_count = db.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id))
            report_count = db.scalar(select(func.count()).select_from(Report).where(Report.run_id == run_id))

        assert started_count <= 2
        assert run is not None
        assert run.status == "canceled"
        assert run.finished_at is not None
        assert run.completed_jobs < run.total_jobs
        assert result_count == 0
        assert report_count == 0
        return run_id

    asyncio.run(scenario())


def test_run_create_rejects_out_of_range_repeat_count_and_concurrency() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        low_repeat = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "repeat_count": 0, "use_mock": True})
        high_repeat = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "repeat_count": 6, "use_mock": True})
        low_concurrency = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "concurrency": 0, "use_mock": True})
        high_concurrency = client.post("/api/runs", json={"name": "bad", "suite_id": suite_id, "concurrency": 17, "use_mock": True})

    assert low_repeat.status_code == 422
    assert high_repeat.status_code == 422
    assert low_concurrency.status_code == 422
    assert high_concurrency.status_code == 422


def test_baseline_build_rejects_out_of_range_repeat_count_and_concurrency() -> None:
    reset_database()
    with TestClient(app) as client:
        suite_id = client.get("/api/suites").json()[0]["id"]
        low_repeat = client.post("/api/baselines/build", json={"name": "bad", "suite_id": suite_id, "repeat_count": 0, "use_mock": True})
        high_concurrency = client.post("/api/baselines/build", json={"name": "bad", "suite_id": suite_id, "concurrency": 17, "use_mock": True})

    assert low_repeat.status_code == 422
    assert high_concurrency.status_code == 422


def test_cors_origins_are_read_from_environment() -> None:
    os.environ["CORS_ORIGINS"] = "http://localhost:5173, https://example.com "
    assert cors_origins() == ["http://localhost:5173", "https://example.com"]
