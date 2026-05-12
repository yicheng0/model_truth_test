from __future__ import annotations

import os
import asyncio

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
from app.services import _anthropic_messages_url, _live_call, _merged_channel_credentials, apply_repeat_consistency_scores, build_raw_request, classify_claude_message_id, create_alerts_for_run, create_case, create_channel, create_run, execute_run, execute_scheduled_channel_test, score_result, seed_demo_data


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


def test_scheduled_channel_test_run_now_creates_run_and_alert_when_risky(monkeypatch) -> None:
    monkeypatch.delenv("FEISHU_WEBHOOK_URL", raising=False)
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


def test_cors_origins_are_read_from_environment() -> None:
    os.environ["CORS_ORIGINS"] = "http://localhost:5173, https://example.com "
    assert cors_origins() == ["http://localhost:5173", "https://example.com"]
