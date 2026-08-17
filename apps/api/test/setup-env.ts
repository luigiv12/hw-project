import { config } from 'dotenv';
import { join } from 'node:path';

/**
 * Environment for the test run, applied before Nest boots.
 *
 * Reads the repo-root .env so a developer who has run `docker compose up` needs
 * no extra configuration, then overrides the settings that would interfere with
 * deterministic assertions.
 */
config({ path: join(__dirname, '..', '..', '..', '.env'), quiet: true });

process.env.NODE_ENV = 'test';

process.env.DATABASE_URL ??=
  'postgresql://emissions:emissions@localhost:5432/emissions';

/**
 * The outbox dispatcher is driven explicitly by the tests that care about it
 * (`runOnce()`), never by the timer — a background poll firing mid-assertion
 * would make delivery counts non-deterministic. An hour is effectively "never"
 * for a test run.
 */
process.env.OUTBOX_POLL_MS = '3600000';

/**
 * Concurrency tests fire bursts well above ordinary traffic. Throttling is a
 * production concern and is exercised by its own test, not by every other one.
 */
process.env.RATE_LIMIT_MAX = '100000';
