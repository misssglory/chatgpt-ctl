export function autoZipCandidates<T extends { identity: string }>(
  targets: T[], handledIdentities: ReadonlySet<string>, cursorIdentity?: string | null
): T[];
