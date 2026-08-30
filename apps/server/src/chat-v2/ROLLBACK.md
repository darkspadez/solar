# Chat and Migration Rollback

The pi engine is the live production path. Chat-v2 is retained as a frozen
archive and import source; it is not an alternate live generation engine.

For a deployment rollback, stop the service and restore matching snapshots of
the SQLite database, attachment root, and `${SOLAR_PI_AGENT_DIR}`. Do not restore
SQLite without the corresponding pi sessions: the database contains ownership
and configuration, while pi JSONL contains canonical conversation content.

The legacy importer (`scripts/import-chat-v2-to-pi.ts`) is idempotent and may be
run again after restoring a chat-v2 archive, but it must use the same
`DATABASE_PATH` and `SOLAR_PI_AGENT_DIR` as the server.
