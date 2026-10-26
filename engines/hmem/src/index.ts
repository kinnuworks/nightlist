// Public entry point for the H-MEM engine.

export { HMEM } from "./hmem.ts";
export type { HMEMOptions, HMEMSnapshot } from "./hmem.ts";
export * from "./types.ts";
export { TrustLedgerService, snapshot } from "./ledger.ts";
export { MemoryStoreService } from "./store.ts";
export { MemoryRetrievalService, formatReinjection } from "./retrieval.ts";
export { ConflictDetectionService } from "./conflicts.ts";
export { SleepCycleService } from "./sleep.ts";
export { DreamingService } from "./dreaming.ts";
export { embed, cosine, tokenize, jaccard, extractEntities, classifyDomain } from "./text.ts";
export { NavigatorMemory, DEFAULT_RECALL_THRESHOLD } from "./navigator.ts";
export type { NavigatorKind, NavigatorDecision, NavigatorRecord, RecallContext, RecalledMemory, NightlyReport, HistoryEntry, NavigatorOptions } from "./navigator.ts";

