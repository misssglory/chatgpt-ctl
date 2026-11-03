export interface ZipCursorTarget { identity: string; messageOrder: number | null; }
export interface ZipCursorHistory { targetIdentity: string; turnOrder: number | null; }
export function zipTargetsAfterCursor<T extends ZipCursorTarget>(targets: T[], history?: ZipCursorHistory): T[];
export function zipTargetIsAfterCursor<T extends ZipCursorTarget>(target: T, targets: T[], history?: ZipCursorHistory): boolean;
