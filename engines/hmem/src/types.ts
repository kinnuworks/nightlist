// Record, ledger and service shapes for the H-MEM engine.

export type MemoryType = "personal" | "factual" | "preference" | "general";
export type MemoryLayer = "short_term" | "working" | "long_term";

export type MemoryOrigin =
  | "chat" | "import" | "web" | "decision" | "curiosity" | "goal_run"
  | "user_explicit" | "inference" | "plan_run" | "mission" | "swarm_run"
  | "tool" | "brain";

export interface MemoryProvenance {
  origin: MemoryOrigin;
  learnedAt: number;
  label: string;
  refs?: {
    chatId?: string;
    importRunId?: string;
    importSource?: string;
    sourceUrl?: string;
    sourceDomain?: string;
    decisionId?: string;
    goalRunId?: string;
  };
}

export interface Entity {
  name: string;
  type: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  domain: string;
  namespace: string;
  embedding: number[];
  score?: number;
  confidence: number;
  source: string;
  provenance: MemoryProvenance;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  entities: Entity[];
  relatedTo: string[];
  supersedes?: string;
  supersededBy?: string;
  derivedFrom: string[];
}

export interface AddInput {
  content: string;
  source: string;
  type?: MemoryType;
  layer?: MemoryLayer;
  confidence?: number;
  tags?: string[];
  domain?: string;
  namespace?: string;
  provenance?: Partial<MemoryProvenance>;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  entities?: Entity[];
  relatedTo?: string[];
  supersedes?: string;
  derivedFrom?: string[];
  actor?: string;
  // Skip automatic relationship and supersession discovery.
  skipEnrichmentLinks?: boolean;
}

export const LEDGER_ACTIONS = [
  "create", "read", "update", "delete", "feedback", "promote", "demote", "merge",
  "conflict_detected", "conflict_resolved",
  "sleep_consolidate", "sleep_archive", "sleep_synthesize",
  "dream_proposed", "dream_approved", "dream_rejected", "restore",
] as const;
export type LedgerAction = (typeof LEDGER_ACTIONS)[number];

export interface LedgerEntry {
  id: string;
  memoryId: string;
  action: LedgerAction;
  actor: string;
  timestamp: number;
  previousState?: Partial<MemoryRecord>;
  newState?: Partial<MemoryRecord>;
  details?: Record<string, unknown>;
}

export type FeedbackKind = "helpful" | "not_helpful" | "wrong";

export interface ScoreSignals {
  semantic: number;
  keyword: number;
  tag: number;
  domain: number;
  entity: number;
  layer: number;
  recency: number;
  superseded: number;
  raw: number;
  confidence: number;
}

export interface RetrievedMemory {
  memory: MemoryRecord;
  relevance: number;
  signals: ScoreSignals;
}

export type Strategy = "minimal" | "personal" | "comprehensive" | "audit";

export interface QueryOptions {
  topN?: number;
  threshold?: number;
  strategy?: Strategy;
  tags?: string[];
  entities?: string[];
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  includeUnscoped?: boolean;
  filter?: (m: MemoryRecord) => boolean;
  touch?: boolean;
  actor?: string;
}

export interface QueryResult {
  memories: RetrievedMemory[];
  context: string;
  trace: {
    traceId: string;
    retrievalReason: string;
    strategy: Strategy;
    queryDomain: string;
    queryEntities: string[];
    scores: Record<string, number>;
    weightProfile: string;
    suppressedSuperseded: number;
  };
}

export interface SleepPreviewItem {
  id: string;
  preview: string;
  action: "consolidate" | "archive" | "synthesize";
  reason: string;
  ageDays: number;
  accessCount: number;
  confidence: number;
}

export interface SleepPreview {
  createdAt: number;
  toConsolidate: string[];
  toArchive: string[];
  toSynthesize: string[][];
  protected: { id: string; reasons: string[] }[];
  items: SleepPreviewItem[];
}

export interface SleepReport {
  backupId: string;
  ranAt: number;
  consolidatedCount: number;
  archivedCount: number;
  synthesizedCount: number;
  consolidated: string[];
  archived: string[];
  synthesized: { id: string; derivedFrom: string[] }[];
  actionLog: string[];
  ledgerIds: string[];
}

export type DreamProposalType = "insight" | "domain" | "invariant";

export interface DreamProposal {
  id: string;
  type: DreamProposalType;
  content: string;
  derivedFrom: string[];
  confidence: number;
  suggestedDomain?: string;
  status: "pending_review" | "approved" | "rejected";
  createdAt: number;
  decidedAt?: number;
  materializedId?: string;
}

export type ResolutionStrategy = "keep_a" | "keep_b" | "keep_both" | "merge" | "delete_both";

export interface ConflictRecord {
  id: string;
  memoryA: string;
  memoryB: string;
  kind: "opposing_phrase" | "numeric_divergence" | "negation";
  reason: string;
  confidence: number;
  status: "open" | "queued" | "resolved";
  detectedAt: number;
  resolution?: ResolutionStrategy;
  decisionConfidence?: number;
  resolvedAt?: number;
}

export const DEFAULTS = {
  topN: 5,
  threshold: 0.35,
  consolidationDays: 7,
  archiveMinDays: 30,
  archiveMaxAccess: 2,
  archiveProtectConfidence: 0.9,
  synthesisCosine: 0.82,
  dreamClusterMinSize: 2,
  dreamRelatedness: 0.35,
  maxDreamProposalsPerType: 8,
  conflictAutoResolveGate: 0.7,
  entityCap: 10,
  relatedCap: 5,
  recencyDays: 14,
  defaultConfidence: 0.7,
  backupsKept: 5,
} as const;

export const WEIGHTS = {
  semantic: 0.35,
  keyword: 0.2,
  tag: 0.1,
  domain: 0.1,
  entity: 0.15,
  layer: 0.05,
  recency: 0.05,
  superseded: 0.2,
} as const;

export const WEIGHT_PROFILE = "weights@spec-v1";

export const LAYER_WEIGHT: Record<MemoryLayer, number> = {
  long_term: 1.0,
  working: 0.8,
  short_term: 0.6,
};

export const FEEDBACK_DELTAS: Record<FeedbackKind, number> = {
  helpful: 0.05,
  not_helpful: -0.03,
  wrong: -0.2,
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// Trim float noise so stored values stay readable (0.7 - 0.2 -> 0.5).
export const tidy = (x: number): number => Math.round(x * 1e10) / 1e10;
