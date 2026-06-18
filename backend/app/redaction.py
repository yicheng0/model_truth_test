from __future__ import annotations

import copy
import re
from typing import Any


REDACTED = "[REDACTED]"

SENSITIVE_KEY_FRAGMENTS = {
    "api_key",
    "apikey",
    "authorization",
    "auth_token",
    "access_token",
    "refresh_token",
    "session_token",
    "secret",
    "password",
    "credential",
    "credential_ref",
    "private_key",
    "secret_ref",
    "webhook_secret",
    "aws_access_key_id",
    "aws_secret_access_key",
    "x-api-key",
}

SECRET_TEXT_PATTERNS = [
    re.compile(r"(?i)(bearer\s+)([A-Za-z0-9._~+\-/=]{6,})"),
    re.compile(r"(?i)((?:x-api-key|api[_-]?key|authorization|webhook[_-]?secret|secret|token|password)\s*[:=]\s*)([\"']?)([^\"'\s,;}{]+)"),
    re.compile(r"\b()(sk[-_][A-Za-z0-9._-]{6,})\b"),
]


def is_sensitive_key(key: Any) -> bool:
    normalized = str(key).strip().lower().replace("-", "_")
    compact = normalized.replace("_", "")
    return any(fragment in {normalized, compact} or fragment in normalized for fragment in SENSITIVE_KEY_FRAGMENTS)


def redact_secret(value: Any) -> str:
    text = "" if value is None else str(value)
    if not text:
        return REDACTED
    if len(text) <= 6:
        return f"{REDACTED} len={len(text)}"
    return f"{text[:3]}...{text[-3:]} {REDACTED} len={len(text)}"


def redact_text(value: str) -> str:
    redacted = value
    for pattern in SECRET_TEXT_PATTERNS:
        def replace(match: re.Match[str]) -> str:
            if len(match.groups()) == 1:
                return redact_secret(match.group(1))
            if len(match.groups()) == 2:
                return f"{match.group(1)}{redact_secret(match.group(2))}"
            return f"{match.group(1)}{match.group(2)}{redact_secret(match.group(3))}"

        redacted = pattern.sub(replace, redacted)
    return redacted


def redact_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        output: dict[Any, Any] = {}
        for key, item in value.items():
            output[key] = redact_secret(item) if is_sensitive_key(key) else redact_secrets(item)
        return output
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, tuple):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return copy.deepcopy(value)


def redact_channel_auth_config(config: dict[str, Any] | None) -> dict[str, Any]:
    if not config:
        return {}
    return redact_secrets(config)


def is_redacted_secret_placeholder(value: Any) -> bool:
    return isinstance(value, str) and REDACTED in value


def merge_redacted_config(existing: dict[str, Any] | None, incoming: dict[str, Any] | None) -> dict[str, Any]:
    output: dict[str, Any] = {}
    existing = existing or {}
    for key, value in (incoming or {}).items():
        if is_sensitive_key(key) and is_redacted_secret_placeholder(value) and key in existing:
            output[key] = existing[key]
        else:
            output[key] = value
    return output
