import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA = join(ROOT, "data");
export const SOURCES = join(DATA, "sources");
export const RUNTIME = process.env.NIGHTLIST_RUNTIME ?? join(DATA, "runtime");
export const COMPILED = process.env.NIGHTLIST_COMPILED ?? join(DATA, "compiled");
export const LOGS = process.env.NIGHTLIST_LOGS ?? join(ROOT, "logs");

// Minimal .env loader so the project has no runtime dependency for it.
for (const file of [join(ROOT, ".env"), join(ROOT, ".env.local")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k: string, d = "") => process.env[k] ?? d;
const truthy = (v: string) => /^(1|true|yes|on)$/i.test(v);
// The official METERLESS_* names win when set; the older NIGHTSHIFT_* names still work.
const either = (official: string, legacy: string, d = "") => process.env[official] || process.env[legacy] || d;

export const config = {
  sampleMode: truthy(env("SAMPLE_MODE", "true")),
  port: Number(env("PORT", "8787")),
  clinic: { name: "River Region Cancer Care (fictional)", lat: 32.3668, lon: -86.3, maxMiles: Number(env("MAX_SITE_MILES", "250")) },
  zetaris: {
    channel: env("ZETARIS_CHANNEL", "rest") as "rest" | "jdbc",
    restUrl: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0"),
    apiKey: env("ZETARIS_API_KEY"),
    orgId: env("ZETARIS_ORG_ID", "1"),
    uslNamespace: env("ZETARIS_USL_NAMESPACE", "lightning.metastore.rrcc"),
    usl: env("ZETARIS_USL", "trialmatch"),
    timeoutMs: Number(env("ZETARIS_TIMEOUT_MS", "120000")),
  },
  nightshift: {
    baseUrl: either("METERLESS_BASE_URL", "NIGHTSHIFT_URL", "http://127.0.0.1:8088/v1"),
    token: either("METERLESS_RUNTIME_TOKEN", "NIGHTSHIFT_TOKEN"),
    tokenFile: env("NIGHTSHIFT_TOKEN_FILE"),
    app: "nightlist",
    compileModel: either("METERLESS_MODEL", "NIGHTSHIFT_COMPILE_MODEL", "meterless/deep"),
    checkModel: env("NIGHTSHIFT_CHECK_MODEL", "meterless/fast"),
    timeoutMs: Number(env("NIGHTSHIFT_TIMEOUT_MS", "180000")),
  },
};

export type Config = typeof config;
