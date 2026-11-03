/** Targets are sorted newest first. Anchor to actual attachment identity in the DOM. */
export function zipTargetsAfterCursor(targets, history) {
  if (!history) return targets;
  const cursorPosition = targets.findIndex(t => t.identity === history.targetIdentity);
  if (cursorPosition >= 0) return targets.slice(0, cursorPosition);
  const oldTurn = Number.isInteger(history.turnOrder) ? history.turnOrder : null;
  return targets.filter(t => {
    if (t.identity === history.targetIdentity) return false;
    if (oldTurn !== null && Number.isInteger(t.messageOrder)) return t.messageOrder > oldTurn;
    return false;
  });
}
export function zipTargetIsAfterCursor(target, targets, history) {
  if (!history) return true;
  return zipTargetsAfterCursor(targets, history).some(t => t.identity === target.identity);
}
