# Emissions Ingestion & Analytics Engine

Methane ingestion, de-duplication, and compliance monitoring — built for the
Highwood engineering challenge.

### Live

|               |                                                  |
| ------------- | ------------------------------------------------ |
| **Dashboard** | **https://hw-project-web.vercel.app**            |
| **API**       | **https://hw-project-production.up.railway.app** |

No login. Four sites are already seeded, one of them over its limit, so
`Limit Exceeded` is visible on arrival.

**The thing to look at is the retry behaviour.** A field device that times out
and retries must never double-count an emission.

On the dashboard: tick _"Simulate a dropped response"_, press **Submit**, then
press **Retry**. The first attempt reaches the server and commits — only the
reply is thrown away, which is exactly what a device experiences on a timeout.
The retry reuses the same idempotency key, the server recognises it, replays its
original response, and **the site total does not move.**

That interaction is the exercise. Everything else is in service of it.

Prefer a terminal? [Prove it in 30 seconds](#prove-it) — the same commands run
against the live API or a local stack.

Design decisions and trade-offs: **[ARCHITECTURE.md](./ARCHITECTURE.md)**.
Deploying it: **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

---

## Quick start

Requires Docker (Docker Desktop, OrbStack, or Colima) and nothing else.

```bash
cp .env.example .env
docker compose up
```

That is the whole setup. Postgres starts, migrations apply, demo data seeds, then
the API and dashboard come up in dependency order.

Bringing the stack up again does **not** re-seed: compose seeds only when the
database has no sites, so anything you ingest survives a restart. `pnpm db:seed`
rebuilds the demo dataset from scratch when you do want it back.

|                    |                                                |
| ------------------ | ---------------------------------------------- |
| Dashboard          | http://localhost:3001                          |
| API                | http://localhost:3000                          |
| Metrics            | http://localhost:3000/metrics                  |
| pgAdmin (optional) | `docker compose --profile tools up -d` → :5050 |

Four sites are seeded at roughly 15%, 45%, 85% and **130%** of their limits, so
`Limit Exceeded` is visible immediately without ingesting anything. Those figures
drift upward on the live demo as people ingest against it — which is the system
working, not a seeding error.

---

## Prove it

Copy-paste against the live API or a local stack — set `API` and everything
below is identical. Each block after this one is independent.

```bash
# live
API=https://hw-project-production.up.railway.app
# or local, after `docker compose up`
# API=http://localhost:3000

SITE=$(curl -s $API/sites | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
KEY=$(uuidgen)

# A device and instant unique to this run. The live API is shared, and readings
# de-duplicate on (site, device, timestamp) — reusing a fixed pair would make
# step 1 a no-op for the second person to try it, which is the mechanism working
# but a confusing place to meet it.
DEV="DEMO-$(uuidgen | head -c 8)"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

BATCH=$(cat <<JSON
{"siteId":"$SITE","readings":[
  {"deviceId":"$DEV","readingTs":"$TS","ch4Kg":"100.0000","source":"sensor"}
]}
JSON
)

total() { curl -s $API/sites/$SITE/metrics | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['totalEmissionsToDateKg'], d['complianceStatus'])"; }
```

**1. Ingest a batch**

```bash
total                                    # before
curl -s -X POST $API/v2/ingest -H "Idempotency-Key: $KEY" \
  -H 'content-type: application/json' -d "$BATCH" | python3 -m json.tool
total                                    # +100.0000
```

**2. Retry it — the timeout case**

```bash
curl -s -D- -X POST $API/v2/ingest -H "Idempotency-Key: $KEY" \
  -H 'content-type: application/json' -d "$BATCH" | grep -i '^x-idempotent-replay'
total                                    # UNCHANGED
```

→ `X-Idempotent-Replay: true`, and the original response is replayed verbatim.

**3. Fire ten retries at once**

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -X POST $API/v2/ingest -H "Idempotency-Key: $KEY" \
    -H 'content-type: application/json' -d "$BATCH" &
done; wait
total                                    # still unchanged
```

**4. Same readings, a brand-new key**

Layer 1 cannot help here — the key is genuinely new — so this is the reading-level
de-duplication doing the work.

```bash
curl -s -X POST $API/v2/ingest -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' -d "$BATCH" \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print('accepted',d['readingsAccepted'],'of',d['readingsSubmitted'],'-> +'+d['acceptedCh4Kg']+'kg')"
```

→ `accepted 0 of 1 -> +0kg`

**5. Reuse the key with different data — rejected, not absorbed**

```bash
curl -s -X POST $API/v2/ingest -H "Idempotency-Key: $KEY" \
  -H 'content-type: application/json' \
  -d "${BATCH//100.0000/999.0000}" | python3 -m json.tool
```

→ **409 `IDEMPOTENCY_KEY_REUSED`**. A retry resends identical content, so a
differing payload is a client bug and is surfaced rather than silently accepted.

**6. Check the counters**

```bash
curl -s $API/metrics | grep emissions_ingest_duplicate_total
```

**7. Reconcile**

```bash
pnpm db:verify
```

Recomputes every site's total from the raw measurements and compares it against
the stored summary. Exits non-zero on any drift, and says which direction — above
means double-counting, below means a lost update.

This one needs a database connection rather than the HTTP API, so it runs against
a local stack by default. Point it at a deployment with an inline connection
string:

```bash
DATABASE_URL="postgresql://…" pnpm db:verify
```

---

## Looking at the data

The stack is already running Postgres, so the shortest path needs nothing else
installed:

```bash
docker compose exec postgres psql -U emissions -d emissions
```

`\dt` lists the tables, `\d measurements` describes one. Or run a single query
without the shell:

```bash
docker compose exec postgres psql -U emissions -d emissions \
  -c "select name, total_emissions_to_date_kg, emission_limit_kg from sites order by name;"
```

Two queries are worth running, because they make design decisions visible that
the API deliberately hides:

**Partitioning is real, not described** (bonus #3). Every reading lives in the
partition for its month:

```sql
select tableoid::regclass as partition, count(*)
from measurements group by 1 order by 1;
```

```
 measurements_2026_06 | 480
 measurements_2026_07 | 480
 measurements_2026_08 | 216     ← current month, still filling
```

The seed writes three months ending today, so the partition names you see are
the three months preceding your own seed, not the ones above.

`measurements` itself is a _partitioned table_ — a definition and routing layer
with no storage of its own. Querying it reads through to the partitions, so
`count(*)` returns every row, while `ONLY` asks what the parent stores directly:

```sql
select (select count(*) from measurements)      as via_parent,
       (select count(*) from only measurements) as stored_in_parent,
       pg_relation_size('measurements')         as parent_bytes;
```

`via_parent` is however many readings you have; the other two are always **0**.
An insert is routed to a partition, and there is no way to make a row stay in the
parent.

**Idempotency keeps receipts.** Every batch is recorded with the hash of its
request and the exact response replayed to any retry. `readings_submitted`
against `readings_accepted` is the reading-level de-duplication in one column
pair — the site total moves by the accepted figure, never the submitted one:

```sql
select idempotency_key, status, readings_submitted, readings_accepted, accepted_ch4_kg
from ingestion_batches order by created_at desc limit 5;
```

### Other ways in

|                                          |                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @emissions/api db:studio` | Drizzle Studio — browsable and already connected, but costs a `pnpm install` the containerised app otherwise does not need. Serves on :4983 and the UI opens at **https://local.drizzle.studio**; :4983 on its own returns 404 |
| pgAdmin                                  | `docker compose --profile tools up -d` → :5050, login `admin@local.dev` / `admin`                                                                                                                                              |

pgAdmin starts with no server registered, so add one: host **`postgres`** — not
`localhost`, which from inside that container is pgAdmin itself — port `5432`,
and `emissions` for database, username and password. Set **maintenance database**
to `emissions` as well, or the tree opens on the empty `postgres` database and
looks like nothing was ever created.

---

## Bonus tasks

All eight are implemented.

| #   | Task                 | What was built                                                                                                                                    | Where                                                                               |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Concurrency control  | Pessimistic `SELECT … FOR UPDATE` on the site row, taken before the batch is claimed and held for the whole transaction                           | `ingest.handler.ts` · [§3](./ARCHITECTURE.md#3-concurrency-bonus-1)                 |
| 2   | Architecture pattern | Command/Processor via `@nestjs/cqrs` — both controllers build one command, a single handler owns the transaction                                  | `ingest.command.ts`, `ingest.handler.ts`                                            |
| 3   | DB scalability       | Monthly `RANGE` partitioning, plus a `DEFAULT` partition so a bad clock cannot fail an insert                                                     | `drizzle/0000_init.sql` · [§4](./ARCHITECTURE.md#4-partitioning-bonus-3)            |
| 4   | Transactional outbox | Event written inside the ingest transaction; leased dispatcher with at-least-once delivery, retry backoff and dead-lettering                      | `src/outbox/` · [§5](./ARCHITECTURE.md#5-transactional-outbox-bonus-4)              |
| 5   | Developer experience | `docker compose up` → migrate, seed, API and dashboard in dependency order. No manual steps                                                       | `docker-compose.yml`                                                                |
| 6   | Observability        | Pino structured logs carrying the request id; `prom-client` counters including `emissions_ingest_duplicate_total`, split by which layer caught it | `src/observability/`                                                                |
| 7   | Type-safe contract   | One Zod definition per shape, imported by the API's validation pipes **and** the dashboard form — the same object validates both sides            | `packages/contracts/`                                                               |
| 8   | API versioning       | `VersioningType.URI` with no default version. `/v1` accepts legacy sensors (grams, epoch seconds) through an anti-corruption adapter              | `main.ts`, `contracts/src/legacy.ts` · [§6](./ARCHITECTURE.md#6-versioning-bonus-8) |

Two are visible without reading any code:

```bash
# 3 — the parent holds no rows; each month is its own table
docker compose exec postgres psql -U emissions -d emissions \
  -c "select tableoid::regclass, count(*) from measurements group by 1 order by 1;"

# 6 — the metric the brief names, split by detecting layer
curl -s localhost:3000/metrics | grep emissions_ingest_duplicate_total
```

---

## The endpoints

```
POST /sites                    create a site           (also /v1, /v2)
GET  /sites?limit=&cursor=     list with totals, paginated
GET  /sites/:id                one site
GET  /sites/:id/metrics        summary + compliance status
POST /v2/ingest                current format          Idempotency-Key header
POST /v1/ingest                legacy sensors          epoch seconds, grams, batch_id in body
GET  /health  /health/ready    liveness / readiness
GET  /metrics                  Prometheus exposition
```

`POST /ingest` without a version **404s deliberately** — the two formats differ by
a factor of 1000 (grams vs kilograms), so guessing would write a silently wrong
regulatory total. See ARCHITECTURE.md §6.

Every response is enveloped:

```jsonc
{ "data": { … }, "meta": { "requestId": "…", "timestamp": "…" } }
{ "error": { "code": "SITE_NOT_FOUND", "message": "…", "details": [] }, "meta": { … } }
```

Collections add page details to `meta`, leaving `data` a bare array:

```jsonc
{ "data": [ … ], "meta": { …, "page": { "limit": 50, "nextCursor": "…" } } }
```

Cursors are keyset rather than offsets, so pages stay correct while rows are
being written. Hand back `nextCursor` verbatim; `null` means the last page. The
full convention is in [ARCHITECTURE.md](./ARCHITECTURE.md#7-platform-conventions).

Send `X-Request-Id` and it propagates into `meta.requestId` and every log line.

---

## Tests

```bash
pnpm verify        # everything below, in one command
pnpm test          # 127 tests: 111 API, 16 dashboard
pnpm lint          # eslint across the workspace
pnpm typecheck     # every package
pnpm format:check  # prettier
```

Runs against the compose Postgres — no mocks, because what is under test
(`ON CONFLICT` semantics, `SELECT FOR UPDATE`, exact `numeric` arithmetic,
partition routing) is database behaviour. Tests create and delete their own
sites, so the seeded demo survives a test run.

The two headline cases live in `apps/api/test/concurrency.e2e-spec.ts`:

- **10 identical requests, one key** → exactly one applied, nine replayed
  byte-identically, total +200 once
- **10 distinct batches, one site** → all ten applied, total exactly +100, no
  lost updates
- the same two at **50 concurrent writers**, for headroom

---

## Local development

Node 24 (pinned in `.node-version`) and pnpm 11.

```bash
pnpm install
docker compose up -d postgres redis     # infra only
pnpm build                              # contracts, then api
pnpm db:migrate && pnpm db:seed

cd apps/api && pnpm dev                 # :3000, watch mode
cd apps/web && pnpm dev                 # :3001
```

| Script                                   |                                                          |
| ---------------------------------------- | -------------------------------------------------------- |
| `pnpm verify`                            | format, lint, typecheck and test                         |
| `pnpm test`                              | full suite — API and dashboard                           |
| `pnpm lint` / `lint:fix`                 | eslint across the workspace                              |
| `pnpm format` / `format:check`           | prettier                                                 |
| `pnpm db:migrate`                        | apply migrations                                         |
| `pnpm db:seed`                           | rebuild demo data — **destructive**                      |
| `pnpm db:verify`                         | reconcile summaries against measurements                 |
| `pnpm --filter @emissions/api db:studio` | browse the database — UI at https://local.drizzle.studio |
| `pnpm infra:up` / `infra:down`           | Postgres + Redis only                                    |
| `pnpm infra:reset`                       | destroy volumes and restart                              |

Any `db:*` script accepts an inline connection string, which is how to point one
at a deployed database:

```bash
DATABASE_URL="postgresql://…" pnpm db:verify
```

**Troubleshooting.** If a change does not appear, check nothing else holds the
port — `lsof -nP -iTCP:3001 -sTCP:LISTEN` — before suspecting the build. After
editing migrations, rebuild **all** images (`docker compose build`, not
`build api`): `migrate` is a separate image and a partial rebuild leaves the
schema out of step with the code.

---

## Layout

```
apps/api/
  src/ingest/          the graded transaction — handler is the file to read
  src/sites/           CRUD + compliance calculation
  src/outbox/          transactional outbox dispatcher
  src/observability/   Prometheus metrics
  src/common/          envelope, exception filter, request id, canonical hash
  src/db/              Drizzle schema, migrate, seed, verify
  drizzle/             hand-written SQL migrations (partitioned DDL)
  test/                integration suites

apps/web/
  src/components/      Dashboard, SitesTable, IngestForm
  src/lib/api.ts       typed client, unwraps the envelope

packages/contracts/    Zod schemas + error codes, imported by both apps
```

Reading order for a reviewer: `drizzle/0000_init.sql` for the constraints
everything rests on, then `src/ingest/ingest.handler.ts` for the transaction.
