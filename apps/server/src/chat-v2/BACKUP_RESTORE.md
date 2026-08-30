# Chat Data Backup And Restore

Pi session JSONL under `${SOLAR_PI_AGENT_DIR}` is the canonical conversation
history. Back up the SQLite database, the configured attachment root, and the
complete pi agent directory as one logical snapshot. The pi directory also
contains model and authentication state needed to restore a deployment without
reconfiguration.

Stop writes first, or use SQLite's backup facility so the database, `-wal`, and
`-shm` state are consistent. Copy the attachment root without rewriting
`storageKey` paths, and retain its SHA-256 metadata from `v2_attachment`.

To restore, stop the service, restore all three data roots together, and preserve
ownership/auth records required by `v2_conversation.userId`. Verify pi session
files and attachment files against the restored database before starting
traffic. Export bundles intentionally carry attachment metadata only; restore
the matching attachment and pi session snapshots separately.

Do not restore a partial database without its matching attachment and pi data
roots, and do not overwrite a live database while writers are running. Keep the
prior snapshot until the restored instance has passed integrity and
representative history checks.
