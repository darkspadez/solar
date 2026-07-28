# Chat V2 Rollback Runbook

Companion to [`chat-v2-cutover-runbook.md`](./chat-v2-cutover-runbook.md). Read
this once, before starting the cutover runbook, so you know what "abort" looks
like before you need it.

There are three distinct rollback situations, ordered by how far the cutover
got. Identify which one you're in before acting.

---

## Situation A — Something failed during §3–§6 of the cutover runbook
(migration, merge, or verification, container still stopped, flag never
enabled)

Nothing user-facing has changed yet. The live `solar.db` may have had schema
migrations applied (§4) and possibly merged v2 data (§5), but v1 tables are
untouched and the flag was never turned on.

**Action:** restore the pristine backup and restart the old path.

```bash
docker stop Solar 2>/dev/null || true

# Replace the (possibly partially-migrated) live db with the pre-cutover backup:
cp -p "$BACKUP_DIR/solar.db" /mnt/user/appdata/solar/solar.db
rm -f /mnt/user/appdata/solar/solar.db-wal /mnt/user/appdata/solar/solar.db-shm

# Attachments were never modified by this process, but restore them too if
# you have any doubt:
rm -rf /mnt/user/appdata/solar/attachments
cp -rp "$BACKUP_DIR/attachments" /mnt/user/appdata/solar/attachments

# Start the previous image/config with SOLAR_CHAT_V2 unset:
cd /boot/config/plugins/compose.manager/projects/solar && docker compose --project-name solar up --detach --force-recreate solar
```

Verify:

```bash
sha256sum /mnt/user/appdata/solar/solar.db "$BACKUP_DIR/solar.db"  # should match
curl -fsS http://<unraid-host>:3444/healthz  # verify from a machine that can reach the host
```

You are back to exactly the pre-cutover state. Investigate the failure
offline (using your own copies from `$WORK`, not the live data) before
re-attempting.

---

## Situation B — Cutover completed (§7), flag is on, but something is visibly
wrong (missing conversations, broken rendering, errors on send/edit)

**Immediate action: flip the flag off.** This alone reverts all read/write
behavior to the v1 path without touching any data.

```bash
# Remove/unset SOLAR_CHAT_V2 in the compose env, then:
cd /boot/config/plugins/compose.manager/projects/solar && docker compose --project-name solar up --detach --force-recreate solar
```

Because v1 tables (`conversation`, `message`, `generation_step`, etc.) were
never modified or deleted by the migration or merge steps, this is expected to
immediately restore full v1 functionality, including any conversations created
or edited *after* cutover but *before* you noticed the problem — as long as
those writes went through the v1 path (i.e., they will have, since the flag
being on is exactly the condition that routes writes to v2; if the flag was on
when those writes happened, see the caveat below).

**Caveat:** any conversation *created* while `SOLAR_CHAT_V2=1` was on (whether
new or continuations of a migrated conversation) exists only in `v2_*` tables.
Turning the flag off makes those specific conversations disappear from the UI
again (they are not deleted, just not read by the v1 path). If real user
activity happened during the flag-on window and you need it preserved when
reverting to v1 permanently, do not delete the `v2_*` tables — export it first
(see Situation C) and reconcile manually, or plan to re-enable the flag once
the underlying problem is fixed rather than reverting long-term.

For a short flag-on window with no real user writes yet, simply flipping the
flag off is sufficient and low-risk.

---

## Situation C — Full rollback needed after real usage on v2 (flag was on for
a meaningful period, users sent messages, and you need to go back to v1
*without losing that activity*)

This is the expensive case. There is currently no automated v2→v1 downgrade
migration (the project's migration tooling is one-directional, v1→v2, by
design — see `chat-history-2.md` §18). Treat this as an incident, not a
routine step:

1. Flip `SOLAR_CHAT_V2` off immediately (Situation B) to stop new v2 writes
   and restore v1 functionality for everything migrated/pre-existing.
2. Export the v2-only activity for safekeeping before doing anything else:
   ```bash
   sqlite3 /mnt/user/appdata/solar/solar.db \
     "select * from v2_conversation where updatedAt > '<cutover-timestamp>';"
   ```
   Or use the chat-v2 export path (`ChatV2ExportService` /
   `apps/server/src/chat-v2/export.ts`) per conversation ID if you need full
   fidelity (messages, attachments, generations).
3. Do not delete any `v2_*` tables or rows as part of recovering service —
   they are inert to v1 and cost nothing to retain.
4. Decide, outside of this runbook, whether the v2-only activity should be
   manually re-entered into v1, held until v2 is re-enabled, or accepted as
   lost. This is a product decision, not a mechanical one.

---

## Rollback verification checklist (all situations)

After any rollback action:

- [ ] `/healthz` returns healthy.
- [ ] `PRAGMA integrity_check` on `solar.db` returns `ok`.
- [ ] A known pre-existing conversation loads with correct, complete history.
- [ ] Sending a new message in a v1 conversation works end-to-end.
- [ ] `docker logs Solar` shows no migration/startup errors.

## What never needs to be undone

- The chat-v2 schema migrations (`020_chat_v2`, `021_chat_v2_organization`,
  `022_chat_v2_voice`) are additive — new tables only, no changes to existing
  v1 tables or columns. Leaving them in place after a rollback is harmless;
  v1 code never reads them.
- Attachment files on disk are never moved, renamed, or deleted by the
  migration or merge tooling. A rollback never needs to touch
  `/mnt/user/appdata/solar/attachments` unless you have independent reason to
  believe it was modified by something else.
