/**
 * Newly appeared assistant download controls are the automatic hook trigger.
 * The persisted cursor prevents replay of the last successfully processed ZIP,
 * but its turn/index must not hide a late attachment in the same assistant turn.
 * `targets` are in newest-first timeline order.
 */
export function autoZipCandidates(targets, handledIdentities, cursorIdentity = null) {
  return targets.filter(target =>
    target.identity !== cursorIdentity && !handledIdentities.has(target.identity));
}
