# Chat V2 Cutover Runbook

Status: **Ready for execution**, pending final go decision.

Companion to [`chat-history-2.md`](./chat-history-2.md) and
[`chat-v2-plan.md`](./chat-v2-plan.md). This is the concrete, execution-level
procedure for cutting a running production Solar instance over from the v1
history path to v2, including a one-time migration of existing conversations.

It assumes the production layout confirmed on this host via `docker inspect
Solar`:

```text
Host path:        /mnt/user/appdata/solar
  solar.db                 (+ -wal / -shm while running)
  attachments/

Container:        Solar  (docker inspect Solar)
Compose project:  solar
Compose service:  solar
Compose working dir (Unraid Compose Manager plugin):
  /boot/config/plugins/compose.manager/projects/solar
Compose file:     /boot/config/plugins/compose.manager/projects/solar/compose.yaml

Container mounts (compose.yaml):
  DATABASE_PATH        = /data/solar.db
  SOLAR_ATTACHMENTS_DIR = /data/attachments
  volumes: /mnt/user/appdata/solar:/data
```

**Rehearsed against the real container** (stop/start only, no data touched):

- `docker stop Solar` completes cleanly (exit 0) and the app logs
  `"solar server shutting down", signal: "SIGTERM"` before exiting — it has a
  proper SIGTERM handler.
- **Stopping the container checkpoints and removes `-wal`/`-shm`
  automatically.** The `bun:sqlite` connection closes cleanly on shutdown, so
  `solar.db` is already a single, self-contained, consistent file by the time
  `docker stop` returns — the backup step (§2) does not need a manual
  `PRAGMA wal_checkpoint`.
- `docker start Solar` brings back the **same container ID and image**
  (confirmed via `docker inspect --format '{{.Id}}'` before/after) and logs
  `"solar server listening"` with no errors.
- This sandbox has Docker socket access but no network path to the
  container's published port (`3444`) or its internal bridge IP, so `/healthz`
  could not be curled from here. The clean `"solar server listening"` log line
  is a strong signal, but **you must independently confirm `/healthz` returns
  `{"ok":true}` from a machine that can actually reach the host** before
  considering any step in this runbook complete.

Read [`chat-v2-rollback-runbook.md`](./chat-v2-rollback-runbook.md) before
starting. Do not begin this runbook without having already read it once.

---

## 0. Preconditions

- [ ] The chat-v2 runtime (M0–M9) is deployed in the image being rolled out,
      with `SOLAR_CHAT_V2` unset/false by default.
- [ ] `scripts/migrate-history-v1-to-v2.ts` and
      `scripts/migrate-v1-v2/merge-into-live.ts` are present in the image/repo
      used to run this runbook.
- [ ] You have shell access to the Docker host (`/mnt/user/appdata/solar`) and
      to a machine that can run `bun` against that host path (either directly
      on the host, or by copying files to a workstation — see §2).
- [ ] No one else is actively deploying or migrating this instance
      concurrently.

This runbook performs the data migration **offline**, against a stopped
container, directly on the production data path. It does not migrate data
while the server is live.

---

## 1. Announce and stop writes

```bash
docker ps --filter "name=Solar"
```

Stop the running container so nothing writes to `solar.db` during backup and
migration:

```bash
docker stop Solar
```

Confirm it is stopped, and confirm the same container/image will come back
(not a stale one):

```bash
docker ps -a --filter "name=Solar" --format '{{.Names}}: {{.Status}}'
docker inspect Solar --format 'id={{.Id}} image={{.Config.Image}}'
```

As confirmed by rehearsal, the container logs
`"solar server shutting down", signal: "SIGTERM"` and closes its SQLite
connection cleanly — `-wal`/`-shm` are checkpointed and removed automatically.
`solar.db` is a consistent, self-contained file as soon as `docker stop`
returns.

---

## 2. Back up the current database and attachments

Do this even though the migration tooling never mutates its source — this is
your rollback artifact, not a migration input.

```bash
BACKUP_DIR=/mnt/user/appdata/solar-backup-$(date +%Y%m%dT%H%M%S)
mkdir -p "$BACKUP_DIR"

cp -p /mnt/user/appdata/solar/solar.db "$BACKUP_DIR/solar.db"
# With the container stopped, -wal/-shm should already be gone (see §0 note).
# Copy them anyway in case the container was killed rather than stopped cleanly:
cp -p /mnt/user/appdata/solar/solar.db-wal "$BACKUP_DIR/solar.db-wal" 2>/dev/null || true
cp -p /mnt/user/appdata/solar/solar.db-shm "$BACKUP_DIR/solar.db-shm" 2>/dev/null || true
cp -rp /mnt/user/appdata/solar/attachments "$BACKUP_DIR/attachments"

sha256sum /mnt/user/appdata/solar/solar.db "$BACKUP_DIR/solar.db"
echo "Backup at: $BACKUP_DIR"
```

- [ ] Record `$BACKUP_DIR` somewhere durable (not just shell history).
- [ ] Verify the two `sha256sum` lines for `solar.db` match (container is
      stopped, so the live file should be byte-identical to the backup).

Do not delete this backup until §7's acceptance checks pass and the instance
has been observed healthy for a reasonable period after cutover.

---

## 3. Run the offline data migration

Run this against the **stopped container's** data directory. It is read-only
against `solar.db`/`attachments` and writes to new, separate output paths —
nothing in this step touches the live files yet.

```bash
cd /path/to/solar/repo   # the checkout containing scripts/migrate-history-v1-to-v2.ts

WORK=/mnt/user/appdata/solar-migration-work
rm -rf "$WORK"
mkdir -p "$WORK"

bun run scripts/migrate-history-v1-to-v2.ts \
  --source-db /mnt/user/appdata/solar/solar.db \
  --source-assets /mnt/user/appdata/solar/attachments \
  --target-db "$WORK/v2-migrated.db" \
  --target-assets "$WORK/v2-migrated-attachments" \
  --report "$WORK/migration-report.json"
```

### 3.1 Check the report before proceeding

```bash
python3 -c "
import json
d = json.load(open('$WORK/migration-report.json'))
print('counts:', d['counts'])
print('warnings:', len(d['warnings']))
print('recoveries:', len(d['recoveries']))
print('failures:', len(d['failures']))
for f in d['failures']: print(' FAILURE:', f)
"
```

- [ ] `failures` is an empty list. If it is not, **stop here** — the tool
      already refused to write `$WORK/v2-migrated.db` in that case. Resolve
      whatever it reports (most classes are now auto-omitted with a warning
      instead of aborting; a non-empty `failures` list at this point means
      something genuinely unresolved, e.g. a storage key escaping the asset
      root) before re-running.
- [ ] Skim `warnings` — expect `compaction_omitted` (rolling summaries are
      intentionally not carried forward) and possibly
      `attachment_omitted_missing_file` / `attachment_omitted_size_mismatch`
      / `orphan_attachment_omitted` for individually broken/unreferenced
      attachment rows. These do not block migration; they mean that specific
      attachment won't have a v2 binding.
- [ ] Skim `recoveries` — expect `legacy_assistant_text` for any voice/plain
      text-only assistant rows without full pi-ai metadata.
- [ ] Confirm `counts.conversations` matches your expectation (e.g. compare
      against `select count(*) from conversation` on the source).

---

## 4. Deploy the new image (schema migration only, no cutover yet)

Build/deploy the new image as you normally would. On boot it will run
`migrateToLatest()`, which applies the new chat-v2 schema migrations
(`020_chat_v2`, `021_chat_v2_organization`, `022_chat_v2_voice`) to
`/mnt/user/appdata/solar/solar.db` alongside all existing tables. Do this
**with `SOLAR_CHAT_V2` still unset**, so v1 remains the active path while the
schema is prepared.

```bash
cd /boot/config/plugins/compose.manager/projects/solar
docker compose --project-name solar up --detach --force-recreate solar
```

(If the host has no `docker compose` plugin available, Unraid's Docker Compose
Manager UI can trigger the equivalent recreate for this project.)

Wait for health from a machine that can actually reach the host (this could
not be verified from the sandbox used to rehearse §1/§7 — no route to the
container's port or bridge IP from there):

```bash
until curl -fsS http://<unraid-host>:3444/healthz | grep -q '"ok":true'; do sleep 1; done
```

Confirm the schema landed and the container is otherwise behaving normally
(v1 conversations still load, since the flag is off):

```bash
sqlite3 /mnt/user/appdata/solar/solar.db \
  "select name from sqlite_master where type='table' and name like 'v2_%';"
```

You should see the full `v2_*` table list with zero rows in each.

Then **stop the container again** before merging data — the merge tool
requires exclusive access to `solar.db`, same as the migration step:

```bash
docker stop Solar
```

---

## 5. Merge the migrated data into the live database

```bash
cd /path/to/solar/repo

bun run scripts/migrate-v1-v2/merge-into-live.ts \
  --migrated-db "$WORK/v2-migrated.db" \
  --live-db /mnt/user/appdata/solar/solar.db
```

Expected output: a JSON report with non-zero counts for `v2_conversation`,
`v2_conversation_turn`, `v2_conversation_message`, `v2_attachment`,
`v2_message_attachment`, and `v2_generation`; `"integrityCheck": "ok"`; empty
`"foreignKeyCheck"`.

- [ ] If it refuses with "already has rows" — **stop**. That means either this
      step already ran, or something unexpected wrote v2 data. Investigate
      before considering `--force`.
- [ ] If it refuses with "missing table" — §4's deploy did not actually apply
      the schema migrations to this file. Do not proceed; re-check §4.

Attachment **files** do not need to be copied or moved. `v2_attachment.storageKey`
is copied verbatim from the v1 row, and both v1 and v2 attachment code resolve
files through the same configured `SOLAR_ATTACHMENTS_DIR` root. The existing
files at `/mnt/user/appdata/solar/attachments` already satisfy the migrated
rows.

---

## 6. Verify before flipping the flag

With the container still stopped, sanity-check the merged database directly:

```bash
sqlite3 /mnt/user/appdata/solar/solar.db "PRAGMA integrity_check;"
sqlite3 /mnt/user/appdata/solar/solar.db "PRAGMA foreign_key_check;"
sqlite3 /mnt/user/appdata/solar/solar.db "select count(*) from v2_conversation;"
sqlite3 /mnt/user/appdata/solar/solar.db "select count(*) from conversation;"  -- v1 table, should be unchanged
```

Both `PRAGMA` checks should be clean, and the v1 `conversation` count should
be exactly what it was before this runbook started.

---

## 7. Start the container with the flag enabled

```bash
# Add to the compose project's env (or .env) at
# /boot/config/plugins/compose.manager/projects/solar:
#   SOLAR_CHAT_V2=1
cd /boot/config/plugins/compose.manager/projects/solar
docker compose --project-name solar up --detach --force-recreate solar
```

Wait for `/healthz`, then check as a real user (or via an admin session):

- [ ] The conversation list shows the expected number of conversations for
      each user.
- [ ] Opening an older, pre-migration conversation renders full history,
      including any tool calls/results and attachments, correctly.
- [ ] Sending a new message in an existing (migrated) conversation works and
      streams normally.
- [ ] Edit and regenerate work on a migrated conversation.
- [ ] Search returns results from migrated conversations.

If anything here fails, go to
[`chat-v2-rollback-runbook.md`](./chat-v2-rollback-runbook.md) immediately
rather than trying to hot-fix in place.

---

## 8. Post-cutover monitoring

- [ ] Watch container logs for the first real usage window
      (`docker logs -f Solar`), specifically for `chat-v2` structured log
      lines and any `error`-level entries.
- [ ] Keep `$BACKUP_DIR` from §2 and `$WORK` from §3 until you are confident
      the instance is stable (suggest: at least a few days of normal use).
- [ ] Do not delete the v1 tables (`conversation`, `message`,
      `generation_step`, etc.) as part of this cutover. They are inert once
      the flag is on, but keeping them costs nothing and preserves a fallback
      path (see rollback runbook).

## 9. Definition of done

- [ ] `SOLAR_CHAT_V2=1` is running in production.
- [ ] All migrated conversations are visible and usable.
- [ ] `$BACKUP_DIR` and `$WORK/migration-report.json` are archived somewhere
      outside the container's data volume.
- [ ] This runbook and the rollback runbook are both retained for the next
      person who needs them.
