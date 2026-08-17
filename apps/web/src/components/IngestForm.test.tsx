import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ComplianceStatus,
  type IngestResult,
  type Site,
} from '@emissions/contracts';
import { IngestForm } from './IngestForm';
import { NetworkError, ingest } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, ingest: vi.fn() };
});

const ingestMock = vi.mocked(ingest);

const site: Site = {
  id: '0a5b1c2d-0000-4000-8000-000000000001',
  name: 'Test Pad',
  emissionLimitKg: '1000.000',
  totalEmissionsToDateKg: '10.0000',
  measurementCount: 1,
  complianceStatus: ComplianceStatus.WITHIN_LIMIT,
  metadata: {},
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const okResult = (over: Partial<IngestResult> = {}): IngestResult => ({
  batchId: '11111111-1111-4111-8111-111111111111',
  siteId: site.id,
  readingsSubmitted: 1,
  readingsAccepted: 1,
  acceptedCh4Kg: '12.5000',
  totalEmissionsToDateKg: '22.5000',
  complianceStatus: 'Within Limit',
  idempotentReplay: false,
  conflicts: [],
  ...over,
});

/** The key the component sent on the Nth call. */
const keyOfCall = (n: number) => ingestMock.mock.calls[n][1];
/** The payload the component sent on the Nth call. */
const payloadOfCall = (n: number) => ingestMock.mock.calls[n][0];

function renderForm() {
  return render(<IngestForm sites={[site]} onIngested={() => {}} />);
}

const submit = () => screen.getByRole('button', { name: /submit batch/i });
const retry = () =>
  screen.getByRole('button', { name: /retry with the same key/i });

describe('IngestForm', () => {
  beforeEach(() => {
    ingestMock.mockReset();
    renderForm();
  });

  it('sends an idempotency key with the batch', async () => {
    ingestMock.mockResolvedValue({ result: okResult(), replayed: false });

    await userEvent.click(submit());

    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(1));
    expect(keyOfCall(0)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  /**
   * The reason the whole retry mechanism works. A client that mints a new key on
   * retry gives the server nothing to recognise the request by, and the batch is
   * applied twice.
   */
  it('reuses the same key when retrying a failed submission', async () => {
    ingestMock.mockRejectedValueOnce(new NetworkError('connection dropped'));
    ingestMock.mockResolvedValueOnce({
      result: okResult({ idempotentReplay: true }),
      replayed: true,
    });

    await userEvent.click(submit());
    await screen.findByText(/no response from the api/i);

    await userEvent.click(retry());
    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(2));

    expect(keyOfCall(1)).toBe(keyOfCall(0));
  });

  it('shows the key it will reuse before you retry', async () => {
    ingestMock.mockRejectedValueOnce(new NetworkError('connection dropped'));

    await userEvent.click(submit());

    const shown = await screen.findByText(/Idempotency-Key:/i);
    expect(shown.textContent).toContain(keyOfCall(0));
  });

  it('mints a fresh key for the next batch after a success', async () => {
    ingestMock.mockResolvedValue({ result: okResult(), replayed: false });

    await userEvent.click(submit());
    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(1));

    await userEvent.click(submit());
    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(2));

    // A new submission is a new batch, not a retry of the previous one.
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it('reports a replay as recorded once rather than as a new batch', async () => {
    ingestMock.mockResolvedValue({
      result: okResult({ idempotentReplay: true }),
      replayed: true,
    });

    await userEvent.click(submit());

    expect(
      await screen.findByText(/recognised as a duplicate/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/unchanged/i)).toBeInTheDocument();
  });

  it('says nothing was stored when every reading was already present', async () => {
    ingestMock.mockResolvedValue({
      result: okResult({ readingsAccepted: 0, acceptedCh4Kg: '0' }),
      replayed: false,
    });

    await userEvent.click(submit());

    expect(await screen.findByText(/0 of 1/)).toBeInTheDocument();
    expect(screen.getByText(/not counted again/i)).toBeInTheDocument();
  });

  it('surfaces a reading that collided with a different mass', async () => {
    ingestMock.mockResolvedValue({
      result: okResult({
        readingsAccepted: 0,
        conflicts: [
          {
            reason: 'value_conflict' as const,
            deviceId: 'FIELD-PROBE-01',
            readingTs: '2026-08-09T12:00:00.000Z',
            submittedCh4Kg: '47.5000',
            storedCh4Kg: '10.0000',
          },
        ],
      }),
      replayed: false,
    });

    await userEvent.click(submit());

    expect(await screen.findByText(/were NOT stored/i)).toBeInTheDocument();
    expect(
      screen.getByText(/submitted 47.5000 kg, stored 10.0000 kg/i),
    ).toBeInTheDocument();
  });

  it('omits readingId from the payload when the field is blank', async () => {
    ingestMock.mockResolvedValue({ result: okResult(), replayed: false });

    await userEvent.click(submit());
    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(1));

    // Absent, not empty — a device with no identity to give is not the same as
    // one supplying a blank one, and "" would fail validation.
    expect(payloadOfCall(0).readings[0]).not.toHaveProperty('readingId');
  });

  it('sends readingId when one is supplied', async () => {
    ingestMock.mockResolvedValue({ result: okResult(), replayed: false });

    await userEvent.type(screen.getByLabelText(/reading id/i), 'sample-0001');
    await userEvent.click(submit());

    await waitFor(() => expect(ingestMock).toHaveBeenCalledTimes(1));
    expect(payloadOfCall(0).readings[0].readingId).toBe('sample-0001');
  });

  it('rejects an invalid batch before it reaches the API', async () => {
    const mass = screen.getByLabelText(/ch4 kg/i);
    await userEvent.clear(mass);
    await userEvent.type(mass, 'not-a-number');
    await userEvent.click(submit());

    expect(await screen.findByText(/not valid/i)).toBeInTheDocument();
    // The same schema the API validates with catches it here, so no request is
    // made at all.
    expect(ingestMock).not.toHaveBeenCalled();
  });
});
