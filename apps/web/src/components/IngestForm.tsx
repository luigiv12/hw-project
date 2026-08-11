'use client';

import { useRef, useState } from 'react';
import { ingestSchema, type IngestResult, type Site } from '@emissions/contracts';
import { ApiRequestError, NetworkError, ingest } from '@/lib/api';

type Reading = {
  /**
   * Optional producer-assigned identity. Blank means not supplied, and the key
   * is omitted from the payload rather than sent empty — a device with no
   * identity to give is not the same as one supplying a blank one.
   */
  readingId: string;
  deviceId: string;
  readingTs: string;
  ch4Kg: string;
  source: 'sensor' | 'satellite' | 'manual';
};

/**
 * The last completed result. In-flight status lives separately in `busy`, so a
 * submission never clears the previous outcome — it is replaced only once a new
 * one exists, and the surrounding layout does not move in between.
 */
type Outcome =
  | { kind: 'idle' }
  | { kind: 'ok'; result: IngestResult; replayed: boolean }
  | { kind: 'error'; title: string; detail: string; code?: string; fields?: string[] };

/**
 * `datetime-local` wants a zone-less "YYYY-MM-DDTHH:mm:ss".
 *
 * Seconds are included deliberately, paired with step="1" on the input. The
 * control defaults to minute granularity, which would make it impossible to
 * enter two readings from one device less than a minute apart — they would
 * collapse onto the same identity and the second would be rejected as a
 * duplicate. The precision ladder here is: Postgres microseconds, API
 * milliseconds, this form seconds.
 */
function localNow(offsetHours = 0): string {
  const d = new Date(Date.now() + offsetHours * 3_600_000);
  return toLocalInput(new Date(d.getTime()).toISOString());
}

/** ISO instant → the zone-less local wall time `datetime-local` expects. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
}

/**
 * Either input format → a canonical ISO instant.
 *
 * One conversion serves both modes because `new Date()` already distinguishes
 * them: a zone-less string from the picker is read as local wall time, and an
 * ISO string carrying an offset is read as the instant it names. Returns the
 * input untouched when unparseable, so a half-typed value survives re-render
 * and the shared schema — not this function — decides what is valid.
 */
function toIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

const blankReading = (i = 0): Reading => ({
  // Empty on purpose: the default path exercises the natural-key fallback, which
  // is what every v1 sensor uses. Supplying one is an explicit choice.
  readingId: '',
  deviceId: 'FIELD-PROBE-01',
  readingTs: localNow(-i),
  ch4Kg: '12.5',
  source: 'manual',
});

export function IngestForm({
  sites,
  onIngested,
}: {
  sites: Site[];
  onIngested: () => void;
}) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [readings, setReadings] = useState<Reading[]>([blankReading()]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [dropResponse, setDropResponse] = useState(false);

  /**
   * Swaps the native picker for a raw ISO-8601 text field.
   *
   * The picker cannot express sub-second times reliably: it needs step="0.001"
   * for milliseconds and browsers disagree about honouring it, so the form's
   * precision would silently depend on the reviewer's browser. A text field
   * behaves identically everywhere, reaches the API's millisecond floor exactly,
   * and can be pasted into — which is what makes the collision cases testable
   * from the UI at all.
   */
  const [preciseMode, setPreciseMode] = useState(false);

  /**
   * The idempotency key for the current *attempt chain*.
   *
   * Generated once when a submission begins and deliberately retained on
   * failure, so Retry sends the same key. This is the whole frontend half of the
   * de-duplication contract: a client that minted a fresh key on retry would
   * defeat the server's protection entirely, because the server would have
   * nothing to recognise the request by.
   *
   * Cleared only after a success, at which point the next submission is a
   * genuinely new batch and deserves a new key.
   */
  const attemptKey = useRef<string | null>(null);

  /** Consumed by the first send after the toggle is enabled. */
  const chaosArmed = useRef(false);

  const setReading = (i: number, patch: Partial<Reading>) =>
    setReadings((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  /**
   * Rewrites every timestamp into the representation the new mode edits, so the
   * instant a user chose survives the switch rather than being reinterpreted in
   * the wrong zone.
   */
  function switchMode(toPrecise: boolean) {
    setReadings((rs) =>
      rs.map((r) => ({
        ...r,
        readingTs: toPrecise
          ? toIso(r.readingTs)
          : toLocalInput(toIso(r.readingTs)),
      })),
    );
    setPreciseMode(toPrecise);
  }

  async function submit(isRetry: boolean) {
    const payload = {
      siteId,
      readings: readings.map(({ readingId, ...r }) => ({
        ...r,
        // The picker yields local wall time and the ISO field yields an instant;
        // toIso normalises both. An unparseable value passes through unchanged
        // and is caught by the schema below with a field-level message.
        readingTs: toIso(r.readingTs),
        // Omit the key entirely when blank rather than sending "".
        ...(readingId.trim() ? { readingId: readingId.trim() } : {}),
      })),
    };

    // Same schema the API validates with — a field rejected here is rejected
    // there, because there is only one definition of it.
    const parsed = ingestSchema.safeParse(payload);
    if (!parsed.success) {
      setOutcome({
        kind: 'error',
        title: 'This batch is not valid',
        detail: 'Fix the highlighted fields and submit again.',
        code: 'VALIDATION_ERROR',
        fields: parsed.error.issues.map(
          (i) => `${i.path.join('.') || 'form'}: ${i.message}`,
        ),
      });
      return;
    }

    if (!isRetry || !attemptKey.current) {
      attemptKey.current = crypto.randomUUID();
      chaosArmed.current = dropResponse;
    }

    setBusy(true);

    try {
      const { result, replayed } = await ingest(parsed.data, attemptKey.current);

      /**
       * Simulates the failure this system is built for: the server committed
       * the batch, and the response was lost on the way back. The client cannot
       * tell that apart from the request never arriving — which is exactly why
       * retrying has to be safe.
       */
      if (chaosArmed.current) {
        chaosArmed.current = false;
        throw new NetworkError(
          'The connection dropped before the response arrived (simulated).',
        );
      }

      attemptKey.current = null;
      setOutcome({ kind: 'ok', result, replayed });
      onIngested();
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) {
        setOutcome({
          kind: 'error',
          title: 'The API rejected this batch',
          detail: err.message,
          code: err.code,
          fields: err.apiError.details.map((d) => `${d.path}: ${d.message}`),
        });
      } else if (err instanceof NetworkError) {
        setOutcome({
          kind: 'error',
          title: 'No response from the API',
          detail: `${err.message} The batch may or may not have been recorded — retrying is safe.`,
        });
      } else {
        setOutcome({
          kind: 'error',
          title: 'Unexpected failure',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const canRetry = outcome.kind === 'error' && attemptKey.current !== null;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Manual ingestion</h2>
      </div>

      <div className="card-body">
        <div className="chaos">
          <input
            id="drop"
            type="checkbox"
            checked={dropResponse}
            onChange={(e) => setDropResponse(e.target.checked)}
          />
          <div>
            <label htmlFor="drop">Simulate a dropped response</label>
            <p>
              The batch still reaches the server and commits — only the reply is
              discarded, exactly as a field device experiences a timeout. Submit,
              then press Retry: the site total will not move.
            </p>
          </div>
        </div>

        {outcome.kind === 'error' && (
          <div className="alert error">
            <strong>{outcome.title}</strong>
            {outcome.detail}
            {outcome.code && (
              <>
                {' '}
                <code>{outcome.code}</code>
              </>
            )}
            {outcome.fields && outcome.fields.length > 0 && (
              <ul>
                {outcome.fields.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            {canRetry && (
              <div className="hint" style={{ marginTop: 8 }}>
                Retry will reuse <code>Idempotency-Key: {attemptKey.current}</code>
              </div>
            )}
          </div>
        )}

        {outcome.kind === 'ok' && outcome.replayed && (
          <div className="alert replay">
            <strong>Recognised as a duplicate — recorded once</strong>
            The server had already applied this batch and replayed its original
            response. {outcome.result.readingsAccepted} reading(s) were stored on
            the first attempt; the site total is unchanged at{' '}
            <code>{outcome.result.totalEmissionsToDateKg} kg</code>.
          </div>
        )}

        {outcome.kind === 'ok' && outcome.result.conflicts.length > 0 && (
          <div className="alert error">
            <strong>
              {outcome.result.conflicts.length} reading(s) were NOT stored
            </strong>
            Each collided with a stored reading carrying a different mass, so it
            could not be a retry — two distinct measurements are competing for one
            identity. Send a <code>readingId</code> so the device decides what
            counts as the same reading.
            <ul>
              {outcome.result.conflicts.map((c) => (
                <li key={`${c.deviceId}-${c.readingTs}`}>
                  <code>
                    {c.deviceId} @ {c.readingTs}
                  </code>{' '}
                  — submitted {c.submittedCh4Kg} kg, stored {c.storedCh4Kg} kg
                </li>
              ))}
            </ul>
          </div>
        )}

        {outcome.kind === 'ok' && !outcome.replayed && (
          <div className="alert ok">
            <strong>Batch accepted</strong>
            {outcome.result.readingsAccepted} of {outcome.result.readingsSubmitted}{' '}
            reading(s) stored
            {outcome.result.readingsAccepted < outcome.result.readingsSubmitted && (
              <>
                {' '}
                — the rest were already present and were not counted again
              </>
            )}
            . Site total is now <code>{outcome.result.totalEmissionsToDateKg} kg</code>{' '}
            ({outcome.result.complianceStatus}).
          </div>
        )}

        <div className="field">
          <label htmlFor="site">Site</label>
          <select
            id="site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <label style={{ marginBottom: 0 }}>Readings</label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 0,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={preciseMode}
              onChange={(e) => switchMode(e.target.checked)}
              style={{ width: 'auto', margin: 0 }}
            />
            Precise ISO-8601 timestamps
          </label>
        </div>

        {preciseMode && (
          <p className="hint" style={{ marginBottom: 10 }}>
            Enter a full instant including offset, e.g.{' '}
            <code className="mono">2026-08-09T05:00:00.123Z</code>. Sub-second
            digits below a millisecond are discarded by the API.
          </p>
        )}
        {readings.map((r, i) => (
          <div className="reading-row" key={i}>
            <div>
              <input
                aria-label="Reading ID (optional)"
                value={r.readingId}
                onChange={(e) => setReading(i, { readingId: e.target.value })}
                placeholder="readingId — optional"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div>
              <input
                aria-label="Device ID"
                value={r.deviceId}
                onChange={(e) => setReading(i, { deviceId: e.target.value })}
                placeholder="Device ID"
              />
            </div>
            <div>
              {preciseMode ? (
                <input
                  aria-label="Reading time (ISO 8601)"
                  value={r.readingTs}
                  onChange={(e) => setReading(i, { readingTs: e.target.value })}
                  placeholder="2026-08-09T05:00:00.123Z"
                  spellCheck={false}
                  autoComplete="off"
                  style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
                />
              ) : (
                <input
                  aria-label="Reading time"
                  type="datetime-local"
                  // Without step="1" the control snaps to whole minutes and
                  // seconds cannot be entered at all.
                  step="1"
                  value={r.readingTs}
                  onChange={(e) => setReading(i, { readingTs: e.target.value })}
                />
              )}
            </div>
            <div>
              <input
                aria-label="CH4 kg"
                value={r.ch4Kg}
                onChange={(e) => setReading(i, { ch4Kg: e.target.value })}
                placeholder="kg CH₄"
                inputMode="decimal"
              />
            </div>
            <button
              type="button"
              className="secondary"
              disabled={readings.length === 1}
              onClick={() => setReadings((rs) => rs.filter((_, n) => n !== i))}
              aria-label="Remove reading"
            >
              ✕
            </button>
          </div>
        ))}

        <div className="actions" style={{ marginTop: 14 }}>
          {/* Sized for the widest label so the row does not reflow while busy. */}
          <button
            className="primary"
            style={{ minWidth: 132 }}
            disabled={busy}
            onClick={() => submit(false)}
          >
            {busy ? 'Submitting…' : 'Submit batch'}
          </button>

          {canRetry && (
            <button className="secondary" disabled={busy} onClick={() => submit(true)}>
              Retry with the same key
            </button>
          )}

          <button
            type="button"
            className="secondary"
            disabled={busy || readings.length >= 100}
            onClick={() =>
              setReadings((rs) => [...rs, blankReading(rs.length)])
            }
          >
            + Add reading
          </button>
        </div>

        <p className="hint">
          A batch carries at most 100 readings. Without a <code>readingId</code>,
          readings are de-duplicated on (site, device, timestamp) — so
          resubmitting the same reading never counts twice, even under a
          different key. Times are entered to the second here; the API stores to
          the millisecond. A device that samples faster than that must send a{' '}
          <code>readingId</code> so it, rather than the timestamp, decides what
          counts as the same reading.
        </p>
      </div>
    </div>
  );
}
