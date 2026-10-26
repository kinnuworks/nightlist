// Execution contracts: canonical encoding, HMAC signing, TTL, verification, lineage.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApprovalKind, Redaction, RiskFlag } from "./guard.ts";
import type { EntityRef } from "./interpret.ts";
import type { ModelProfileRef, ToolStep } from "./route.ts";

export interface IntentRef {
  id: string;
  version: number;
  category: string;
  riskClass: "low" | "medium" | "high";
}

export interface IntentCandidate {
  intent: string;
  score: number;
  span?: string;
}

export interface ApprovalRecord {
  kind: ApprovalKind;
  at: string;
  by?: string;
  confirmation?: string;
  decision?: "approve" | "reject";
}

export interface UserRef {
  id: string;
  role: string;
  permissions?: string[];
}

export interface PlannedIntentRef {
  id: string;
  version: number;
  span: string;
  confidence: number;
  parameters: Record<string, unknown>;
}

export interface ExecutionContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  intent: {
    primary: IntentRef;
    parameters: Record<string, unknown>;
    references: Record<string, EntityRef>;
    confidence: number;
    alternates: IntentCandidate[];
    /** Other intents of a multi-intent plan, in execution order. */
    plan?: PlannedIntentRef[];
  };
  risk: {
    level: "low" | "medium" | "high";
    flags: RiskFlag[];
    redactions: Redaction[];
    approvals: ApprovalRecord[];
    approvalsRequired: ApprovalKind[];
  };
  toolPlan: ToolStep[];
  modelProfile: ModelProfileRef;
  scope: {
    user: UserRef;
    surface: string;
    capabilities: string[];
    deadline?: string;
    budget?: { tokensMax?: number; costMaxUSD?: number };
  };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}

export type UnsignedContract = Omit<ExecutionContract, "signature" | "signedBy">;

/** Sorted keys, no whitespace, undefined dropped. Same input, same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return "null";
    return JSON.stringify(v) ?? "null";
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface Signer {
  readonly id: string;
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

export class HmacSigner implements Signer {
  readonly id = "hmac-sha256";
  private readonly key: Buffer;

  constructor(secret: string | Buffer) {
    if (!secret || secret.length < 8) throw new Error("signing secret must be at least 8 characters");
    this.key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8");
  }

  sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("hex");
  }

  verify(payload: string, signature: string): boolean {
    const want = Buffer.from(this.sign(payload), "hex");
    const got = Buffer.from(String(signature), "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

/** Per-process secret for deployments that did not configure one. */
export function ephemeralSecret(): Buffer {
  return randomBytes(32);
}

// ---- ULID (monotonic) --------------------------------------------------------

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class Ulid {
  private lastTime = -1;
  private lastRand: number[] = [];

  constructor(private readonly random: () => number = () => randomBytes(1)[0] / 256) {}

  next(now: number): string {
    let rand: number[];
    if (now <= this.lastTime) {
      now = this.lastTime;
      rand = [...this.lastRand];
      for (let i = rand.length - 1; i >= 0; i--) {
        if (rand[i] < 31) {
          rand[i]++;
          break;
        }
        rand[i] = 0;
      }
    } else {
      rand = Array.from({ length: 16 }, () => Math.floor(this.random() * 32) % 32);
    }
    this.lastTime = now;
    this.lastRand = rand;
    let t = "";
    let x = now;
    for (let i = 0; i < 10; i++) {
      t = B32[x % 32] + t;
      x = Math.floor(x / 32);
    }
    return t + rand.map((r) => B32[r]).join("");
  }
}

export function signContract(c: UnsignedContract, signer: Signer): ExecutionContract {
  const body = { ...c, signedBy: "scout" as const };
  return { ...body, signature: signer.sign(canonicalJson(body)) };
}

export type VerifyReason =
  | "malformed"
  | "unsigned"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "scope-mismatch"
  | "approval-missing";

export interface VerifyOptions {
  secret?: string | Buffer;
  signer?: Signer;
  now?: Date | number;
  /** The capability or tool the executor is about to use. Must be in scope. */
  capability?: string;
  /** Require every approval listed in approvalsRequired (default true). */
  requireApprovals?: boolean;
  /** Clock skew allowed on issuedAt, in ms. */
  skewMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyReason;
}

export function verifyContract(contract: unknown, opts: VerifyOptions = {}): VerifyResult {
  const c = contract as ExecutionContract;
  if (!c || typeof c !== "object" || typeof c.contractId !== "string" || !c.scope || !c.risk || !c.intent) return { ok: false, reason: "malformed" };
  if (typeof c.signature !== "string" || !c.signature || c.signedBy !== "scout") return { ok: false, reason: "unsigned" };
  const signer = opts.signer ?? (opts.secret !== undefined ? new HmacSigner(opts.secret) : undefined);
  if (!signer) throw new Error("verifyContract needs a secret or signer");
  const { signature, ...body } = c;
  if (!signer.verify(canonicalJson(body), signature)) return { ok: false, reason: "bad-signature" };
  const now = opts.now === undefined ? Date.now() : typeof opts.now === "number" ? opts.now : opts.now.getTime();
  if (Date.parse(c.expiresAt) <= now) return { ok: false, reason: "expired" };
  if (Date.parse(c.issuedAt) > now + (opts.skewMs ?? 30000)) return { ok: false, reason: "not-yet-valid" };
  if (opts.capability !== undefined) {
    const inScope = c.scope.capabilities.includes(opts.capability) || c.toolPlan.some((s) => s.tool === opts.capability);
    if (!inScope) return { ok: false, reason: "scope-mismatch" };
  }
  if (opts.requireApprovals !== false) {
    for (const need of c.risk.approvalsRequired ?? []) {
      const ok = c.risk.approvals.some((a) => a.kind === need && a.decision !== "reject");
      if (!ok) return { ok: false, reason: "approval-missing" };
    }
  }
  return { ok: true };
}
