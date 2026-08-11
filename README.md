# Emissions Ingestion & Analytics Engine

Methane ingestion, de-duplication, and compliance monitoring — built for the
Highwood engineering challenge.

**The thing to look at is the retry behaviour.** A field device that times out and
retries must never double-count an emission. [Prove it in 30 seconds](#prove-it)
below, or open the dashboard, tick *"Simulate a dropped response"*, submit, and
press **Retry** — the batch is recognised as a duplicate and the site total does
not move.

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

| | |
|---|---|
| Dashboard | http://localhost:3001 |
| API | http://localhost:3000 |
| Metrics | http://localhost:3000/metrics |
| pgAdmin (optional) | `docker compose --profile tools up -d` → :5050 |

Four sites are seeded at 15%, 45%, 85% and **130%** of their limits, so
`Limit Exceeded` is visible immediately without ingesting anything.

---

## Prove it

Copy-paste against a running stack. Each block is independent.

```bash
API=http://localhost:3000
SITE=$(curl -s $API/sites | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
KEY=$(uuidgen)

BATCH=$(cat <<JSON
{"siteId":"$SITE","readings":[
  {"deviceId":"DEMO-01","readingTs":"2026-08-09T12:00:00Z","ch4Kg":"100.0000","source":"sensor"}
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
pnpm test          # 106 tests: 90 API, 16 dashboard
pnpm lint          # eslint across the workspace
pnpm typecheck     # every package
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

| Script | |
|---|---|
| `pnpm test` | full suite — API and dashboard |
| `pnpm lint` / `lint:fix` | eslint across the workspace |
| `pnpm format` | prettier |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:seed` | reset demo data |
| `pnpm db:verify` | reconcile summaries against measurements |
| `pnpm --filter @emissions/api db:studio` | browse the database at :4983 |
| `pnpm infra:up` / `infra:down` | Postgres + Redis only |
| `pnpm infra:reset` | destroy volumes and restart |

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
