import { randomUUID } from 'node:crypto';
import { ErrorCode } from '@emissions/contracts';
import { Harness, reading, result } from './harness';

describe('idempotency', () => {
  const h = new Harness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  describe('layer 1 — the idempotency key', () => {
    it('replays the stored response for a retry and does not move the total', async () => {
      const site = await h.createSite();
      const key = randomUUID();
      const batch = [reading({ ch4Kg: '42.0000' })];

      const first = await h.ingest(site.id, batch, key);
      expect(first.replayed).toBe(false);
      expect(result(first.body).readingsAccepted).toBe(1);

      const retry = await h.ingest(site.id, batch, key);
      expect(retry.replayed).toBe(true);
      expect(result(retry.body).batchId).toBe(result(first.body).batchId);

      await h.expectReconciled(site.id, '42', 1);
    });

    it('treats a reordered but equivalent payload as the same batch', async () => {
      const site = await h.createSite();
      const key = randomUUID();

      const a = reading({
        deviceId: 'D1',
        readingTs: '2026-08-09T01:00:00.000Z',
        ch4Kg: '1.0000',
      });
      const b = reading({
        deviceId: 'D2',
        readingTs: '2026-08-09T02:00:00.000Z',
        ch4Kg: '2.0000',
      });

      await h.ingest(site.id, [a, b], key);

      /**
       * A retry is not guaranteed to be byte-identical — a client may
       * reserialise or reorder. Rejecting that as key reuse would break exactly
       * the retry this system exists to support, so the request fingerprint is
       * computed over a canonical form.
       */
      const retry = await h.ingest(site.id, [b, a], key);
      expect(retry.replayed).toBe(true);

      await h.expectReconciled(site.id, '3', 2);
    });

    it('treats an insignificant decimal difference as the same batch', async () => {
      const site = await h.createSite();
      const key = randomUUID();

      await h.ingest(site.id, [reading({ ch4Kg: '5.5000' })], key);

      // "5.5" and "5.5000" are the same mass; a retry must not be rejected over
      // formatting.
      const retry = await h.ingest(site.id, [reading({ ch4Kg: '5.5' })], key);
      expect(retry.replayed).toBe(true);

      await h.expectReconciled(site.id, '5.5', 1);
    });

    it('rejects the same key carrying a genuinely different batch', async () => {
      const site = await h.createSite();
      const key = randomUUID();

      await h.ingest(site.id, [reading({ ch4Kg: '10.0000' })], key);

      /**
       * Silently replaying here would discard a real batch of readings; treating
       * it as new would let one key describe two things. Both are worse than
       * telling the client it has a bug.
       */
      const mutated = await h.ingest(
        site.id,
        [reading({ ch4Kg: '999.0000' })],
        key,
      );

      expect(mutated.status).toBe(409);
      expect(mutated.body.error.code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);

      await h.expectReconciled(site.id, '10', 1);
    });

    it('requires an idempotency key', async () => {
      const site = await h.createSite();

      const res = await h.http
        .post('/v2/ingest')
        .send({ siteId: site.id, readings: [reading()] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);

      await h.expectReconciled(site.id, '0', 0);
    });

    it('scopes keys per site, so the same key on another site is not a duplicate', async () => {
      const [a, b] = [await h.createSite(), await h.createSite()];
      const key = randomUUID();

      const first = await h.ingest(a.id, [reading({ ch4Kg: '7.0000' })], key);
      const second = await h.ingest(b.id, [reading({ ch4Kg: '7.0000' })], key);

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(false);

      await h.expectReconciled(a.id, '7', 1);
      await h.expectReconciled(b.id, '7', 1);
    });
  });

  describe('layer 2 — the reading natural key', () => {
    it('does not count a reading twice when it arrives under a new key', async () => {
      const site = await h.createSite();
      const batch = [reading({ deviceId: 'NK-01', ch4Kg: '30.0000' })];

      await h.ingest(site.id, batch, randomUUID());

      // A different key is genuinely new at the request level, so layer 1 must
      // let it through. Only reading-level identity can stop the double count.
      const second = await h.ingest(site.id, batch, randomUUID());

      expect(second.replayed).toBe(false);
      expect(result(second.body).readingsAccepted).toBe(0);
      expect(Number(result(second.body).acceptedCh4Kg)).toBe(0);

      await h.expectReconciled(site.id, '30', 1);
    });

    it('accepts only the new readings from a partially overlapping batch', async () => {
      const site = await h.createSite();

      await h.ingest(site.id, [
        reading({
          deviceId: 'PART',
          readingTs: '2026-08-09T03:00:00.000Z',
          ch4Kg: '1.0000',
        }),
      ]);

      const second = await h.ingest(site.id, [
        reading({
          deviceId: 'PART',
          readingTs: '2026-08-09T03:00:00.000Z',
          ch4Kg: '1.0000',
        }),
        reading({
          deviceId: 'PART',
          readingTs: '2026-08-09T04:00:00.000Z',
          ch4Kg: '2.0000',
        }),
      ]);

      // The summary must move by what was accepted, not by what was submitted.
      expect(result(second.body).readingsSubmitted).toBe(2);
      expect(result(second.body).readingsAccepted).toBe(1);
      expect(Number(result(second.body).acceptedCh4Kg)).toBe(2);

      await h.expectReconciled(site.id, '3', 2);
    });

    it('reports a collision carrying a different mass instead of discarding it', async () => {
      const site = await h.createSite();
      const at = '2026-08-09T05:00:00.000Z';

      await h.ingest(site.id, [
        reading({ deviceId: 'CONF', readingTs: at, ch4Kg: '10.0000' }),
      ]);

      /**
       * A true retry resends identical values, so a differing mass is not a
       * retry — two distinct measurements are competing for one identity and one
       * was not stored. Silently dropping it would understate a regulatory
       * total, which nothing downstream would ever contradict.
       */
      const clash = await h.ingest(site.id, [
        reading({ deviceId: 'CONF', readingTs: at, ch4Kg: '47.5000' }),
      ]);

      const conflicts = result(clash.body).conflicts;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        deviceId: 'CONF',
        submittedCh4Kg: '47.5000',
        storedCh4Kg: '10.0000',
      });

      await h.expectReconciled(site.id, '10', 1);
    });
  });

  describe('identity is part of what makes a batch the same batch', () => {
    it('rejects a key reused for readings that differ only by readingId', async () => {
      const site = await h.createSite();
      const key = randomUUID();
      const base = {
        deviceId: 'HASH',
        readingTs: '2026-08-09T01:00:00.000Z',
        ch4Kg: '10.0000',
      };

      await h.ingest(site.id, [reading({ ...base, readingId: 'A' })], key);

      /**
       * readingId IS the identity when supplied, so these are different
       * measurements. Treating the second as a retry would replay a response
       * claiming its reading was stored, and reading B would be lost with the
       * caller told otherwise.
       */
      const second = await h.ingest(
        site.id,
        [reading({ ...base, readingId: 'B' })],
        key,
      );

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
      await h.expectReconciled(site.id, '10', 1);
    });

    it('rejects a batch carrying two readings with the same identity', async () => {
      const site = await h.createSite();
      const at = '2026-08-09T02:00:00.000Z';

      // The database would keep one and drop the other while reporting success.
      // Only the producer can say whether it meant one measurement or two.
      const res = await h.ingest(site.id, [
        reading({ deviceId: 'INTRA', readingTs: at, ch4Kg: '10.0000' }),
        reading({ deviceId: 'INTRA', readingTs: at, ch4Kg: '20.0000' }),
      ]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(res.body.error.details[0].message).toMatch(
        /duplicate reading identity/i,
      );
      await h.expectReconciled(site.id, '0', 0);
    });

    it('allows the same instant when the readings are distinctly identified', async () => {
      const site = await h.createSite();
      const at = '2026-08-09T03:00:00.000Z';

      const res = await h.ingest(site.id, [
        reading({
          readingId: 'x1',
          deviceId: 'OK',
          readingTs: at,
          ch4Kg: '10.0000',
        }),
        reading({
          readingId: 'x2',
          deviceId: 'OK',
          readingTs: at,
          ch4Kg: '20.0000',
        }),
      ]);

      expect(res.status).toBe(200);
      await h.expectReconciled(site.id, '30', 2);
    });

    it('refuses a reading whose identity scheme disagrees with the stored one', async () => {
      const site = await h.createSite();
      const at = '2026-08-09T04:00:00.000Z';

      await h.ingest(site.id, [
        reading({ deviceId: 'UPGRADE', readingTs: at, ch4Kg: '50.0000' }),
      ]);

      /**
       * The two partial indexes are mutually exclusive, so the database would
       * accept both rows. Only the producer knows whether this is the same
       * reading re-identified or a genuinely new one, so it is held back and
       * reported rather than guessed at.
       */
      const before = await h.duplicateCount('mixed_identity');
      const beforeDuplicates = await h.duplicateCount('duplicate_reading');

      const replay = await h.ingest(site.id, [
        reading({
          readingId: 'up-1',
          deviceId: 'UPGRADE',
          readingTs: at,
          ch4Kg: '50.0000',
        }),
      ]);

      expect(result(replay.body).readingsAccepted).toBe(0);
      expect(result(replay.body).conflicts).toHaveLength(1);
      expect(result(replay.body).conflicts[0].reason).toBe('mixed_identity');
      await h.expectReconciled(site.id, '50', 1);

      /**
       * Counted under its own reason, not folded into `value_conflict`. The two
       * are diagnosed differently — this one says a producer changed how it
       * identifies readings, which is a fleet event rather than a bad batch —
       * and the masses here are identical, so `value_conflict` would describe it
       * inaccurately as well as imprecisely.
       */
      expect(await h.duplicateCount('mixed_identity')).toBe(before + 1);

      /**
       * And it is counted under that reason *only*.
       *
       * A withheld reading is absent from `readingsAccepted` just as a
       * de-duplicated one is, so deriving the duplicate count from
       * submitted-minus-accepted silently attributes it to both. The brief asks
       * specifically how many requests were identified and rejected as
       * duplicates, and this reading was not one — nothing was recognised as
       * already stored, the server declined to guess which measurement was meant.
       */
      expect(await h.duplicateCount('duplicate_reading')).toBe(
        beforeDuplicates,
      );
    });

    it('refuses it in the other direction too, identified stored first', async () => {
      const site = await h.createSite();
      const at = '2026-08-09T05:30:00.000Z';

      await h.ingest(site.id, [
        reading({
          readingId: 'down-1',
          deviceId: 'DOWNGRADE',
          readingTs: at,
          ch4Kg: '50.0000',
        }),
      ]);

      /**
       * The mirror of the case above. Whether the identified or the anonymous
       * reading arrives first is an accident of ordering, not a fact about the
       * data, so it must not decide the outcome.
       */
      const second = await h.ingest(site.id, [
        reading({ deviceId: 'DOWNGRADE', readingTs: at, ch4Kg: '50.0000' }),
      ]);

      expect(result(second.body).readingsAccepted).toBe(0);
      expect(result(second.body).conflicts[0].reason).toBe('mixed_identity');
      await h.expectReconciled(site.id, '50', 1);
    });

    it('refuses a batch that mixes the two schemes at one instant', async () => {
      const site = await h.createSite();
      const at = '2026-08-09T06:45:00.000Z';

      /**
       * Same ambiguity as the two tests above, arriving in one request instead
       * of two. Rejected at validation rather than reported as a conflict,
       * because nothing has been stored yet — there is no partial success to
       * describe, only a batch that contradicts itself.
       */
      const res = await h.ingest(site.id, [
        reading({
          readingId: '200',
          deviceId: 'MIXED',
          readingTs: at,
          ch4Kg: '20.0000',
        }),
        reading({ deviceId: 'MIXED', readingTs: at, ch4Kg: '1.0000' }),
      ]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(res.body.error.details[0].message).toMatch(
        /identified and an unidentified reading/i,
      );
      await h.expectReconciled(site.id, '0', 0);
    });
  });

  describe('input is bounded before it reaches the database', () => {
    it.each([
      ['zero limit', { name: 'z', emissionLimitKg: '0' }],
      [
        'limit beyond the column',
        { name: 'z', emissionLimitKg: '999999999999' },
      ],
    ])('rejects %s with 400, not 500', async (_label, body) => {
      const res = await h.http.post('/v2/sites').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('rejects a mass beyond the column with 400, not 500', async () => {
      const site = await h.createSite();
      const res = await h.ingest(site.id, [
        reading({ ch4Kg: '99999999999.0' }),
      ]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('reading identity', () => {
    it('stores two readings at the same instant when the producer says they differ', async () => {
      const site = await h.createSite();
      const at = '2026-08-09T06:00:00.000Z';

      const res = await h.ingest(site.id, [
        reading({
          readingId: 'r-1',
          deviceId: 'SAME-TS',
          readingTs: at,
          ch4Kg: '10.0000',
        }),
        reading({
          readingId: 'r-2',
          deviceId: 'SAME-TS',
          readingTs: at,
          ch4Kg: '47.5000',
        }),
      ]);

      // Without readingId these collapse onto one identity and the second is
      // rejected. The producer is the only party that can know they are distinct.
      expect(result(res.body).readingsAccepted).toBe(2);
      await h.expectReconciled(site.id, '57.5', 2);
    });

    it('de-duplicates on readingId across batches', async () => {
      const site = await h.createSite();
      const batch = [
        reading({ readingId: 'stable-id', deviceId: 'RID', ch4Kg: '12.0000' }),
      ];

      await h.ingest(site.id, batch, randomUUID());
      const second = await h.ingest(site.id, batch, randomUUID());

      expect(result(second.body).readingsAccepted).toBe(0);
      await h.expectReconciled(site.id, '12', 1);
    });
  });
});
