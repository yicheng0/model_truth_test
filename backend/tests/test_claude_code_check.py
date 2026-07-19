from __future__ import annotations

import asyncio
import json
import sys

from app import claude_code_check
from app.claude_code_check import ProcessResult
from app.schemas import ClaudeCodeCheckCreate


def test_claude_code_status_reports_version(monkeypatch) -> None:
    monkeypatch.setattr(claude_code_check, "_resolve_command", lambda _command: "C:/fake/claude.cmd")
    monkeypatch.setattr(
        claude_code_check,
        "_run_process_sync",
        lambda args, timeout_seconds: ProcessResult(
            0,
            json.dumps({"loggedIn": True, "authMethod": "oauth_token", "apiProvider": "firstParty"}) if "auth" in args else "2.1.150 (Claude Code)\n",
            "",
        ),
    )

    payload = claude_code_check.claude_code_status()

    assert payload["installed"] is True
    assert payload["available"] is True
    assert payload["version"] == "2.1.150 (Claude Code)"
    assert payload["auth_evidence"]["classification"] == "claude_code_oauth_confirmed"


def test_claude_code_status_handles_missing_command(monkeypatch) -> None:
    monkeypatch.setattr(claude_code_check, "_resolve_command", lambda _command: None)

    payload = claude_code_check.claude_code_status()

    assert payload["installed"] is False
    assert payload["available"] is False
    assert "not found" in payload["error"]


def test_claude_code_status_survives_auth_status_failure(monkeypatch) -> None:
    monkeypatch.setattr(claude_code_check, "_resolve_command", lambda _command: "C:/fake/claude.cmd")

    def fake_process(args, timeout_seconds):  # noqa: ANN001
        if "auth" in args:
            raise TimeoutError("auth status timed out")
        return ProcessResult(0, "2.1.150 (Claude Code)\n", "")

    monkeypatch.setattr(claude_code_check, "_run_process_sync", fake_process)
    payload = claude_code_check.claude_code_status()

    assert payload["available"] is True
    assert payload["auth_evidence"]["classification"] == "auth_status_unavailable"


def test_claude_code_check_success(monkeypatch) -> None:
    monkeypatch.setattr(claude_code_check, "_resolve_command", lambda _command: "C:/fake/claude.cmd")

    async def fake_run_process(args, *, cwd=None, timeout_seconds):  # noqa: ANN001
        if "--version" in args:
            return ProcessResult(0, "2.1.150 (Claude Code)\n", "")
        if "auth" in args and "status" in args:
            return ProcessResult(0, json.dumps({"loggedIn": True, "authMethod": "oauth_token", "apiProvider": "firstParty", "accessToken": "secret-token"}), "")
        if args[:3] == [sys.executable, "-m", "unittest"]:
            implementation = cwd / "src" / "math_utils.py"
            return ProcessResult(0 if "return a + b" in implementation.read_text(encoding="utf-8") else 1, "", "")
        implementation = cwd / "src" / "math_utils.py"
        implementation.write_text(
            "def add(a: int, b: int) -> int:\n"
            "    \"\"\"Return the sum of two integers.\"\"\"\n"
            "    return a + b\n",
            encoding="utf-8",
        )
        return ProcessResult(0, json.dumps({"result": json.dumps({"fixed": True, "tests_ran": True, "summary": "ok"})}), "")

    monkeypatch.setattr(claude_code_check, "_run_process", fake_run_process)

    payload = asyncio.run(claude_code_check.run_claude_code_check(ClaudeCodeCheckCreate()))

    assert payload["ok"] is True
    assert payload["score"] == 100
    assert {item["key"] for item in payload["checks"]} >= {"cli_available", "file_edit", "tests_passed", "sandbox_boundary"}
    assert payload["auth_evidence"] == {
        "classification": "claude_code_oauth_confirmed",
        "confidence": "high",
        "evidence_source": "local_cli_auth_status",
        "logged_in": True,
        "auth_method": "oauth_token",
        "api_provider": "firstParty",
        "limitations": ["本地 CLI 登录状态不能证明任意远程 Base URL 使用同一认证。"],
    }
    assert payload["execution_auth_context"]["bare_mode"] is True
    assert payload["execution_auth_context"]["oauth_used_by_probe"] is False
    assert "secret-token" not in json.dumps(payload, default=str)


def test_claude_code_auth_evidence_handles_api_key_and_invalid_status(monkeypatch) -> None:
    monkeypatch.setattr(claude_code_check, "_resolve_command", lambda _command: "C:/fake/claude.cmd")

    api_key = claude_code_check._parse_auth_status(ProcessResult(0, json.dumps({"loggedIn": True, "authMethod": "api_key", "apiProvider": "firstParty", "apiKey": "secret"}), ""))
    invalid = claude_code_check._parse_auth_status(ProcessResult(1, "not-json", "failed"))

    assert api_key["classification"] == "claude_api_key_cli_auth"
    assert "secret" not in json.dumps(api_key)
    assert invalid["classification"] == "auth_status_unavailable"
    assert invalid["confidence"] == "low"


def test_claude_code_check_fails_without_file_edit(monkeypatch) -> None:
    monkeypatch.setattr(claude_code_check, "_resolve_command", lambda _command: "C:/fake/claude.cmd")

    async def fake_run_process(args, *, cwd=None, timeout_seconds):  # noqa: ANN001
        if "--version" in args:
            return ProcessResult(0, "2.1.150 (Claude Code)\n", "")
        if args[:3] == [sys.executable, "-m", "unittest"]:
            return ProcessResult(1, "", "failed")
        return ProcessResult(0, json.dumps({"result": json.dumps({"fixed": False, "tests_ran": False, "summary": "no edit"})}), "")

    monkeypatch.setattr(claude_code_check, "_run_process", fake_run_process)

    payload = asyncio.run(claude_code_check.run_claude_code_check(ClaudeCodeCheckCreate()))

    assert payload["ok"] is False
    assert payload["score"] < 85
    failed_keys = {item["key"] for item in payload["checks"] if item["status"] == "fail"}
    assert {"file_edit", "tests_passed"} <= failed_keys


def test_powershell_invocation_uses_argument_list() -> None:
    args = claude_code_check._claude_invocation(["--version"], "C:/Users/example/AppData/Roaming/npm/claude.ps1")

    assert args[:4] == ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass"]
    assert "-File" in args
    assert args[-1] == "--version"


def test_cmd_invocation_uses_direct_argument_list() -> None:
    args = claude_code_check._claude_invocation(["--version"], "C:/Users/example/AppData/Roaming/npm/claude.CMD")

    assert args == ["C:/Users/example/AppData/Roaming/npm/claude.CMD", "--version"]
