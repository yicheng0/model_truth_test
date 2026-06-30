from __future__ import annotations

import os

from fastapi import Header, HTTPException


def configured_admin_key() -> str:
    return os.getenv("ADMIN_API_KEY", "").strip()


def require_admin(x_admin_key: str | None = Header(None, alias="X-Admin-Key")) -> None:
    expected = configured_admin_key()
    if not expected:
        raise HTTPException(status_code=403, detail="Admin API key is not configured")
    if x_admin_key != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_admin_if_configured(x_admin_key: str | None = Header(None, alias="X-Admin-Key")) -> None:
    expected = configured_admin_key()
    if expected and x_admin_key != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_configured_admin(x_admin_key: str | None = Header(None, alias="X-Admin-Key")) -> None:
    require_admin(x_admin_key)
