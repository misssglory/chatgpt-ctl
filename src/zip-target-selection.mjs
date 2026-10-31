/**
 * Return how a ZIP control is associated with an assistant message.
 * Exact message UUID wins; a same-turn match is a safe fallback for ChatGPT
 * DIL controls rendered through portals with a different ancestor UUID.
 * No older/unknown turn is ever accepted as a fallback.
 */
export function zipTargetAssociation(target, assistant) {
  const expectedId = String(assistant?.id ?? "").toLowerCase();
  const targetId = String(target?.messageId ?? "").toLowerCase();
  if (expectedId && targetId && targetId === expectedId) return "message-id";
  if (
    Number.isInteger(assistant?.turnOrder) &&
    Number.isInteger(target?.messageOrder) &&
    target.messageOrder === assistant.turnOrder
  ) {
    return "turn-order";
  }
  return null;
}
