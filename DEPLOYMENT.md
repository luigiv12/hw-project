# Deployment

Railway hosts the API and its managed Postgres; Vercel serves the dashboard.

Both platforms deploy from GitHub, so **push first** — neither reads your local
working tree.

```bash
git add -A && git commit -m "…" && git push
```

---

## 1. Railway — Postgres

New Project → **Deploy PostgreSQL**. Nothing to configure; note that Railway
exposes the connection string as `DATABASE_URL` on the Postgres service, and
services in the same project can reference each other's variables.

## 2. Railway — API

**New Service → GitHub Repo →** this repository.

Settings that matter, and why:

| Setting          | Value                      |
| ---------------- | -------------------------- |
| Root Directory   | **`/`** — _not_ `apps/api` |
| Dockerfile Path  | `apps/api/Dockerfile`      |
| Healthcheck Path | `/health`                  |

**The root directory is the one people get wrong.** The Dockerfile installs with
pnpm and needs `pnpm-lock.yaml` and `pnpm-workspace.yaml`, which live at the repo
root. Pointing Railway at `apps/api` produces a build that fails on a lockfile
that is right there.

`railway.json` at the repo root already declares the builder, start command,
healthcheck, and the pre-deploy migration. If Railway does not pick up
`preDeployCommand`, set it in **Settings → Deploy → Pre-Deploy Command**:

```
node apps/api/dist/db/migrate.js
```

Migrations run there rather than at container boot deliberately: N replicas each
migrating on startup is a race. A pre-deploy step runs once per deployment.

### Variables

```
DATABASE_URL      ${{Postgres.DATABASE_URL}}     # Railway reference, not a literal
NODE_ENV          production
PORT              3000
CORS_ORIGINS      https://<your-app>.vercel.app  # exact origin, no trailing slash
LOG_LEVEL         info
OUTBOX_POLL_MS    1000
TRUST_PROXY_HOPS  1
```

`CORS_ORIGINS` is a chicken-and-egg: you will not know the Vercel URL until
step 3. Deploy with a placeholder, then come back and set it.

**`TRUST_PROXY_HOPS` matters more than it looks.** Railway terminates TLS at its
edge, so every request reaches the app from the same internal address. Rate
limiting buckets by client IP, so without this the entire internet shares one
bucket — the limiter still fires, but as a global cap, and one noisy caller
throttles every other client. Railway is exactly one hop, hence `1`.

It defaults to `0` because trusting a hop that is not there is the worse mistake:
any caller could then set `X-Forwarded-For` and be metered as whatever address
they chose. Set it to the real hop count, not to `true`.

**`METRICS_TOKEN` is optional and left unset here.** It gates `/metrics` behind a
bearer token when present. The demo deployment wants the endpoint curl-able —
the README points reviewers at it — so it stays open, and the app logs a warning
at boot to say so. Set it for anything that is not a demo.

Then **Settings → Networking → Generate Domain** for a public URL.

### Seed the demo data

Once deployed, from the Railway service shell (or `railway run` locally):

```bash
node apps/api/dist/db/seed.js
```

Seeding is **destructive** — it truncates `sites`, `measurements` and `outbox`,
and `ingestion_batches` goes with them by cascade. Run it once, before the link
goes to anyone. It exists so the demo URL is not an empty table, and so the site
seeded at 130% of its limit makes `Limit Exceeded` visible without a reviewer
having to ingest anything.

Note it runs **without** `--if-empty` here. Compose passes that flag so a restart
does not discard ingested data; seeding a deployment is a deliberate act, so it
rebuilds unconditionally.

### The `pnpm db:*` scripts do not work in the deployment

`pnpm db:seed` and `pnpm db:verify` are **local-only**, despite being listed in
the README. They resolve to `tsx … src/db/seed.ts`, and the production image has
neither piece: `tsx` is a devDependency that is not installed, and only
`apps/api/dist` is copied — the TypeScript source never ships. The failure is an
unhelpful `tsx: not found`.

Run the compiled files instead. `WORKDIR` is `/app`, so these work as written:

| Local             | In the deployment                  |
| ----------------- | ---------------------------------- |
| `pnpm db:seed`    | `node apps/api/dist/db/seed.js`    |
| `pnpm db:verify`  | `node apps/api/dist/db/verify.js`  |
| `pnpm db:migrate` | `node apps/api/dist/db/migrate.js` |

Running them in the service shell also means `DATABASE_URL` is already present
and reached over Railway's private network — no connection string to copy, paste,
or leave in shell history. Prefer that over exporting `DATABASE_PUBLIC_URL`
locally.

---

## 3. Vercel — dashboard

**Add New → Project →** this repository.

| Setting         | Value                                             |
| --------------- | ------------------------------------------------- |
| Framework       | Next.js (auto-detected)                           |
| Root Directory  | **`apps/web`**                                    |
| Build Command   | `pnpm --filter @emissions/web build`              |
| Install Command | leave default — Vercel handles the pnpm workspace |

Nothing to configure for the Next output mode. `output: 'standalone'` produces a
self-contained Node server for the Docker image and is opted into by that
Dockerfile via `BUILD_STANDALONE=1`; every other build, Vercel included, gets
Next's default. A platform building its own serverless output would fail looking
for the file-tracing manifest standalone emits, so the default is the safe one.

### Variables

```
NEXT_PUBLIC_API_URL   https://<your-api>.up.railway.app
API_URL_INTERNAL      https://<your-api>.up.railway.app
```

Both point at the same public URL in this topology, but they are **not
interchangeable in general** and the code treats them separately:

- `NEXT_PUBLIC_API_URL` is inlined into the client bundle at build time and must
  be reachable from a **browser**.
- `API_URL_INTERNAL` is used by Server Components, which run on Vercel's servers.

Locally under compose these differ — `http://localhost:3000` versus
`http://api:3000` — and collapsing them into one value is the standard way to
break a containerised Next.js app. Keeping both here means the local and
deployed configurations have the same shape.

Because `NEXT_PUBLIC_*` is baked at build time, **changing it requires a
redeploy**, not just a variable update. Saving the variable and reloading the
page does nothing.

A production build without `NEXT_PUBLIC_API_URL` **fails** rather than falling
back to `localhost`. That fallback exists for `pnpm dev`; inlined into a
deployed bundle it produces a dashboard reaching for the _viewer's_ machine,
which renders correctly at first paint — server rendering uses the other
variable — and then raises a local-network permission prompt in the browser.

---

## 4. Close the CORS loop

Back on Railway, set `CORS_ORIGINS` to the exact Vercel origin and redeploy.

Vercel preview deployments get distinct URLs and will be blocked unless you add
them too. That is intentional — the API accepts writes, and a wildcard origin on
a write surface is a habit worth not forming even for a demo.

---

## 5. Verify the deployment, not just the deploy

A live URL that has not been exercised under retry is not evidence of anything.
Run the same check the local README does, against production:

```bash
API=https://<your-api>.up.railway.app
SITE=$(curl -s $API/sites | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
KEY=$(uuidgen)
BATCH="{\"siteId\":\"$SITE\",\"readings\":[{\"deviceId\":\"PROD-CHECK\",\"readingTs\":\"2026-08-09T12:00:00Z\",\"ch4Kg\":\"100.0000\",\"source\":\"sensor\"}]}"

curl -s $API/health/ready

for i in $(seq 1 10); do
  curl -s -o /dev/null -X POST $API/v2/ingest -H "Idempotency-Key: $KEY" \
    -H 'content-type: application/json' -d "$BATCH" &
done; wait

curl -s $API/sites/$SITE/metrics    # total must reflect ONE batch, +100.0000
```

Then open the dashboard, tick **Simulate a dropped response**, submit, and press
**Retry** — the replay banner should appear and the site total should not move.

---

## Notes

**Do not let the API sleep.** A reviewer clicking a link that hangs for 40 seconds
concludes it is broken. If you are on a plan that idles containers, either pay for
the deploy window or state the wake-up delay in the README next to the link — an
unexplained hang is far more damaging than a documented one.

**Redis is not deployed.** It is in `docker-compose.yml` because the brief
provided it, and nothing currently uses it. Adding it changes no behaviour.

**Rate limiting is on** — 300 requests per minute per client by default, tunable
via `RATE_LIMIT_MAX` and `RATE_LIMIT_TTL_MS`. These are public write endpoints on
the open internet.
