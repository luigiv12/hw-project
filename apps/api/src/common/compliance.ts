import { ComplianceStatus } from '@emissions/contracts';
import { compareDecimalStrings } from './decimal';

/**
 * Whether a site's cumulative emissions have breached its permitted limit.
 *
 * A site exactly at its limit is *within* it — "Limit Exceeded" requires
 * strictly greater. The comparison is exact decimal rather than float, because
 * this is the value a regulator sees and it should not depend on binary
 * rounding.
 *
 * Lives here rather than beside the sites feature because it is a domain rule
 * with more than one caller: ingest evaluates it to decide whether a batch
 * crossed the threshold, and the metrics endpoint reports it.
 */
export function complianceFor(
  totalKg: string,
  limitKg: string,
): ComplianceStatus {
  return compareDecimalStrings(totalKg, limitKg) > 0
    ? ComplianceStatus.LIMIT_EXCEEDED
    : ComplianceStatus.WITHIN_LIMIT;
}
