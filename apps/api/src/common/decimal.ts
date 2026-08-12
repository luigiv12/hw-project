/**
 * Exact decimal comparison for the quantities this system reports.
 *
 * Masses and limits are `numeric` in Postgres and decimal strings on the wire,
 * precisely so no value ever passes through a binary float. Comparing them by
 * converting to `number` would reintroduce the rounding those choices exist to
 * avoid, at the one point where it decides whether a site is reported in breach.
 */

/** Returns >0 if a > b, 0 if equal, <0 if a < b. Exact for decimal strings. */
export function compareDecimalStrings(a: string, b: string): number {
  const [aInt, aFrac = ''] = a.split('.');
  const [bInt, bFrac = ''] = b.split('.');

  // Scale both to the same number of fractional digits so they can be compared
  // as integers, which BigInt does without loss at any magnitude.
  const width = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt(aInt + aFrac.padEnd(width, '0'));
  const bScaled = BigInt(bInt + bFrac.padEnd(width, '0'));

  return aScaled === bScaled ? 0 : aScaled > bScaled ? 1 : -1;
}
