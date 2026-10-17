# Deploying the Postgres fork (free tier)

What this fork changes: with `STORAGE=postgres`, the api keeps accounts, per-profile documents,
the session secret, VAPID keys and the audit log in Postgres instead of the `./data` folder.
Everything else — media uploads, the passkey/password sign-in flows, the sync engine — is upstream
behaviour, file-based bits included (see limits pg-store.js opens with).

Target: **Neon (free) + Render (free)** ≈ **$0/mo** for two users.

## 1. Neon

1. neon.tech → sign in → **New project** → name `opengym` (Postgres 16 is fine).
2. The dashboard shows a connection string. Pick the **pooled** one — it ends in
   `-pooler...neon.tech` and survives bursts:

   ```
   postgresql://USER:PASSWORD@ep-xxx-pooler.aws-region.aws.neon.tech/opengym?sslmode=require
   ```

   Copy it; it is the `DATABASE_URL`. No migrations to run — the driver creates its three
   tables (`opengym_documents`, `opengym_states`, `opengym_audit`) on first boot.

## 2. GitHub

Push this fork to your GitHub account. Blueprint deploys only read from git.

## 3. Render

1. Dashboard → **New + → Blueprint** → connect this repo.
2. Render reads `render.yaml`, shows two services and asks for the `sync: false` values:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon pooled string from step 1 |
   | `ORIGIN` | `https://synester-black-opengym.onrender.com` |
   | `RP_ID` | `synester-black-opengym.onrender.com` |

   Those hostnames follow the two service names in `render.yaml`. If Render assigns a different
   hostname because the name is already taken, use the actual web hostname here and update the
   `/api/*` rewrite destination in `render.yaml` to the actual api URL; commit/push that edit and
   sync the Blueprint.
3. After the first deploy, note **both** URLs Render created:
   - the **api** service: `https://<api-name>-xxxx.onrender.com`
   - the **web** static site: `https://<web-name>-xxxx.onrender.com`
4. Confirm the `/api/*` rewrite destination is `https://<api URL>/api/*` (the default in
   `render.yaml` matches the api service name above). The front site is the origin, because that
   is what the browser loads and what the CSRF guard compares against.
5. Wait for both deploys. Sign out a test: open the web URL → **Create profile** → name +
   password (PASSWORD_LOGIN is on in this Blueprint; passkeys work too once both phones have
   visited over HTTPS).

## 4. iPhone / Android

- **iPhone (PWA):** Safari → the web URL → sign in → Share → **Add to Home Screen**.
  Face ID passkeys bind to that hostname (RP_ID); Share Sheets, offline mode and the rest
  behave like the self-hosted app.
- **Android:** either the same PWA way, or the upstream signed APK paired with this server
  (docs/MOBILE.md covers pairing).

## 5. Keep-alive (makes free tier always-on)

Free api instances sleep ~15 minutes after the last request; while asleep they send no
reminder/nudge pushes (rest-timer alerts only matter while a workout is open anyway — the
device saturates the connection, keeping the api awake the whole session).

- Easiest: cron-job.org or UptimeRobot, a 5-min monitor on `https://<api URL>/api/health`.
  The endpoint reads process memory only and never wakes Postgres.
- Or the repository's `.github/workflows/fork-keepalive.yml`: add the secret `API_PING_URL`
  (= the api's health URL) and it pings every 10 minutes. GitHub disables scheduled workflows
  after 60 days without commits; a push to the fork resets the timer.

## 6. What breaks, deliberately

- **Two api instances behind one database are forbidden.** The per-profile compare-and-write
  that keeps two phones from clobbering each other guards one process's memory (upstream: one
  process's file). Render default is one instance; do not enable autoscaling on this service.
- **Custom exercise photos/videos** live in `data/uploads` on the api instance's ephemeral disk.
  A restart empties it; the devices re-upload what they still hold (the app asks the server
  what it is missing). No persistent disk is bought — that is the free tier's one compromise;
  a paid disk, or an S3/R2 driver later, ends it.
- **The MCP server and the Coach** read their own files under DATA_DIR and do not know about
  Postgres. The default image has neither anyway; do not enable the Coach in this mode.
- **Upstream updates:** this fork touches `api/server.js` in small marked blocks and adds
  `api/pg-store.js`. Merge conflicts come to those blocks; re-run `api/scripts/pg-smoke.mjs`
  plus the stock `api npm test` after merging.

## 7. Local development

```sh
# test database
docker run -d --name opengym-pg -e POSTGRES_PASSWORD=gym -e POSTGRES_DB=opengym -p 54329:5432 postgres:16-alpine

cd api && npm install
node scripts/pg-smoke.mjs                 # full walk-through; refuses remote DBs by default

# fs mode (upstream behaviour), untouched by this fork
DATA_DIR=/tmp/og-fs PORT=3000 node api/server.js
```

Reset the test instance:

```sh
docker exec opengym-pg psql -U postgres -d opengym \
  -c 'DROP TABLE IF EXISTS opengym_documents, opengym_states, opengym_audit CASCADE'
```

The smoke script drops and recreates its three tables. It refuses to run against a remote
database unless you explicitly set `PG_SMOKE_ALLOW_RESET=1`; prefer a disposable local database.

## 8. Backups

Everything now lives in the database. Export whole profiles from the app (Settings → export)
or, at any time, from psql:

```sql
SELECT data FROM opengym_documents;      -- accounts, secret, VAPID keys
SELECT uid, data FROM opengym_states;    -- every profile's workouts and plans
SELECT rec  FROM opengym_audit;          -- activity log
```

Neon snapshots point-in-time on its own schedule; a pg_dump at the command line is the manual
copy. Media uploads are the one thing outside the database — they are re-fetchable from the
phone that made them.
