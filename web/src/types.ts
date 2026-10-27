// Shapes returned by the Nightlist API (server/src/main.ts). Optional fields are ones
// the server omits in some runs.

// "needs_review": no criterion failed, but a disease-defining criterion could not be
// checked from records and a person has to read it.
export type MatchStatus = "eligible_no_blockers" | "needs_review" | "possible_unknowns" | "not_eligible";
export type Verdict = "met" | "not_met" | "unknown";
export type Method = "rule" | "model" | "structured" | "none";
export type Category = "check" | "screening" | "review";

export interface Clinic {
  name: string;
  lat: number;
  lon: number;
  maxMiles: number;
}

export interface Status {
  runId: string;
  sampleMode: boolean;
  dataLayer: "duckdb" | "zetaris" | string;
  nightshift: { state: string; models: string[] | { id?: string; name?: string }[] };
  engines: { worldModel: string; hmem: string; scoutIntent: string };
  clinic: Clinic;
}

export type Row = Record<string, unknown>;

export interface DqResult {
  rule: string;
  table: string;
  invalid: number;
  why: string;
  sample: Row[];
}

// Criteria counts by how they were handled this run.
export interface CriteriaBreakdown {
  total: number;
  checkByRule: number;
  checkByModel: number;
  structured: number;
  screening: number;
  review: number;
  backTranslationAgree: number;
  backTranslationDisagree: number;
}

export interface Summary {
  runId: string;
  asOf: string;
  dataLayer?: string;
  trialsInSnapshot: number;
  trialsScreened: number;
  patients: number;
  criteria: Record<string, number>;
  criteriaBreakdown?: CriteriaBreakdown;
  dq: DqResult[];
  pairs: number;
  statusCounts: Partial<Record<MatchStatus, number>>;
  newMatches: number;
}

export interface DataItem {
  id: string;
  label: string;
  needsTissue: boolean;
  standardOfCare?: boolean;
}

export interface WorklistMatch {
  nctId: string;
  title?: string;
  phase?: string;
  status: MatchStatus;
  met: number;
  unknown: number;
  screening: number;
  review: number;
  specificity: number;
  coverage: number;
  nearestMiles: number;
  isNew: boolean;
  unknowns: { criterionId: string; text?: string; items?: DataItem[] }[];
  keyReview?: KeyReview[];
  verified?: { ok: boolean; notes: string[] };
  notes?: string[];
}

// A disease-defining criterion that could not be checked from records.
export interface KeyReview {
  criterionId: string;
  text: string;
}

export interface WorklistPatient {
  patientId: string;
  name: string;
  sex: string;
  age: number;
  zip: string;
  milesToClinic: number;
  ecog: number | null;
  story?: string;
  counts: { eligible: number; possible: number; blocked: number; needsReview?: number };
  matches: WorklistMatch[];
  setAside: { nctId: string; notes: string[] }[];
  topBlockers: { reason: string; trials: number }[];
  // Sentences a person has to read to settle this patient's top trials.
  reviewQueue?: ReviewQueueItem[];
  // Trials ruled out by at least one criterion checked against a source row.
  ruledOut?: number;
}

export interface ReviewQueueItem {
  nctId: string;
  criterionId: string;
  text: string;
}

export interface OneItemAway {
  patientId: string;
  item: string;
  label: string;
  needsTissue: boolean;
  trials: string[];
}

export interface ChangeItem {
  eventId?: string;
  seq?: number;
  kind?: string;
  summary: string;
  patientId?: string;
  nctId?: string;
  provenance?: { source?: string; observedAt?: string; runId?: string; by?: string; url?: string };
}

export interface Overnight {
  since?: string;
  sinceKind?: string;
  total?: number;
  // Set when the latest run had no changes and these groups come from an earlier run.
  fallbackFrom?: string;
  groups: { kind: string; label: string; count: number; items: ChangeItem[] }[];
}

// How the run's criteria were handled, for the compile funnel and the mode banner.
export interface HeadlineMode {
  modelPath?: "rules only" | "rules and model" | string;
  checkedByRule?: number;
  checkedByModel?: number;
  structured?: number;
  screening?: number;
  humanRead?: number;
  total?: number;
}

// What the night did for the coordinator.
export interface Headline {
  pairs?: number;
  ruledOutWithEvidence?: number;
  noBlockers?: number;
  needsReview?: number;
  openItems?: number;
  manualHoursAvoided?: { low?: number; high?: number };
  mode?: HeadlineMode;
}

export interface Worklist {
  runId: string;
  asOf: string;
  generatedAt?: string;
  headline?: Headline;
  featuredPatientId?: string;
  patients: WorklistPatient[];
  oneItemAway: OneItemAway[];
  overnight: Overnight;
}

export interface MemoryRecord {
  id: string;
  kind: string;
  text: string;
  actor?: string;
  patientId?: string;
  trialId?: string;
  criterionId?: string;
  createdAt: string;
  supersededBy?: string;
  supersedes?: string;
  archived?: boolean;
  score?: number;
  history?: { id: string; action: string; actor: string; at: string }[];
}

export interface PatientDetail {
  patient: Row & {
    patient_id: string;
    mrn?: string;
    given_name?: string;
    family_name?: string;
    sex?: string;
    birth_date?: string;
    age_years?: number;
    zip?: string;
    miles_to_clinic?: number;
    ecog?: number | null;
    ecog_date?: string | null;
    demo_story?: string | null;
  };
  diagnosis: Row[];
  biomarkers: Row[];
  labs: Row[];
  therapy: Row[];
  conditions: Row[];
  metastases: Row[];
  worklist?: WorklistPatient;
  memory: MemoryRecord[];
}

export interface CheckInfo {
  status: "agree" | "disagree" | "unchecked";
  backTranslation?: string;
  model?: string;
  reason?: string;
}

export interface Leaf {
  leaf: Record<string, unknown> & { k: string };
  value: "T" | "F" | "U";
  readable: string;
  sql: string;
  evidenceSql: string;
  evidence: Row[];
}

export interface CriterionResult {
  criterionId: string;
  kind: "inclusion" | "exclusion";
  verdict: Verdict;
  method: Method;
  caveat?: string;
  text?: string;
  readable?: string;
  check?: CheckInfo;
  items?: DataItem[];
  leaves: Leaf[];
}

export interface Site {
  siteId?: string;
  facility: string;
  city: string;
  state: string;
  zip?: string;
  miles: number;
}

export interface Trial {
  nctId: string;
  title: string;
  phase?: string;
  status?: string;
  sponsor?: string;
  lastUpdate?: string;
  minAge?: number;
  maxAge?: number;
  sex?: string;
  sites: Site[];
  nearestMiles?: number;
  eligibility?: string;
}

export interface NotChecked {
  criterionId: string;
  kind: "inclusion" | "exclusion";
  category: "screening" | "review";
  text: string;
  caveat?: string;
}

export interface MatchDetail {
  patientId: string;
  nctId: string;
  status: MatchStatus;
  met: number;
  unknown: number;
  screening?: number;
  review?: number;
  nearestMiles?: number;
  specificity?: number;
  coverage?: number;
  verified?: { ok: boolean; notes: string[] };
  keyReview?: KeyReview[];
  results: CriterionResult[];
  notChecked: NotChecked[];
  trial: Trial;
  memory: MemoryRecord[];
}

export interface TrialCriterion {
  criterionId: string;
  nctId?: string;
  kind: "inclusion" | "exclusion";
  ordinal?: number;
  text: string;
  category: Category;
  method: Method;
  pred?: unknown;
  readable?: string;
  caveat?: string;
  check?: CheckInfo;
}

export interface TrialDetail {
  trial: Trial;
  criteria: TrialCriterion[];
}

export interface TraceEvent {
  ts: string;
  seq: number;
  runId?: string;
  agent: string;
  action: string;
  status: string;
  summary: string;
  target?: string;
  model?: string;
  durationMs?: number;
  data?: unknown;
}

export interface Usl {
  ddl: Record<string, string>;
  counts: Record<string, number>;
  dq: DqResult[];
  rules: { name: string; table: string; expr: string; why: string }[];
  activation?: Record<string, string>;
}

export interface MemoryInput {
  patientId: string;
  trialId?: string;
  kind: "preference" | "decision" | "correction" | "fact";
  text: string;
  actor: string;
}
