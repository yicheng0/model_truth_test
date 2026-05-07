from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_claude_eval.db")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")

from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select

from app.database import SessionLocal, init_db
from app.main import app, cors_origins
from app.models import Channel, Comparison, Report, Result, Run, RunChannel, TestCase as TestCaseModel, TestSuite as TestSuiteModel
from app.schemas import RunCreate
from app.services import create_run, execute_run, seed_demo_data


def reset_database() -> None:
    init_db()
    with SessionLocal() as db:
        for model in [Report, Comparison, Result, RunChannel, Run, TestCaseModel, TestSuiteModel, Channel]:
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


def test_cors_origins_are_read_from_environment() -> None:
    os.environ["CORS_ORIGINS"] = "http://localhost:5173, https://example.com "
    assert cors_origins() == ["http://localhost:5173", "https://example.com"]
