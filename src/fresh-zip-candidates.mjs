/**
 * Only fresh assistant turns and late attachments in the current newest turn
 * can trigger automation. Scrolling mounts previously unseen *older* turns;
 * those must not be mistaken for new generated files.
 *
 * If ChatGPT does not expose a stable numeric turn, only accept attachments
 * tied to a newly completed assistant message. Never infer freshness from the
 * DOM index (which changes during history virtualization).
 */
export function freshZipCandidates(targets, baselineTurn, newlyCompletedIds = new Set()) {
  return targets.filter(target => {
    if (Number.isFinite(target.messageOrder)) {
      return baselineTurn === null || baselineTurn === undefined
        ? Boolean(target.messageId && newlyCompletedIds.has(target.messageId))
        : target.messageOrder >= baselineTurn;
    }
    return Boolean(target.messageId && newlyCompletedIds.has(target.messageId));
  });
}
