from __future__ import annotations

import argparse
import shutil
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_ORDER = [
    "channels",
    "test_suites",
    "test_cases",
    "runs",
    "baseline_snapshots",
    "run_channels",
    "results",
    "baseline_results",
    "comparisons",
    "reports",
    "scheduled_channel_tests",
    "channel_alerts",
    "channel_taxonomy_settings",
    "feishu_broadcast_settings",
    "alembic_version",
]

SUMMARY_TABLES = [
    "channels",
    "test_suites",
    "test_cases",
    "runs",
    "run_channels",
    "results",
    "baseline_snapshots",
    "baseline_results",
    "comparisons",
    "reports",
    "channel_alerts",
    "scheduled_channel_tests",
]


@dataclass
class TableSchema:
    columns: list[str]
    primary_key: str
    foreign_keys: list[tuple[str, str, str]]


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def quote_name(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {str(row["name"]) for row in rows}


def read_schema(conn: sqlite3.Connection, table: str) -> TableSchema:
    columns_info = conn.execute(f"PRAGMA table_info({quote_name(table)})").fetchall()
    columns = [str(row["name"]) for row in columns_info]
    primary_keys = [str(row["name"]) for row in columns_info if int(row["pk"] or 0) > 0]
    if len(primary_keys) != 1:
        raise ValueError(f"{table}: expected exactly one primary key column, got {primary_keys}")
    fks = conn.execute(f"PRAGMA foreign_key_list({quote_name(table)})").fetchall()
    foreign_keys = [(str(row["from"]), str(row["table"]), str(row["to"])) for row in fks]
    return TableSchema(columns=columns, primary_key=primary_keys[0], foreign_keys=foreign_keys)


def count_rows(conn: sqlite3.Connection, table: str) -> int:
    if table not in table_names(conn):
        return 0
    return int(conn.execute(f"SELECT COUNT(*) FROM {quote_name(table)}").fetchone()[0])


def exists_by_pk(conn: sqlite3.Connection, table: str, pk: str, value: Any) -> bool:
    row = conn.execute(
        f"SELECT 1 FROM {quote_name(table)} WHERE {quote_name(pk)} = ? LIMIT 1",
        (value,),
    ).fetchone()
    return row is not None


def has_fk_dependencies(
    target: sqlite3.Connection,
    schemas: dict[str, TableSchema],
    table: str,
    row: sqlite3.Row,
) -> tuple[bool, str | None]:
    for column, ref_table, ref_column in schemas[table].foreign_keys:
        value = row[column]
        if value is None:
            continue
        ref_schema = schemas.get(ref_table)
        if ref_schema is None:
            return False, f"{column} references missing table {ref_table}"
        if not exists_by_pk(target, ref_table, ref_column, value):
            return False, f"{column} references missing {ref_table}.{ref_column}={value}"
    return True, None


def row_values_for_target(row: sqlite3.Row, target_columns: list[str]) -> list[Any]:
    source_keys = set(row.keys())
    return [row[column] if column in source_keys else None for column in target_columns]


def insert_row(target: sqlite3.Connection, table: str, columns: list[str], values: list[Any]) -> int:
    placeholders = ", ".join("?" for _ in columns)
    column_sql = ", ".join(quote_name(column) for column in columns)
    cursor = target.execute(
        f"INSERT OR IGNORE INTO {quote_name(table)} ({column_sql}) VALUES ({placeholders})",
        values,
    )
    return int(cursor.rowcount or 0)


def source_paths(default_dir: Path) -> list[Path]:
    candidates = sorted(default_dir.glob("claude_eval.before-*.db"), key=lambda item: item.name)
    return [
        path
        for path in candidates
        if ".before-data-restore." not in path.name
        and ".before-script-restore." not in path.name
        and path.name != "claude_eval.db"
    ]


def restore(target_path: Path, sources: list[Path], dry_run: bool) -> int:
    if not target_path.exists():
        raise FileNotFoundError(f"Target database not found: {target_path}")
    if not sources:
        raise FileNotFoundError("No source backup databases found")

    target = connect(target_path)
    try:
        target_tables = table_names(target)
        schemas = {
            table: read_schema(target, table)
            for table in DEFAULT_ORDER
            if table in target_tables
        }
        before_counts = {table: count_rows(target, table) for table in SUMMARY_TABLES}
        inserted_by_table: defaultdict[str, int] = defaultdict(int)
        skipped_by_table: defaultdict[str, list[str]] = defaultdict(list)
        scanned_by_source: dict[str, dict[str, int]] = {}

        if dry_run:
            target.execute("BEGIN")

        for source_path in sources:
            if source_path.resolve() == target_path.resolve():
                continue
            source = connect(source_path)
            try:
                source_tables = table_names(source)
                scanned_by_source[source_path.name] = {}
                for table in DEFAULT_ORDER:
                    if table not in schemas or table not in source_tables:
                        continue
                    target_schema = schemas[table]
                    source_columns = {
                        str(row["name"])
                        for row in source.execute(f"PRAGMA table_info({quote_name(table)})").fetchall()
                    }
                    if target_schema.primary_key not in source_columns:
                        skipped_by_table[table].append(
                            f"{source_path.name}: missing primary key column {target_schema.primary_key}"
                        )
                        continue
                    selectable_columns = [column for column in target_schema.columns if column in source_columns]
                    rows = source.execute(
                        f"SELECT {', '.join(quote_name(column) for column in selectable_columns)} "
                        f"FROM {quote_name(table)}"
                    ).fetchall()
                    scanned_by_source[source_path.name][table] = len(rows)
                    for row in rows:
                        pk_value = row[target_schema.primary_key]
                        if exists_by_pk(target, table, target_schema.primary_key, pk_value):
                            continue
                        ok, reason = has_fk_dependencies(target, schemas, table, row)
                        if not ok:
                            skipped_by_table[table].append(f"{source_path.name}:{pk_value}: {reason}")
                            continue
                        inserted_by_table[table] += insert_row(
                            target,
                            table,
                            target_schema.columns,
                            row_values_for_target(row, target_schema.columns),
                        )
            finally:
                source.close()

        if dry_run:
            target.rollback()
        else:
            target.commit()

        after_counts = {table: count_rows(target, table) for table in SUMMARY_TABLES}
        print("Restore sources:")
        for source_name, tables in scanned_by_source.items():
            scanned = ", ".join(f"{table}={count}" for table, count in tables.items() if count)
            print(f"  {source_name}: {scanned or 'no rows scanned'}")
        print("\nInserted rows:")
        for table in SUMMARY_TABLES:
            print(f"  {table}: {inserted_by_table[table]}")
        print("\nCounts:")
        for table in SUMMARY_TABLES:
            print(f"  {table}: {before_counts[table]} -> {after_counts[table]}")
        print("\nSkipped dependencies:")
        for table in SUMMARY_TABLES:
            skipped = skipped_by_table[table]
            print(f"  {table}: {len(skipped)}")
            for item in skipped[:20]:
                print(f"    {item}")
            if len(skipped) > 20:
                print(f"    ... {len(skipped) - 20} more")
        return sum(inserted_by_table.values())
    finally:
        target.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Restore missing rows from claude_eval SQLite backups.")
    parser.add_argument("--target", default="backend/claude_eval.db", type=Path)
    parser.add_argument("--source", action="append", type=Path, dest="sources")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-backup", action="store_true")
    args = parser.parse_args()

    target_path = args.target.resolve()
    sources = [source.resolve() for source in args.sources] if args.sources else source_paths(target_path.parent)

    if not args.dry_run and not args.no_backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = target_path.with_name(f"{target_path.stem}.before-script-restore.{stamp}{target_path.suffix}")
        shutil.copy2(target_path, backup_path)
        print(f"Created backup: {backup_path}")

    inserted = restore(target_path, sources, args.dry_run)
    if args.dry_run:
        print(f"\nDry run complete. Would insert {inserted} rows.")
    else:
        print(f"\nRestore complete. Inserted {inserted} rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
