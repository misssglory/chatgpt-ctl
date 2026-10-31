export type ZipTargetIdentity = {
  messageId: string | null;
  messageOrder: number | null;
};

export type AssistantZipIdentity = {
  id: string;
  turnOrder?: number;
};

export function zipTargetAssociation(
  target: ZipTargetIdentity,
  assistant: AssistantZipIdentity,
): "message-id" | "turn-order" | null;
