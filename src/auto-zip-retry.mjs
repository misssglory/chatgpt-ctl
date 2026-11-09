/** Retry temporary download unavailability without replaying historical artifacts.
 * A newly observed file is eligible only after the watcher's fresh-turn guard.
 * Retry entries preserve that eligibility across subsequent polls when the
 * numeric turn baseline has advanced. State is process-local (not persisted).
 */
export const ZIP_AUTO_MAX_ATTEMPTS = 12;
export const ZIP_AUTO_MAX_AGE_MS = 15 * 60_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000];

export function nextZipAutoRetry(previous, now) {
  const attempts = (previous?.attempts ?? 0) + 1;
  const firstAt = previous?.firstAt ?? now;
  const exhausted = attempts >= ZIP_AUTO_MAX_ATTEMPTS || now - firstAt >= ZIP_AUTO_MAX_AGE_MS;
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return { attempts, firstAt, nextAt: now + delay, exhausted };
}

export function pendingZipCandidates(observed, fresh, pendingIds) {
  const freshIds = new Set(fresh.map(candidate => candidate.identity));
  return observed.filter(candidate => freshIds.has(candidate.identity) || pendingIds.has(candidate.identity));
}
