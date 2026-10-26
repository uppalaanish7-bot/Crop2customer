"""Copy the local SQLite marketplace and uploaded images into a new Neon database.

This script is intentionally non-destructive: it backs up SQLite and uploads,
refuses a non-empty destination, never deletes source files, and verifies every
copied row and image before reporting success.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TABLES = ("users", "otp_Challenges", "products", "orders", "purchases")
BACKUP_ROOT = ROOT / "data" / "migration-backups"


def copy_source_backup(source_db: Path, uploads_dir: Path) -> tuple[Path, Path | None]:
    if not source_db.is_file():
        raise RuntimeError("The source SQLite database was not found.")
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_db = BACKUP_ROOT / f"marketplace-{stamp}.db"
    backup_uploads = BACKUP_ROOT / f"uploads-{stamp}" if uploads_dir.is_dir() else None

    with sqlite3.connect(source_db) as source, sqlite3.connect(backup_db) as backup:
        if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("The source SQLite database did not pass its integrity check.")
        if source.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise RuntimeError("The source SQLite database contains foreign-key violations.")
        source.backup(backup)
    if backup_uploads is not None:
        shutil.copytree(uploads_dir, backup_uploads)
    return backup_db, backup_uploads


def migrate(source_db: Path, uploads_dir: Path) -> tuple[dict[str, int], Path, Path | None]:
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("Set DATABASE_URL to the new Neon PostgreSQL connection string.")

    backup_db, backup_uploads = copy_source_backup(source_db, uploads_dir)

    import psycopg
    from psycopg.rows import dict_row

    sqlite_db = sqlite3.connect(source_db)
    sqlite_db.row_factory = sqlite3.Row
    try:
        source_tables = {
            row[0]
            for row in sqlite_db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        missing = set(TABLES) - source_tables
        if missing:
            raise RuntimeError("The source database is missing expected marketplace tables.")
        counts = {
            table: sqlite_db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            for table in TABLES
        }

        schema = (ROOT / "postgres_schema.sql").read_text(encoding="utf-8")
        with psycopg.connect(database_url, row_factory=dict_row, connect_timeout=10) as postgres:
            with postgres.cursor() as cursor:
                existing_tables = cursor.execute(
                    "SELECT tablename FROM pg_catalog.pg_tables "
                    "WHERE schemaname = current_schema()"
                ).fetchall()
                if existing_tables:
                    raise RuntimeError("The destination database already contains tables; no migration was started.")

                for statement in schema.split(";"):
                    if statement.strip():
                        cursor.execute(statement)

                target_counts = {
                    table.lower(): cursor.execute(f'SELECT COUNT(*) AS count FROM "{table.lower()}"').fetchone()["count"]
                    for table in TABLES
                }
                if any(target_counts.values()):
                    raise RuntimeError("The destination database is not empty; no database rows were copied.")

                source_columns_by_table = {}
                for table in TABLES:
                    source_columns = [
                        row["name"] for row in sqlite_db.execute(f'PRAGMA table_info("{table}")').fetchall()
                    ]
                    target_columns = {
                        row["column_name"]
                        for row in cursor.execute(
                            "SELECT column_name FROM information_schema.columns "
                            "WHERE table_schema = current_schema() AND table_name = %s",
                            (table.lower(),),
                        ).fetchall()
                    }
                    if set(source_columns) != target_columns:
                        raise RuntimeError("The source and destination table schemas do not match.")
                    source_columns_by_table[table] = source_columns

                media_files = []
                if uploads_dir.is_dir():
                    media_files = sorted(
                        item for item in uploads_dir.iterdir()
                        if item.is_file() and not item.name.startswith("crop_")
                    )
                for image_file in media_files:
                    image_bytes = image_file.read_bytes()
                    suffix = image_file.suffix.lower()
                    content_type = {
                        ".jpg": "image/jpeg",
                        ".jpeg": "image/jpeg",
                        ".png": "image/png",
                        ".webp": "image/webp",
                    }.get(suffix, "application/octet-stream")
                    cursor.execute(
                        "INSERT INTO media_objects (filename, content_type, data, created_at) "
                        "VALUES (%s, %s, %s, %s)",
                        (image_file.name, content_type, image_bytes, datetime.now(timezone.utc).isoformat()),
                    )

                for table in TABLES:
                    source_columns = source_columns_by_table[table]
                    quoted_columns = ", ".join(f'"{name}"' for name in source_columns)
                    placeholders = ", ".join("%s" for _ in source_columns)
                    insert_sql = (
                        f'INSERT INTO "{table.lower()}" ({quoted_columns}) '
                        f"VALUES ({placeholders})"
                    )
                    source_rows = sqlite_db.execute(f'SELECT * FROM "{table}"').fetchall()
                    for row in source_rows:
                        cursor.execute(insert_sql, tuple(row[name] for name in source_columns))

                for table in ("users", "otp_challenges", "products", "orders", "purchases"):
                    cursor.execute(
                        "SELECT setval(pg_get_serial_sequence(%s, 'id'), "
                        f"COALESCE(MAX(id), 1), COUNT(*) > 0) FROM \"{table}\"",
                        (table,),
                    )

                for table, expected in counts.items():
                    actual = cursor.execute(
                        f'SELECT COUNT(*) AS count FROM "{table.lower()}"'
                    ).fetchone()["count"]
                    if actual != expected:
                        raise RuntimeError("A destination row count did not match the source.")
                    source_rows = sqlite_db.execute(
                        f'SELECT * FROM "{table}" ORDER BY id'
                    ).fetchall()
                    target_rows = cursor.execute(
                        f'SELECT * FROM "{table.lower()}" ORDER BY id'
                    ).fetchall()
                    for source_row, target_row in zip(source_rows, target_rows):
                        if any(source_row[column] != target_row[column] for column in source_columns_by_table[table]):
                            raise RuntimeError("A destination row did not match the source.")
                image_count = cursor.execute(
                    "SELECT COUNT(*) AS count FROM media_objects"
                ).fetchone()["count"]
                if image_count != len(media_files):
                    raise RuntimeError("The destination image count did not match the source uploads.")
                for image_file in media_files:
                    target_image = cursor.execute(
                        "SELECT data FROM media_objects WHERE filename = %s",
                        (image_file.name,),
                    ).fetchone()
                    if target_image is None or hashlib.sha256(bytes(target_image["data"])).digest() != hashlib.sha256(image_file.read_bytes()).digest():
                        raise RuntimeError("A destination image did not match the source file.")
        counts["media_objects"] = len(media_files)
        return counts, backup_db, backup_uploads
    finally:
        sqlite_db.close()


def main() -> int:
    source_db = Path(os.environ.get("SOURCE_SQLITE_PATH", ROOT / "data" / "marketplace.db"))
    uploads_dir = Path(os.environ.get("SOURCE_UPLOADS_DIR", ROOT / "uploads"))
    try:
        counts, backup_db, backup_uploads = migrate(source_db, uploads_dir)
    except Exception as error:
        print(f"Migration stopped safely ({type(error).__name__}). The source database and uploads were retained.", file=sys.stderr)
        return 1

    print("Migration completed and row counts matched:")
    for table, count in counts.items():
        print(f"  {table}: {count}")
    print(f"SQLite backup: {backup_db}")
    if backup_uploads:
        print(f"Uploads backup: {backup_uploads}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
