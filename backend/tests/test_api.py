from __future__ import annotations

import os
import asyncio

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_claude_eval.db")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")

from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select

from app.database import SessionLocal, init_db
from app.main import app, cors_origins
from app.models import BaselineResult, BaselineSnapshot, Channel, ChannelAlert, Comparison, FeishuBroadcastSetting, Report, Result, Run, RunChannel, ScheduledChannelTest, TestCase as TestCaseModel, TestSuite as TestSuiteModel
from app.schemas import RunCreate, TestCaseCreate
from app.services import apply_repeat_consistency_scores, create_alerts_for_run, create_case, create_run, execute_run, execute_scheduled_channel_test, score_result, seed_demo_data


def reset_database() -> None:
    init_db()
    with SessionLocal() as db:
        for model in [FeishuBroadcastSetting, ChannelAlert, ScheduledChannelTest, Report, Comparison, BaselineResult, BaselineSnapshot, Result, RunChannel, Run, TestCaseModel, TestSuiteModel, Channel]:
            db.execute(delete(model))
        db.commit()
        seed_demo_data(db)


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
