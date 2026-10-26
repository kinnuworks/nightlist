// Public surface of the Scout Intent engine.
export { Scout } from "./scout.ts";
export type {
  ScoutOptions, DecideInput, Decision, Candidate, Clarification, Interpretation, PlannedIntent, TelemetryEvent, Topology,
} from "./scout.ts";
export { IntentRegistry, validateIntent, GENERAL_ID } from "./registry.ts";
export type { Intent, ParameterSchema, ParamProp, RiskClass } from "./registry.ts";
export { LexicalScorer, stage1, merge, bandOf, selfTest, DEFAULT_BANDS, DEFAULT_WEIGHTS, SCAN_BUDGET_MS } from "./score.ts";
export type { Band, Bands, Weights, Stage2 } from "./score.ts";
export { bind, extractEntities, vagueReference } from "./interpret.ts";
export type { EntityRef, Binding, ParamError } from "./interpret.ts";
export { scanInjection, decodePayloads, CORE_RULES } from "./injection.ts";
export type { InjectionResult, InjectionFinding, InjectionKind, PatternRule, ScanOptions } from "./injection.ts";
export { GuardStack, composePolicy, findPii, applyRedactions, BUILTIN_PACKS } from "./guard.ts";
export type { Risk, RiskFlag, RiskLevel, Redaction, PolicyPack, IntentPolicy, DataClass, ApprovalKind } from "./guard.ts";
export { CapabilityGraph, ModelRouter, DEFAULT_PROFILES } from "./route.ts";
export type { ToolRegistration, ToolStep, RouteFailure, ModelProfile, ModelProfileRef } from "./route.ts";
export { verifyContract, signContract, canonicalJson, HmacSigner, Ulid } from "./contract.ts";
export type {
  ExecutionContract, UnsignedContract, IntentRef, IntentCandidate, ApprovalRecord, UserRef, Signer, VerifyOptions, VerifyResult, VerifyReason,
} from "./contract.ts";
