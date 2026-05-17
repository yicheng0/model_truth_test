from __future__ import annotations

import argparse
import shutil
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy import MetaData, Table, create_engine, inspect, select
from sqlalchemy.engine import Connection, Engine


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
class SourceTableSchema:
    columns: list[str]
    primary_key: str
    foreign_keys: list[tuple[str, str, str]]


@dataclass
class TargetTableSchema:
    table: Table
    columns: list[str]
    primary_key: str
    foreign_keys: list[tuple[str, str, str]]


def sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def connect_source(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def quote_name(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def source_table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {str(row["name"]) for row in rows}


def read_source_schema(conn: sqlite3.Connection, table: str) -> SourceTableSchema:
    columns_info = conn.execute(f"PRAGMA table_info({quote_name(table)})").fetchall()
    columns = [str(row["name"]) for row in columns_info]
    primary_keys = [str(row["name"]) for row in columns_info if int(row["pk"] or 0) > 0]
    if len(primary_keys) != 1:
        raise ValueError(f"{table}: expected exactly one primary key column, got {primary_keys}")
    fks = conn.execute(f"PRAGMA foreign_key_list({quote_name(table)})").fetchall()
    foreign_keys = [(str(row["from"]), str(row["table"]), str(row["to"])) for row in fks]
    return SourceTableSchema(columns=columns, primary_key=primary_keys[0], foreign_keys=foreign_keys)


def source_paths(default_dir: Path) -> list[Path]:
    candidates = sorted(default_dir.glob("claude_eval.before-*.db"), key=lambda item: item.name)
    return [
        path
        for path in candidates
        if ".before-data-restore." not in path.name
        and ".before-script-restore." not in path.name
        and path.name != "claude_eval.db"
    ]


def make_engine(target_url: str) -> Engine:
    connect_args = {"check_same_thread": False} if target_url.startswith("sqlite") else {}
    return create_engine(target_url, connect_args=connect_args, pool_pre_ping=True)


def read_target_schemas(engine: Engine) -> dict[str, TargetTableSchema]:
    metadata = MetaData()
    metadata.reflect(bind=engine, only=lambda name, _: name in DEFAULT_ORDER)
    schemas: dict[str, TargetTableSchema] = {}
    inspector = inspect(engine)
    for table_name in DEFAULT_ORDER:
        table = metadata.tables.get(table_name)
        if table is None:
            continue
        pk_columns = [column.name for column in table.primary_key.columns]
        if len(pk_columns) != 1:
            raise ValueError(f"{table_name}: expected exactly one primary key column, got {pk_columns}")
        foreign_keys = [
            (item["constrained_columns"][0], item["referred_table"], item["referred_columns"][0])
            for item in inspector.get_foreign_keys(table_name)
            if len(item.get("constrained_columns") or []) == 1 and len(item.get("referred_columns") or []) == 1
        ]
        schemas[table_name] = TargetTableSchema(
            table=table,
            columns=[column.name for column in table.columns],
            primary_key=pk_columns[0],
            foreign_keys=foreign_keys,
        )
    return schemas


def count_rows(conn: Connection, schemas: dict[str, TargetTableSchema], table_name: str) -> int:
    schema = schemas.get(table_name)
    if schema is None:
        return 0
    return int(conn.execute(select(sa.func.count()).select_from(schema.table)).scalar_one())


def exists_by_pk(conn: Connection, schema: TargetTableSchema, value: Any) -> bool:
    pk_column = schema.table.c[schema.primary_key]
    return conn.execute(select(sa.literal(1)).where(pk_column == value).limit(1)).first() is not None


def has_fk_dependencies(
    conn: Connection,
    schemas: dict[str, TargetTableSchema],
    table: str,
    row: sqlite3.Row,
) -> tuple[bool, str | None]:
    for column, ref_table, ref_column in schemas[table].foreign_keys:
        if column not in row.keys():
            continue
        value = row[column]
        if value is None:
            continue
        ref_schema = schemas.get(ref_table)
        if ref_schema is None:
            return False, f"{column} references missing table {ref_table}"
        ref_column_obj = ref_schema.table.c[ref_column]
        found = conn.execute(select(sa.literal(1)).where(ref_column_obj == value).limit(1)).first()
        if found is None:
            return False, f"{column} references missing {ref_table}.{ref_column}={value}"
    return True, None


def row_values_for_target(row: sqlite3.Row, target_columns: list[str]) -> dict[str, Any]:
    source_keys = set(row.keys())
    return {column: row[column] if column in source_keys else None for column in target_columns}


def insert_row(conn: Connection, schema: TargetTableSchema, values: dict[str, Any]) -> int:
    result = conn.execute(schema.table.insert().values(**values))
    return int(result.rowcount or 0)


def restore(target_url: str, sources: list[Path], dry_run: bool) -> int:
    if not sources:
        raise FileNotFoundError("No source backup databases found")

    engine = make_engine(target_url)
    schemas = read_target_schemas(engine)
    inserted_by_table: defaultdict[str, int] = defaultdict(int)
    skipped_by_table: defaultdict[str, list[str]] = defaultdict(list)
    scanned_by_source: dict[str, dict[str, int]] = {}

    with engine.connect() as conn:
        transaction = conn.begin()
        try:
            before_counts = {table: count_rows(conn, schemas, table) for table in SUMMARY_TABLES}
            for source_path in sources:
                source = connect_source(source_path)
                try:
                    source_tables = source_table_names(source)
                    scanned_by_source[source_path.name] = {}
                    for table_name in DEFAULT_ORDER:
                        target_schema = schemas.get(table_name)
                        if target_schema is None or table_name not in source_tables:
                            continue
                        source_schema = read_source_schema(source, table_name)
                        if target_schema.primary_key not in source_schema.columns:
                            skipped_by_table[table_name].append(
                                f"{source_path.name}: missing primary key column {target_schema.primary_key}"
                            )
                            continue
                        selectable_columns = [
                            column for column in target_schema.columns if column in source_schema.columns
                        ]
                        rows = source.execute(
                            f"SELECT {', '.join(quote_name(column) for column in selectable_columns)} "
                            f"FROM {quote_name(table_name)}"
                        ).fetchall()
                        scanned_by_source[source_path.name][table_name] = len(rows)
                        for row in rows:
                            pk_value = row[target_schema.primary_key]
                            if exists_by_pk(conn, target_schema, pk_value):
                                continue
                            ok, reason = has_fk_dependencies(conn, schemas, table_name, row)
                            if not ok:
                                skipped_by_table[table_name].append(
                                    f"{source_path.name}:{pk_value}: {reason}"
                                )
                                continue
                            inserted_by_table[table_name] += insert_row(
                                conn,
                                target_schema,
                                row_values_for_target(row, target_schema.columns),
                            )
                finally:
                    source.close()

            after_counts = {table: count_rows(conn, schemas, table) for table in SUMMARY_TABLES}
            if dry_run:
                transaction.rollback()
            else:
                transaction.commit()
        except Exception:
            transaction.rollback()
            raise

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


def main() -> int:
    parser = argparse.ArgumentParser(description="Restore missing rows from claude_eval SQLite backups.")
    parser.add_argument("--target", default="backend/claude_eval.db", type=Path)
    parser.add_argument("--target-url", default=None, help="SQLAlchemy URL for the target database.")
    parser.add_argument("--source", action="append", type=Path, dest="sources")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-backup", action="store_true")
    args = parser.parse_args()

    target_path = args.target.resolve()
    target_url = args.target_url or sqlite_url(target_path)
    sources = [source.resolve() for source in args.sources] if args.sources else source_paths(target_path.parent)

    if not args.target_url and not target_path.exists():
        raise FileNotFoundError(f"Target database not found: {target_path}")
    if not args.target_url and not args.dry_run and not args.no_backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = target_path.with_name(f"{target_path.stem}.before-script-restore.{stamp}{target_path.suffix}")
        shutil.copy2(target_path, backup_path)
        print(f"Created backup: {backup_path}")

    inserted = restore(target_url, sources, args.dry_run)
    if args.dry_run:
        print(f"\nDry run complete. Would insert {inserted} rows.")
    else:
        print(f"\nRestore complete. Inserted {inserted} rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
