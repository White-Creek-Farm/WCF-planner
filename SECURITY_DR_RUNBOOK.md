# WCF Planner — DR / Backup / Secret-Escrow Packet

Companion to `SECURITY_DR_AUDIT_2026-06-22.md` (full audit). This file is the
*actionable* packet: env reference, secret escrow, restore drills, and a Storage
mirror skeleton. It contains **no secret values**. Most steps need
Supabase/Netlify dashboard or service-role access and are therefore **gated** —
they are documented here, not executed by code.

Production project ref: `pzfujbjtayhkdlxiblwe`. Production URL: https://wcfplanner.com.

---

## 1. Environment & secret inventory

See [`.env.example`](.env.example) for the full variable list (names only).
Secrets (must live only in the escrowed secret manager + their platform):

| Secret name | Where it lives | Used by |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` (TEST) | GitHub Actions secrets; local `.env.test.local` | CI DB reset/seed, TEST scripts |
| `PROD_SERVICE_ROLE_JWT` | local `.env.prod.local` only ⚠️ single copy | one-off PROD scripts |
| `VITE_TEST_ADMIN_PASSWORD` | GitHub Actions secrets; `.env.test.local` | e2e login |
| `SERVICE_ROLE_KEY` (edge) | Supabase function secrets | tasks-cron, tasks-summary, rapid-processor |
| `TASKS_CRON_SECRET` | Supabase function secrets | cron/summary invocation gate |
| `RESEND_API_KEY` | Supabase function secrets | rapid-processor email sender |
| `PODIO_*` (CLIENT_SECRET, PASSWORD) | local only, legacy | historical Podio backfill (rarely run) |

⚠️ **Single-copy risk:** `.env.prod.local` (incl. `PROD_SERVICE_ROLE_JWT`) is
believed to exist only on Ronnie's workstation. This is the top secret-escrow gap.

---

## 2. Secret escrow checklist (gated — needs secret manager + dashboards)

- [ ] Stand up a shared secret manager (e.g. 1Password/Bitwarden vault) with **≥2 holders** (Ronnie + 1).
- [ ] Escrow every secret in §1 by **name + value** (never commit values).
- [ ] Record, per secret: platform of record, rotation owner, last-rotated date.
- [ ] Confirm GitHub Actions secrets point at the **TEST** project only (no PROD service-role key in Actions).
- [ ] Confirm Supabase Edge Function secrets are set via `supabase secrets set` and listed (names) in the vault.
- [ ] Verify a second copy of `.env.prod.local` exists in the vault so workstation loss can't strand recovery.
- [ ] Document the rotation runbook (see audit §4d) and link it from the vault.

## 3. DB restore drill checklist (gated — Supabase dashboard)

- [ ] Confirm daily automated backups are enabled for `pzfujbjtayhkdlxiblwe`; record retention window.
- [ ] Confirm whether **PITR** is enabled; record its retention (= true DB RPO).
- [ ] Restore the latest backup/PITR snapshot to a **fresh scratch project** (never overwrite PROD to test).
- [ ] Validate on the scratch project: row counts for `app_store`, `profiles`, `daily_*`, `pasture_*`, `task_*`; spot-check a SECDEF RPC behaviorally.
- [ ] Record measured **RTO** (restore wall-clock) and **RPO** (max data-loss window) in this file.
- [ ] Note: **Storage objects are NOT in DB backups** — run the Storage drill (§5) separately.
- [ ] Capture the drill date + result below.

| Drill | Date | RPO | RTO | Result |
|---|---|---|---|---|
| DB restore-to-scratch | _pending_ | _?_ | _?_ | _not yet run_ |
| Storage restore | _pending_ | _?_ | _?_ | _not yet run_ |

## 4. Full-rebuild order (load-bearing)

1. `git clone` from GitHub origin.
2. Apply migrations **in order**: `supabase-migrations/archive/001..026` **first** (load-bearing cattle/sheep/equipment DDL), then `027..137` via `psql --single-transaction`.
3. Create the 8 Storage buckets (covered by migrations) and **restore objects from the Storage mirror** (§5).
4. Restore DB data from backup/PITR (existing project) or seed (fresh build).
5. Deploy Edge Functions: `tasks-cron`, `tasks-summary` from `supabase/functions/`, **and `rapid-processor` from `supabase-functions/`** (separate dir — easy to miss); re-set their secrets.
6. Fill env from `.env.example` using escrowed values; link Netlify, set env vars, build from `main`.
7. Point the domain; verify `public/_redirects`; run static + e2e + a behavioral smoke (login, daily submit, photo upload, task flow).

---

## 5. Storage backup / mirror — job skeleton (gated — needs service-role)

DB backups exclude Storage, so the 8 private buckets (`daily-photos`,
`task-photos`, `task-request-photos`, `comment-photos`,
`equipment-maintenance-docs`, `fuel-bills`, `cattle-feed-pdfs`,
`batch-documents`) currently have **no backup**. Below is a documented skeleton
for a scheduled out-of-band mirror to an independent versioned store
(S3/Backblaze/GDrive). Do not run with PROD service-role until reviewed.

```
# SKELETON — not wired up. Needs SERVICE_ROLE_KEY (read) + a destination store.
# Run as a nightly job on a trusted host (NOT the browser, NOT committed with creds).
#
# for each bucket in [daily-photos, task-photos, task-request-photos,
#                     comment-photos, equipment-maintenance-docs, fuel-bills,
#                     cattle-feed-pdfs, batch-documents]:
#   list objects via storage API (paginate)
#   for each object:
#     if not already mirrored (by path + etag/size):
#       download (signed URL or service-role) -> upload to versioned destination
#       preserve bucket/path layout; never delete on the destination (append-only)
#   write a manifest (bucket, path, etag, size, mirrored_at)
#
# Verify quarterly: pick N random objects, restore to a scratch bucket,
# confirm bytes + RLS signed-URL access. Record in the §3 drill table.
```

Recommended: implement as a Supabase Edge Function or an external cron on a
trusted host; keep the destination credentials in the secret manager, never in
the repo. RPO target: ≤24h. Track implementation as the audit's P1 backup lane.
