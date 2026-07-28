# Chat V2 Backup And Restore

Back up the SQLite database and the configured v2 attachment root as one logical
snapshot. Stop writes first, or use SQLite's backup facility so the database,
`-wal`, and `-shm` state are consistent. Copy the attachment root without
rewriting `storageKey` paths, and retain its SHA-256 metadata from
`v2_attachment`.

To restore, stop the service, restore the database and attachment root together,
and preserve ownership/auth records required by `v2_conversation.userId`. Before
starting traffic, run `checkChatV2Integrity` and verify attachment files against
their recorded byte sizes and SHA-256 values. Export bundles intentionally carry
attachment metadata only; restore the matching file snapshot separately.

Do not restore a partial database without its matching asset root, and do not
overwrite a live database while writers are running. Keep the prior snapshot
until the restored instance has passed integrity and representative history
checks.
