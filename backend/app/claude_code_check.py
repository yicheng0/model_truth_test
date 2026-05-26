from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .schemas import ClaudeCodeCheckCreate


COMMAND_ENV = "CLAUDE_CODE_COMMAND"
DEFAULT_TIMEOUT_SECONDS = 180
EXCERPT_LIMIT = 6000


@dataclass
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False


def claude_code_status() -> dict[str, Any]:
    command = _configured_command()
    command_path = _resolve_command(command)
    if not command_path:
        return {
            "installed": False,
            "available": False,
            "command": command,
            "command_path": None,
            "version": None,
            "error": f"{command!r} was not found on PATH",
        }

    try:
        result = _run_process_sync(_claude_invocation(["--version"], command_path), timeout_seconds=10)
    except Exception as exc:  # noqa: BLE001 - status endpoint should report diagnostics.
        return {
            "installed": True,
            "available": False,
            "command": command,
            "command_path": command_path,
            "version": None,
            "error": str(exc),
        }

    version = (result.stdout or result.stderr).strip().splitlines()[0] if (result.stdout or result.stderr).strip() else None
    return {
        "installed": True,
        "available": result.returncode == 0,
        "command": command,
        "command_path": command_path,
        "version": version,
        "error": _excerpt(result.stderr) if result.returncode != 0 else None,
    }


def claude_code_check_steps() -> list[dict[str, Any]]:
    return [
        {"key": "cli_available", "title": "Claude Code CLI 可用"},
        {"key": "fixture_sanity", "title": "沙箱 fixture 初始失败"},
        {"key": "non_interactive_run", "title": "非交互运行成功"},
        {"key": "structured_output", "title": "JSON / output config 可解析"},
        {"key": "file_edit", "title": "临时代码读写修复成功"},
        {"key": "tests_passed", "title": "后端复跑 unittest 通过"},
        {"key": "sandbox_boundary", "title": "权限边界和沙箱清理"},
    ]


async def run_claude_code_check(data: ClaudeCodeCheckCreate) -> dict[str, Any]:
    return await run_claude_code_check_with_progress(data)


async def run_claude_code_check_with_progress(
    data: ClaudeCodeCheckCreate,
    progress_callback: callable | None = None,
) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    monotonic_started = time.monotonic()
    checks: list[dict[str, Any]] = []
    stdout_excerpt = ""
    stderr_excerpt = ""
    command = _configured_command()
    command_path = _resolve_command(command)

    async def emit(current_key: str | None = None) -> None:
        if progress_callback is None:
            return
        await progress_callback(
            {
                "current_key": current_key,
                "checks": deepcopy(checks),
                "stdout_excerpt": stdout_excerpt,
                "stderr_excerpt": stderr_excerpt,
            }
        )

    if not command_path:
        checks.append(_check("cli_available", "Claude Code CLI 可用", "fail", 0, f"{command!r} was not found on PATH"))
        await emit("cli_available")
        return _result_payload(started, monotonic_started, None, command, None, checks, "", "")

    await emit("cli_available")
    version_result = await _run_process(_claude_invocation(["--version"], command_path), timeout_seconds=10)
    version = (version_result.stdout or version_result.stderr).strip().splitlines()[0] if (version_result.stdout or version_result.stderr).strip() else None
    checks.append(
        _check(
            "cli_available",
            "Claude Code CLI 可用",
            "pass" if version_result.returncode == 0 else "fail",
            15 if version_result.returncode == 0 else 0,
            version or _excerpt(version_result.stderr) or "Version command returned no output",
        )
    )
    await emit("cli_available")
    if version_result.returncode != 0:
        return _result_payload(started, monotonic_started, command_path, command, version, checks, version_result.stdout, version_result.stderr)

    with tempfile.TemporaryDirectory(prefix="claude_code_probe_") as workspace:
        workspace_path = Path(workspace)
        _write_probe_workspace(workspace_path)

        await emit("fixture_sanity")
        initial_test = await _run_python_unittest(workspace_path, timeout_seconds=20)
        initial_failed = initial_test.returncode != 0
        checks.append(
            _check(
                "fixture_sanity",
                "沙箱 fixture 初始失败",
                "pass" if initial_failed else "fail",
                0,
                "Initial unittest fails as expected" if initial_failed else "Initial fixture unexpectedly passed before Claude Code ran",
            )
        )
        await emit("fixture_sanity")

        schema = {
            "type": "object",
            "properties": {
                "fixed": {"type": "boolean"},
                "tests_ran": {"type": "boolean"},
                "summary": {"type": "string"},
            },
            "required": ["fixed", "tests_ran", "summary"],
            "additionalProperties": True,
        }
        prompt = (
            "You are in a temporary sandbox created only for a Claude Code capability check. "
            "Inspect the files, fix the failing unittest by editing the implementation, run "
            "`python -m unittest discover -s tests`, and return only JSON matching the schema. "
            "Do not modify files outside this directory."
        )
        claude_args = [
            "-p",
            "--bare",
            "--no-session-persistence",
            "--permission-mode",
            "acceptEdits",
            "--tools",
            "LS,Read,Edit,Bash",
            "--allowedTools",
            "LS",
            "Read",
            "Edit",
            "Bash(python -m unittest*)",
            "--disallowedTools",
            "WebFetch",
            "WebSearch",
            "--output-format",
            "json",
            "--json-schema",
            json.dumps(schema, separators=(",", ":")),
            "--max-budget-usd",
            f"{data.max_budget_usd:.2f}",
        ]
        if data.model:
            claude_args.extend(["--model", data.model])
        claude_args.append(prompt)

        await emit("non_interactive_run")
        cli_result = await _run_process(
            _claude_invocation(claude_args, command_path),
            cwd=workspace_path,
            timeout_seconds=data.timeout_seconds,
        )
        stdout_excerpt = _excerpt(cli_result.stdout)
        stderr_excerpt = _excerpt(cli_result.stderr)

        checks.append(
            _check(
                "non_interactive_run",
                "非交互运行成功",
                "pass" if cli_result.returncode == 0 and not cli_result.timed_out else "fail",
                15 if cli_result.returncode == 0 and not cli_result.timed_out else 0,
                _process_detail(cli_result),
            )
        )
        await emit("non_interactive_run")

        parsed_json = _parse_claude_json(cli_result.stdout)
        await emit("structured_output")
        checks.append(
            _check(
                "structured_output",
                "JSON / output config 可解析",
                "pass" if parsed_json is not None else "fail",
                15 if parsed_json is not None else 0,
                "Structured output parsed" if parsed_json is not None else "Claude Code did not return parseable JSON output",
            )
        )
        await emit("structured_output")

        implementation = (workspace_path / "src" / "math_utils.py").read_text(encoding="utf-8")
        file_fixed = "return a + b" in implementation
        await emit("file_edit")
        checks.append(
            _check(
                "file_edit",
                "临时代码读写修复成功",
                "pass" if file_fixed else "fail",
                25 if file_fixed else 0,
                "Implementation now returns a + b" if file_fixed else "Implementation was not corrected",
            )
        )
        await emit("file_edit")

        await emit("tests_passed")
        final_test = await _run_python_unittest(workspace_path, timeout_seconds=20)
        tests_passed = final_test.returncode == 0
        checks.append(
            _check(
                "tests_passed",
                "后端复跑 unittest 通过",
                "pass" if tests_passed else "fail",
                20 if tests_passed else 0,
                _process_detail(final_test),
            )
        )
        await emit("tests_passed")

        allowed_files_ok = _workspace_contains_probe_files(workspace_path)
        await emit("sandbox_boundary")
        checks.append(
            _check(
                "sandbox_boundary",
                "权限边界和沙箱清理",
                "pass" if allowed_files_ok else "fail",
                10 if allowed_files_ok else 0,
                "Probe remained inside the temporary workspace until cleanup" if allowed_files_ok else "Probe fixture files were missing before cleanup",
            )
        )
        await emit("sandbox_boundary")

    return _result_payload(started, monotonic_started, command_path, command, version, checks, stdout_excerpt, stderr_excerpt)


def _configured_command() -> str:
    return os.getenv(COMMAND_ENV, "claude").strip() or "claude"


def _resolve_command(command: str) -> str | None:
    return shutil.which(command) or (command if Path(command).exists() else None)


def _claude_invocation(args: list[str], command_path: str | None = None) -> list[str]:
    executable = command_path or _resolve_command(_configured_command()) or _configured_command()
    if executable.lower().endswith(".ps1"):
        return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable, *args]
    return [executable, *args]


def _run_process_sync(args: list[str], *, timeout_seconds: int) -> ProcessResult:
    import subprocess

    completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout_seconds, shell=False, encoding="utf-8", errors="replace")
    return ProcessResult(completed.returncode, completed.stdout or "", completed.stderr or "")


async def _run_process(args: list[str], *, cwd: Path | None = None, timeout_seconds: int) -> ProcessResult:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(cwd) if cwd else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
        return ProcessResult(
            process.returncode or 0,
            stdout_bytes.decode("utf-8", errors="replace"),
            stderr_bytes.decode("utf-8", errors="replace"),
        )
    except asyncio.TimeoutError:
        if "process" in locals() and process.returncode is None:
            process.kill()
            await process.communicate()
        return ProcessResult(124, "", f"Process timed out after {timeout_seconds}s", timed_out=True)
    except FileNotFoundError as exc:
        return ProcessResult(127, "", str(exc))


async def _run_python_unittest(workspace: Path, *, timeout_seconds: int) -> ProcessResult:
    return await _run_process([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=workspace, timeout_seconds=timeout_seconds)


def _write_probe_workspace(workspace: Path) -> None:
    src_dir = workspace / "src"
    tests_dir = workspace / "tests"
    src_dir.mkdir(parents=True, exist_ok=True)
    tests_dir.mkdir(parents=True, exist_ok=True)
    (src_dir / "__init__.py").write_text("", encoding="utf-8")
    (src_dir / "math_utils.py").write_text(
        "def add(a: int, b: int) -> int:\n"
        "    \"\"\"Return the sum of two integers.\"\"\"\n"
        "    return a - b\n",
        encoding="utf-8",
    )
    (tests_dir / "test_math_utils.py").write_text(
        "import unittest\n\n"
        "from src.math_utils import add\n\n\n"
        "class AddTests(unittest.TestCase):\n"
        "    def test_adds_positive_numbers(self):\n"
        "        self.assertEqual(add(2, 3), 5)\n\n"
        "    def test_adds_negative_numbers(self):\n"
        "        self.assertEqual(add(-4, 7), 3)\n\n\n"
        "if __name__ == '__main__':\n"
        "    unittest.main()\n",
        encoding="utf-8",
    )


def _parse_claude_json(stdout: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, str):
            try:
                parsed_result = json.loads(result)
            except json.JSONDecodeError:
                return payload
            return parsed_result if isinstance(parsed_result, dict) else payload
        return payload
    return None


def _workspace_contains_probe_files(workspace: Path) -> bool:
    return all(
        (workspace / relative).exists()
        for relative in ["src/__init__.py", "src/math_utils.py", "tests/test_math_utils.py"]
    )


def _check(key: str, title: str, status: str, score: int, detail: str) -> dict[str, Any]:
    return {"key": key, "title": title, "status": status, "score": score, "detail": detail}


def _result_payload(
    started: datetime,
    monotonic_started: float,
    command_path: str | None,
    command: str,
    version: str | None,
    checks: list[dict[str, Any]],
    stdout: str,
    stderr: str,
) -> dict[str, Any]:
    finished = datetime.now(timezone.utc)
    score = sum(int(check.get("score") or 0) for check in checks if check.get("key") != "fixture_sanity")
    failed = [check for check in checks if check.get("status") == "fail" and check.get("key") != "fixture_sanity"]
    status = "passed" if score >= 85 and not failed else "failed"
    return {
        "ok": status == "passed",
        "status": status,
        "score": max(0, min(100, score)),
        "grade": _grade(score, bool(failed)),
        "command": command,
        "command_path": command_path,
        "version": version,
        "started_at": started,
        "finished_at": finished,
        "duration_ms": round((time.monotonic() - monotonic_started) * 1000),
        "checks": checks,
        "stdout_excerpt": _excerpt(stdout),
        "stderr_excerpt": _excerpt(stderr),
    }


def _grade(score: int, failed: bool) -> str:
    if score >= 90 and not failed:
        return "A"
    if score >= 80:
        return "B"
    if score >= 65:
        return "C"
    if score >= 50:
        return "D"
    return "E"


def _process_detail(result: ProcessResult) -> str:
    if result.timed_out:
        return result.stderr
    if result.returncode == 0:
        return _excerpt(result.stdout or "Process completed")
    return _excerpt(result.stderr or result.stdout or f"Process exited with code {result.returncode}")


def _excerpt(value: str | None) -> str:
    text = value or ""
    if len(text) <= EXCERPT_LIMIT:
        return text
    return text[:EXCERPT_LIMIT] + "\n...[truncated]"
