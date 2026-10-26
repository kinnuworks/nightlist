// Deterministic local text features: tokenizer, hashed embedder, entities, domains.
// No network and no model calls; the same input always yields the same vector.

import type { Entity } from "./types.ts";
import { DEFAULTS } from "./types.ts";

export const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from into onto over under about as is are was were be been being " +
    "it its this that these those there here we you they he she i me my our your their his her them us do does did done " +
    "have has had having will would should could can may might must shall so than too very just also only not no nor " +
    "what when where which who whom why how all any each few more most other some such own same both up down out off again " +
    "once per via vs while during before after between through"
  ).split(/\s+/),
);

// Words that carry meaning for contradiction checks; never dropped as stopwords there.
export const NEGATIONS = new Set(["not", "no", "never", "none", "without", "cannot", "isnt", "doesnt", "dont", "wont"]);

export function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 0);
}

const SUFFIXES = [
  "ations", "ation", "ences", "ence", "ances", "ance", "ments", "ment", "ings", "ing",
  "edly", "ed", "es", "is", "ly",
];

// Light suffix stripping so "prefers", "preference" and "preferred" share a stem.
export function stem(t: string): string {
  if (/\d/.test(t) || t.length <= 4) return t;
  if (t.endsWith("ies") && t.length > 5) return t.slice(0, -3) + "y";
  for (const suf of SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= 4) {
      const base = t.slice(0, -suf.length);
      // "preferred" -> "preferr" -> "prefer"
      return /([b-df-hj-kmnp-rtv-y])\1$/.test(base) ? base.slice(0, -1) : base;
    }
  }
  if (t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

// Content tokens: stopwords removed, light stemming.
export function tokenize(text: string): string[] {
  return rawTokens(text).filter((t) => !STOPWORDS.has(t)).map(stem);
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

// Top-k query tokens by frequency, ties broken by first occurrence.
export function topTokens(text: string, k = 8): string[] {
  const toks = tokenize(text);
  const freq = new Map<string, { n: number; first: number }>();
  toks.forEach((t, i) => {
    const f = freq.get(t);
    if (f) f.n += 1;
    else freq.set(t, { n: 1, first: i });
  });
  return [...freq.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .slice(0, k)
    .map(([t]) => t);
}

export function jaccard<T>(a: Set<T> | T[], b: Set<T> | T[]): number {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// FNV-1a 32-bit.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const EMBED_DIM = 384;

// Hashed bag of unigrams, bigrams and character trigrams, signed buckets, L2 normalized.
export function embed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  let toks = tokenize(text);
  if (toks.length === 0) toks = rawTokens(text);
  const add = (feature: string, w: number) => {
    const h = hash(feature);
    v[h % EMBED_DIM] += (h & 0x80000000 ? -1 : 1) * w;
  };
  const counts = new Map<string, number>();
  for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, n] of counts) {
    const w = 1 + Math.log(n);
    add("u:" + t, w);
    const padded = `^${t}$`;
    for (let i = 0; i + 3 <= padded.length; i++) add("c:" + padded.slice(i, i + 3), 0.25 * w);
  }
  for (let i = 0; i + 1 < toks.length; i++) add(`b:${toks[i]}_${toks[i + 1]}`, 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(na * nb)));
}

const TECH = new Set([
  "react", "python", "typescript", "javascript", "node", "docker", "kubernetes", "postgres", "postgresql", "sqlite",
  "duckdb", "redis", "api", "graphql", "rust", "go", "java", "pnpm", "npm", "aws", "gcp", "azure", "linux", "git",
]);

const CLINICAL = new Set([
  "ecog", "karnofsky", "hba1c", "egfr", "alt", "ast", "bilirubin", "creatinine", "anc", "platelet", "hemoglobin", "inr",
  "bmi", "pregnancy", "pregnant", "metformin", "insulin", "chemotherapy", "radiotherapy", "immunotherapy", "metastatic",
  "metastases", "brain", "hepatitis", "hiv", "diabetes", "hypertension", "nsclc", "her2", "brca", "pd-l1", "kras",
  "stage", "biopsy", "contraception", "dialysis", "transplant", "steroid", "steroids", "washout", "consent",
]);

// Entity extraction: trial ids, known technology and clinical terms, acronyms, mid-sentence proper nouns.
export function extractEntities(text: string, cap: number = DEFAULTS.entityCap): Entity[] {
  const out = new Map<string, Entity>();
  const put = (name: string, type: string) => {
    const key = name.toLowerCase();
    if (!out.has(key) && key.length > 1) out.set(key, { name: key, type });
  };
  for (const m of text.matchAll(/\bNCT\d{8}\b/gi)) put(m[0], "trial");
  for (const t of rawTokens(text)) {
    if (TECH.has(t)) put(t, "technology");
    else if (CLINICAL.has(t)) put(t, "clinical");
  }
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9-]{1,7}\b/g)) {
    if (!/^NCT\d{8}$/.test(m[0])) put(m[0], "concept");
  }
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const words = s.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/[^A-Za-z-]/g, "");
      if (/^[A-Z][a-z]{2,}$/.test(w) && !STOPWORDS.has(w.toLowerCase())) put(w, "name");
    }
  }
  return [...out.values()].slice(0, cap);
}

interface DomainRule {
  domain: string;
  namespace: string;
  keywords: string[];
}

const DOMAIN_RULES: DomainRule[] = [
  {
    domain: "clinical",
    namespace: "clinical/eligibility",
    keywords: [
      "patient", "trial", "eligibility", "eligible", "ineligible", "criterion", "criteria", "inclusion", "exclusion",
      "diagnosis", "dose", "lab", "medication", "screening", "enroll", "enrollment", "consent", "oncology", "cancer",
      "tumor", "therapy", "clinical", "protocol", "site", "visit", "nct", ...CLINICAL,
    ],
  },
  {
    domain: "tech",
    namespace: "tech/engineering",
    keywords: ["code", "deploy", "server", "database", "build", "test", "bug", "release", "script", "scripting", ...TECH],
  },
  {
    domain: "work",
    namespace: "work/planning",
    keywords: ["meeting", "deadline", "roadmap", "standup", "quarterly", "office", "team", "manager", "project", "plan", "schedule"],
  },
  {
    domain: "personal",
    namespace: "personal/life",
    keywords: ["family", "birthday", "home", "travel", "hobby", "friend", "parking", "weekend", "vacation"],
  },
  {
    domain: "communication",
    namespace: "communication/style",
    keywords: ["answer", "answers", "bullet", "reply", "tone", "summary", "concise", "verbose", "format", "language"],
  },
];

export function classifyDomain(text: string, tags: string[] = []): { domain: string; namespace: string } {
  for (const tag of tags) {
    const [k, ...rest] = tag.split(":");
    const v = rest.join(":");
    if (k === "domain" && v) return { domain: v.split("/")[0], namespace: v.includes("/") ? v : `${v}/general` };
    if (k === "project" && v) return { domain: "project", namespace: `project/${v}` };
    if (k === "tech" && v) return { domain: "tech", namespace: `tech/${v}` };
  }
  if (tags.some((t) => t.startsWith("criterion:"))) return { domain: "clinical", namespace: "clinical/criteria" };
  if (tags.some((t) => t.startsWith("trial:"))) return { domain: "clinical", namespace: "clinical/trials" };
  if (tags.some((t) => t.startsWith("patient:"))) return { domain: "clinical", namespace: "clinical/patients" };

  const toks = rawTokens(text).map(stem);
  let best: DomainRule | undefined;
  let bestScore = 0;
  for (const rule of DOMAIN_RULES) {
    const kw = new Set(rule.keywords.map(stem));
    let s = 0;
    for (const t of toks) if (kw.has(t)) s += 1;
    if (s > bestScore) {
      best = rule;
      bestScore = s;
    }
  }
  if (!best) return { domain: "general", namespace: "general/uncategorized" };
  return { domain: best.domain, namespace: best.namespace };
}

const CORRECTION_LANGUAGE = /\b(actually|correction|corrected|instead|no longer|not anymore|anymore|update[ds]?:|changed to|should be|replaces?)\b/i;

export function hasCorrectionLanguage(text: string): boolean {
  return CORRECTION_LANGUAGE.test(text);
}

export function preview(text: string, n = 80): string {
  return text.length <= n ? text : text.slice(0, n - 3) + "...";
}
