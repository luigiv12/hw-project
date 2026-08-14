import { ComplianceStatus } from '@emissions/contracts';
import { compareDecimalStrings } from './decimal';
import { complianceFor } from './compliance';
import { hashIngestRequest, normaliseDecimal } from './canonical-hash';
import { gramsToKilogramsExact } from '@emissions/contracts';

/**
 * Unit tests for the arithmetic the compliance decision rests on.
 *
 * These need no database: they exist because every one of them is a place where
 * using a JavaScript number instead of exact decimal arithmetic would produce a
 * plausible-looking wrong answer.
 */

describe('compareDecimalStrings', () => {
  it.each([
    ['1', '1', 0],
    ['1.0', '1', 0],
    ['1.0000', '1.00', 0],
    ['2', '1', 1],
    ['1', '2', -1],
    ['100.0001', '100.000', 1],
    ['99.9999', '100', -1],
    ['0.1', '0.09999', 1],
  ])('compares %s to %s', (a, b, expected) => {
    expect(Math.sign(compareDecimalStrings(a, b))).toBe(expected);
  });

  it('is exact where float comparison is not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float64. The database sums in
    // numeric, so the comparison must too.
    expect(compareDecimalStrings('0.3', '0.30000000000000004')).toBe(-1);
    expect(compareDecimalStrings('0.30000', '0.3')).toBe(0);
  });

  it('handles many decimal places without precision loss', () => {
    expect(compareDecimalStrings('1000000000.0001', '1000000000.0002')).toBe(
      -1,
    );
  });
});

describe('complianceFor', () => {
  it('treats a site exactly at its limit as within it', () => {
    // "Limit Exceeded" requires strictly greater. At the limit is compliant.
    expect(complianceFor('100.0000', '100.000')).toBe(
      ComplianceStatus.WITHIN_LIMIT,
    );
  });

  it('treats the smallest representable excess as exceeded', () => {
    expect(complianceFor('100.0001', '100.000')).toBe(
      ComplianceStatus.LIMIT_EXCEEDED,
    );
  });

  it('handles a zero total', () => {
    expect(complianceFor('0.0000', '1.000')).toBe(
      ComplianceStatus.WITHIN_LIMIT,
    );
  });
});

describe('normaliseDecimal', () => {
  it.each([
    ['5.50', '5.5'],
    ['5.000', '5'],
    ['0.10', '0.1'],
    ['5', '5'],
    ['0', '0'],
    ['10.0000', '10'],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseDecimal(input)).toBe(expected);
  });
});

describe('gramsToKilogramsExact', () => {
  it.each([
    [1000, '1'],
    [1, '0.001'],
    [0, '0'],
    [500, '0.5'],
    [12345, '12.345'],
    [1234.5, '1.2345'],
  ])('%s g -> %s kg', (grams, expected) => {
    expect(gramsToKilogramsExact(grams)).toBe(expected);
  });

  it('avoids the float artifact that naive division produces', () => {
    // 8.2 / 1000 evaluates to 0.008199999999999999.
    expect(gramsToKilogramsExact(8.2)).toBe('0.0082');
    expect(gramsToKilogramsExact(20.3)).toBe('0.0203');
    expect(gramsToKilogramsExact(1.005)).toBe('0.001005');
  });
});

describe('hashIngestRequest', () => {
  const base = {
    siteId: '0a5b1c2d-0000-4000-8000-000000000001',
    readings: [
      {
        deviceId: 'A',
        readingTs: '2026-08-09T01:00:00.000Z',
        ch4Kg: '1.0000',
        source: 'sensor' as const,
      },
      {
        deviceId: 'B',
        readingTs: '2026-08-09T02:00:00.000Z',
        ch4Kg: '2.0000',
        source: 'sensor' as const,
      },
    ],
  };

  it('is stable across reordered readings', () => {
    // A retry may reserialise or reorder; rejecting that as key reuse would
    // break the retry this system exists to support.
    const reversed = { ...base, readings: [...base.readings].reverse() };
    expect(hashIngestRequest(reversed)).toBe(hashIngestRequest(base));
  });

  it('is stable across equivalent decimal spellings', () => {
    const respelled = {
      ...base,
      readings: base.readings.map((r) => ({
        ...r,
        ch4Kg: `${Number(r.ch4Kg)}`,
      })),
    };
    expect(hashIngestRequest(respelled)).toBe(hashIngestRequest(base));
  });

  it('is stable across equivalent timestamp spellings', () => {
    const offset = {
      ...base,
      readings: [
        { ...base.readings[0], readingTs: '2026-08-08T20:00:00.000-05:00' },
        base.readings[1],
      ],
    };
    expect(hashIngestRequest(offset)).toBe(hashIngestRequest(base));
  });

  it('changes when a mass changes', () => {
    const altered = {
      ...base,
      readings: [{ ...base.readings[0], ch4Kg: '1.0001' }, base.readings[1]],
    };
    expect(hashIngestRequest(altered)).not.toBe(hashIngestRequest(base));
  });

  it('changes when a reading is added', () => {
    const extra = {
      ...base,
      readings: [
        ...base.readings,
        {
          deviceId: 'C',
          readingTs: '2026-08-09T03:00:00.000Z',
          ch4Kg: '3.0000',
          source: 'sensor' as const,
        },
      ],
    };
    expect(hashIngestRequest(extra)).not.toBe(hashIngestRequest(base));
  });
});
