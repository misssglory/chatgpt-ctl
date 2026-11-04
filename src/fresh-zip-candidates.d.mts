export type FreshZipTarget = { messageOrder: number | null; messageId: string | null };
export declare function freshZipCandidates<T extends FreshZipTarget>(targets: T[], baselineTurn: number | null | undefined, newlyCompletedIds?: ReadonlySet<string>): T[];
