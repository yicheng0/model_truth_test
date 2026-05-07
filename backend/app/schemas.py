from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ChannelBase(BaseModel):
    name: str
    provider_type: str
    role: str
    base_url: str | None = None
    model_name: str | None = None
    enabled: bool = True


class ChannelCreate(ChannelBase):
    id: str | None = None


class ChannelUpdate(BaseModel):
    name: str | None = None
    provider_type: str | None = None
    role: str | None = None
    base_url: str | None = None
    model_name: str | None = None
    enabled: bool | None = None


class ChannelRead(ChannelBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class TestSuiteBase(BaseModel):
    name: str
    description: str | None = None
    version: str | None = None
    visibility: str = "public"


class TestSuiteCreate(TestSuiteBase):
    id: str | None = None


class TestSuiteUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    version: str | None = None
    visibility: str | None = None


class TestSuiteRead(TestSuiteBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class TestCaseBase(BaseModel):
    suite_id: str
    module: str
    sort_order: int = 1000
    title: str
    prompt: str
    system_prompt: str | None = None
    request_params: dict[str, Any] | None = None
    scoring_rules: dict[str, Any] | None = None
    is_hidden: bool = False
    enabled: bool = True


class TestCaseCreate(TestCaseBase):
    id: str | None = None


class TestCaseUpdate(BaseModel):
    suite_id: str | None = None
    module: str | None = None
    sort_order: int | None = None
    title: str | None = None
    prompt: str | None = None
    system_prompt: str | None = None
    request_params: dict[str, Any] | None = None
    scoring_rules: dict[str, Any] | None = None
    is_hidden: bool | None = None
    enabled: bool | None = None


class TestCaseRead(TestCaseBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime | None = None


class RunCreate(BaseModel):
    name: str
    suite_id: str
    channel_ids: dict[str, list[str]] = Field(default_factory=dict)
    repeat_count: int = 1
    concurrency: int = 1
    use_mock: bool = True
    runtime_credentials: dict[str, dict[str, Any]] = Field(default_factory=dict)


class RunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    suite_id: str
    name: str
    status: str
    repeat_count: int
    concurrency: int
    total_jobs: int
    completed_jobs: int
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime | None = None


class RunChannelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    channel_id: str
    role_in_run: str


class ResultRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    test_case_id: str
    channel_id: str
    attempt_index: int
    normalized_response: dict[str, Any] | None = None
    raw_request: dict[str, Any] | None = None
    raw_response: dict[str, Any] | None = None
    metrics: dict[str, Any] | None = None
    score: float
    labels: list[str] | None = None
    created_at: datetime | None = None


class ComparisonRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    test_case_id: str
    candidate_channel_id: str
    gold_similarity: float
    official_cloud_similarity: float
    protocol_score: float
    capability_score: float
    final_score: float
    labels: list[str] | None = None


class ReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    channel_id: str
    final_score: float
    grade: str
    summary: str | None = None
    evidence: dict[str, Any] | None = None
    markdown: str | None = None
    created_at: datetime | None = None


class RunResultsRead(BaseModel):
    run: RunRead
    run_channels: list[RunChannelRead]
    results: list[ResultRead]
    comparisons: list[ComparisonRead]
    reports: list[ReportRead]


class ManualScoreUpdate(BaseModel):
    final_score: float
    labels: list[str] | None = None
