// Intent registry: load, compose, validate, version.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type RiskClass = "low" | "medium" | "high";

export interface ParamProp {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: ParamProp;
  optional?: boolean;
  description?: string;
}

export interface ParameterSchema {
  type?: string;
  properties?: Record<string, ParamProp>;
  required?: string[];
}

export interface Intent {
  id: string;
  category: string;
  description: string;
  parameters: ParameterSchema;
  capabilities: string[];
  riskClass: RiskClass;
  surfaces: string[];
  roles: string[];
  examples: string[];
  version: number;
  /** Optional extra trigger phrases with weights in (0, 1]. */
  triggers?: Record<string, number>;
}

const ID = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;
const RISK: RiskClass[] = ["low", "medium", "high"];

export const GENERAL_ID = "GENERAL";

export function validateIntent(raw: any, where = "registry"): Intent {
  const fail = (m: string): never => {
    throw new Error(`${where}: intent ${raw?.id ?? "?"}: ${m}`);
  };
  if (!raw || typeof raw !== "object") fail("not an object");
  if (typeof raw.id !== "string" || !ID.test(raw.id)) fail("id must follow category.name grammar");
  if (!Array.isArray(raw.examples) || raw.examples.length === 0) fail("examples are mandatory");
  if (!RISK.includes(raw.riskClass)) fail(`riskClass must be one of ${RISK.join(", ")}`);
  for (const k of ["capabilities", "surfaces", "roles"]) {
    if (!Array.isArray(raw[k])) fail(`${k} must be an array`);
  }
  return {
    id: raw.id,
    category: typeof raw.category === "string" ? raw.category : raw.id.split(".")[0].toLowerCase(),
    description: String(raw.description ?? ""),
    parameters: raw.parameters ?? { type: "object", properties: {} },
    capabilities: raw.capabilities.map(String),
    riskClass: raw.riskClass,
    surfaces: raw.surfaces.map(String),
    roles: raw.roles.map(String),
    examples: raw.examples.map(String),
    version: Number.isFinite(raw.version) ? raw.version : 1,
    triggers: raw.triggers && typeof raw.triggers === "object" && !Array.isArray(raw.triggers)
      ? raw.triggers
      : Array.isArray(raw.triggers) ? Object.fromEntries(raw.triggers.map((t: string) => [t, 1])) : undefined,
  };
}

export class IntentRegistry {
  readonly intents: readonly Intent[];
  readonly registryVersion: number;
  private readonly byId: Map<string, Intent>;

  constructor(intents: Intent[], registryVersion = 1) {
    this.byId = new Map();
    for (const i of intents) {
      const v = validateIntent(i);
      if (this.byId.has(v.id)) throw new Error(`registry: duplicate intent id ${v.id}`);
      this.byId.set(v.id, v);
    }
    this.intents = [...this.byId.values()];
    this.registryVersion = registryVersion;
  }

  static fromObject(obj: unknown, where = "registry"): IntentRegistry {
    if (Array.isArray(obj)) return new IntentRegistry(obj.map((x) => validateIntent(x, where)));
    const o = obj as { version?: number; registryVersion?: number; intents?: unknown[] };
    if (!o || !Array.isArray(o.intents)) {
      // A single intent record.
      return new IntentRegistry([validateIntent(obj, where)]);
    }
    return new IntentRegistry(o.intents.map((x) => validateIntent(x, where)), o.registryVersion ?? o.version ?? 1);
  }

  static fromFile(path: string): IntentRegistry {
    return IntentRegistry.fromObject(JSON.parse(readFileSync(path, "utf8")), path);
  }

  /** One JSON file per intent (or per partial registry). */
  static fromDirectory(dir: string): IntentRegistry {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    const parts = files.map((f) => IntentRegistry.fromFile(join(dir, f)));
    return IntentRegistry.compose(parts);
  }

  static compose(parts: IntentRegistry[], registryVersion?: number): IntentRegistry {
    const all = parts.flatMap((p) => [...p.intents]);
    const version = registryVersion ?? Math.max(1, ...parts.map((p) => p.registryVersion));
    return new IntentRegistry(all, version);
  }

  static load(src: string | IntentRegistry | Intent[] | { intents: Intent[] }): IntentRegistry {
    if (src instanceof IntentRegistry) return src;
    if (typeof src === "string") {
      return statSync(src).isDirectory() ? IntentRegistry.fromDirectory(src) : IntentRegistry.fromFile(src);
    }
    return IntentRegistry.fromObject(src);
  }

  get(id: string): Intent | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}

/** Fallback used when a registry does not declare GENERAL. Never scored, never routed. */
export const BUILTIN_GENERAL: Intent = {
  id: GENERAL_ID,
  category: "general",
  description: "Safe fallback when no registered intent clears the reject band.",
  parameters: { type: "object", properties: {} },
  capabilities: [],
  riskClass: "low",
  surfaces: ["*"],
  roles: ["*"],
  examples: ["hello"],
  version: 1,
};
