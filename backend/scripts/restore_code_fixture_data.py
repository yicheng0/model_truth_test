from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import func, select

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.database import SessionLocal, init_db  # noqa: E402
from app.models import Channel, TestCase, TestSuite  # noqa: E402
from app.restored_seed import restored_seed_data  # noqa: E402
from app.services import seed_demo_data  # noqa: E402


def counts(db) -> dict[str, int]:  # noqa: ANN001
    return {
        "channels": int(db.scalar(select(func.count()).select_from(Channel)) or 0),
        "test_suites": int(db.scalar(select(func.count()).select_from(TestSuite)) or 0),
        "test_cases": int(db.scalar(select(func.count()).select_from(TestCase)) or 0),
    }


def missing_fixture_counts(db) -> dict[str, int]:  # noqa: ANN001
    data = restored_seed_data()
    return {
        "channels": sum(1 for item in data["channels"] if item.get("id") and not db.get(Channel, item["id"])),
        "test_suites": sum(1 for item in data["test_suites"] if item.get("id") and not db.get(TestSuite, item["id"])),
        "test_cases": sum(1 for item in data["test_cases"] if item.get("id") and not db.get(TestCase, item["id"])),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Restore built-in channels and test suites from code fixtures.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    init_db()
    with SessionLocal() as db:
        before = counts(db)
        if args.dry_run:
            inserted = missing_fixture_counts(db)
            after = {
                "channels": before["channels"] + inserted["channels"],
                "test_suites": before["test_suites"] + inserted["test_suites"],
                "test_cases": before["test_cases"] + inserted["test_cases"],
            }
        else:
            inserted = missing_fixture_counts(db)
            seed_demo_data(db)
            after = counts(db)

    print("Code fixture restore:")
    print(f"  channels: {before['channels']} -> {after['channels']}")
    print(f"  test_suites: {before['test_suites']} -> {after['test_suites']}")
    print(f"  test_cases: {before['test_cases']} -> {after['test_cases']}")
    if args.dry_run:
        print("Dry run inserted rows:")
        for table, count in inserted.items():
            print(f"  {table}: {count}")
    else:
        print("Restore complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
