# Chat V2 Rollback

V1 remains the live production path. Chat V2 is a runtime-ready module only:
it has no live routes or UI wiring, and no v1-to-v2 migration has run.

Before migration, rollback means retain and restart the preserved v1 deployment
against its unchanged SQLite database and attachment root. Do not point v1 at
the v2 tables or attachment root. Keep a consistent v1 database snapshot,
including SQLite WAL/SHM files when applicable, and the matching attachment
snapshot until migration acceptance is complete.
