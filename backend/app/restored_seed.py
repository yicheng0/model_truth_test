from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


@lru_cache(maxsize=1)
def restored_seed_data() -> dict[str, list[dict[str, Any]]]:
    path = Path(__file__).with_name("restored_seed_data.json")
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    return {
        "channels": list(data.get("channels") or []),
        "test_suites": list(data.get("test_suites") or []),
        "test_cases": list(data.get("test_cases") or []),
    }

