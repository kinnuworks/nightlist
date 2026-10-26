// Sense stage. Stage 1 is a deterministic weighted trigger scan; Stage 2 is an
// optional rescoring hook. Scores merge with the canonical weights.
import { performance } from "node:perf_hooks";
import type { Intent } from "./registry.ts";
import { contentTokens, stem, type Token } from "./text.ts";

export type Band = "high" | "medium" | "low" | "reject";

export interface Bands {
  high: number;
  medium: number;
  low: number;
}

export const DEFAULT_BANDS: Bands = { high: 0.8, medium: 0.55, low: 0.4 };

export interface Weights {
  lexical: number;
  semantic: number;
  contextual: number;
  recency: number;
}

export const DEFAULT_WEIGHTS: Weights = { lexical: 0.4, semantic: 0.35, contextual: 0.2, recency: 0.05 };

export function bandOf(score: number, b: Bands = DEFAULT_BANDS): Band {
  if (score >= b.high) return "high";
  if (score >= b.medium) return "medium";
  if (score >= b.low) return "low";
  return "reject";
}

export interface Segment {
  text: string;
  start: number;
  end: number;
  tokens: Token[];
}

export interface SegmentScore {
  intent: string;
  score: number;
  coverage: number;
  similarity: number;
}

const PARAM_WEIGHT = 0.5;

interface IndexedIntent {
  intent: Intent;
  named: Set<string>;
  credit: Map<string, number>;
  examples: { vec: Map<string, number>; norm: number }[];
}

// Clause boundaries for multi-intent spans.
const SPLIT = /\s*(?:[,;]|\band\s+then\b|\band\s+also\b|\band\b|\bthen\b|\bplus\b|&)\s*/gi;

export function segment(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  const push = (s: number, e: number) => {
    const raw = text.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) return;
    const start = s + lead;
    const toks = contentTokens(t).map((k) => ({ ...k, start: k.start + start, end: k.end + start }));
    if (toks.length) out.push({ text: t, start, end: start + t.length, tokens: toks });
  };
  for (const m of text.matchAll(SPLIT)) {
    push(last, m.index!);
    last = m.index! + m[0].length;
  }
  push(last, text.length);
  return out;
}

export class LexicalScorer {
  private readonly index: IndexedIntent[];
  private readonly df = new Map<string, number>();
  private readonly n: number;

  constructor(intents: readonly Intent[]) {
    this.index = intents.map((intent) => {
      const credit = new Map<string, number>();
      const give = (s: string, c: number) => credit.set(s, Math.max(credit.get(s) ?? 0, c));
      for (const t of contentTokens(intent.description)) give(t.stem, 0.5);
      for (const part of intent.id.split(/[._-]/)) if (part.length > 1) give(stem(part), 1);
      if (intent.category) give(stem(intent.category), 1);
      for (const ex of intent.examples) for (const t of contentTokens(ex)) give(t.stem, 1);
      for (const [phrase, w] of Object.entries(intent.triggers ?? {})) {
        for (const t of contentTokens(phrase)) give(t.stem, Math.max(0, Math.min(1, w)));
      }
      const named = new Set(intent.id.split(/[._-]/).filter((p) => p.length > 1).map(stem));
      return { intent, named, credit, examples: [] as { vec: Map<string, number>; norm: number }[] };
    });
    this.n = this.index.length;
    for (const ix of this.index) for (const s of ix.credit.keys()) this.df.set(s, (this.df.get(s) ?? 0) + 1);
    for (const ix of this.index) {
      ix.examples = ix.intent.examples.map((ex) => {
        const vec = new Map<string, number>();
        for (const t of contentTokens(ex)) vec.set(t.stem, Math.max(vec.get(t.stem) ?? 0, this.weight(t)));
        return { vec, norm: Math.sqrt([...vec.values()].reduce((a, w) => a + w * w, 0)) };
      });
    }
  }

  /** Inverse intent frequency. Words no intent knows weigh like a rare word. */
  idf(s: string): number {
    const df = this.df.get(s) ?? 0;
    return Math.log(1 + this.n / (df || 2));
  }

  /** Weight of a token in a span. Names, dates and numbers are parameters, not intent signals. */
  weight(t: Token): number {
    const w = this.idf(t.stem);
    return t.param ? Math.min(w, PARAM_WEIGHT) : w;
  }

  get size(): number {
    return this.n;
  }

  /**
   * Lexical score per intent for one span: 0.6 * weighted coverage + 0.4 * best
   * example cosine. Words that name the intent (its id parts) count double for it.
   */
  score(tokens: Token[]): SegmentScore[] {
    const seen = new Map<string, number>();
    for (const t of tokens) seen.set(t.stem, Math.max(seen.get(t.stem) ?? 0, this.weight(t)));
    const stems = [...seen.keys()];
    const w = [...seen.values()];
    const total = w.reduce((a, b) => a + b, 0);
    const norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
    const out: SegmentScore[] = [];
    for (const ix of this.index) {
      if (!total) {
        out.push({ intent: ix.intent.id, score: 0, coverage: 0, similarity: 0 });
        continue;
      }
      let covered = 0;
      let mass = 0;
      for (let i = 0; i < stems.length; i++) {
        const wi = ix.named.has(stems[i]) ? 2 * w[i] : w[i];
        covered += wi * (ix.credit.get(stems[i]) ?? 0);
        mass += wi;
      }
      const coverage = covered / mass;
      let similarity = 0;
      for (const ex of ix.examples) {
        if (!ex.norm) continue;
        let dot = 0;
        for (let i = 0; i < stems.length; i++) dot += w[i] * (ex.vec.get(stems[i]) ?? 0);
        similarity = Math.max(similarity, dot / (norm * ex.norm));
      }
      const score = Math.min(1, 0.6 * coverage + 0.4 * similarity);
      out.push({ intent: ix.intent.id, score, coverage, similarity });
    }
    return out;
  }
}

export interface SpanScore {
  intent: string;
  score: number;
  span: string;
  start: number;
  end: number;
  whole: number;
}

export interface Stage1Result {
  whole: Map<string, number>;
  best: Map<string, SpanScore>;
  segments: { seg: Segment; top: SegmentScore }[];
  latencyMs: number;
}

/** Full-registry scan over the whole prompt and each clause. */
export function stage1(scorer: LexicalScorer, prompt: string): Stage1Result {
  const t0 = performance.now();
  const wholeTokens = contentTokens(prompt);
  const whole = new Map<string, number>();
  const best = new Map<string, SpanScore>();
  const trimmed = prompt.trim();
  const lead = prompt.length - prompt.trimStart().length;
  for (const s of scorer.score(wholeTokens)) {
    whole.set(s.intent, s.score);
    best.set(s.intent, { intent: s.intent, score: s.score, span: trimmed, start: lead, end: lead + trimmed.length, whole: s.score });
  }
  const segs = segment(prompt);
  const segments: { seg: Segment; top: SegmentScore }[] = [];
  if (segs.length > 1) {
    for (const seg of segs) {
      const scores = scorer.score(seg.tokens);
      let top = scores[0];
      for (const s of scores) {
        if (s.score > top.score) top = s;
        const cur = best.get(s.intent)!;
        if (s.score > cur.score + 1e-9) best.set(s.intent, { ...cur, score: s.score, span: seg.text, start: seg.start, end: seg.end });
      }
      segments.push({ seg, top });
    }
  }
  return { whole, best, segments, latencyMs: performance.now() - t0 };
}

export interface Stage2 {
  /** Semantic similarity per intent id in [0, 1]. Optional; off by default. */
  semantic?: (prompt: string, intents: readonly Intent[]) => Record<string, number> | Promise<Record<string, number>>;
}

export interface MergeInput {
  lexical: Map<string, number>;
  semantic?: Record<string, number>;
  contextual?: Record<string, number>;
  recency?: Record<string, number>;
  riskPenalty?: Record<string, number>;
  weights?: Weights;
}

/**
 * Canonical merge. Terms that were not computed do not count against the score:
 * the dot product is renormalized over lexical, semantic and contextual terms that
 * ran, and recency adds its weight as a bonus. With Stage 1 only, the result is the
 * lexical score.
 */
export function merge(m: MergeInput): Map<string, number> {
  const w = m.weights ?? DEFAULT_WEIGHTS;
  const out = new Map<string, number>();
  const denom = w.lexical + (m.semantic ? w.semantic : 0) + (m.contextual ? w.contextual : 0);
  for (const [id, lex] of m.lexical) {
    let s = w.lexical * lex;
    if (m.semantic) s += w.semantic * clamp01(m.semantic[id] ?? 0);
    if (m.contextual) s += w.contextual * clamp01(m.contextual[id] ?? 0);
    s = s / denom;
    if (m.recency) s += w.recency * clamp01(m.recency[id] ?? 0);
    s -= m.riskPenalty?.[id] ?? 0;
    out.set(id, round(clamp01(s)));
  }
  return out;
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

export function round(x: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

// Fixed probe set for the startup latency self-test.
export const PROBES = [
  "Find me the top 5 stuck deals and draft recovery emails",
  "Pull the Q2 numbers and draft a board email",
  "Summarize the Acme account and schedule a check-in for next Tuesday",
  "Compare three vendors, list pros and cons, then plan the rollout over six months",
  "hello there",
  "deal email plan research summarize schedule ".repeat(60),
];

export const SCAN_BUDGET_MS = 16;

/** Throws when a full-registry scan of any probe exceeds the budget. */
export function selfTest(scorer: LexicalScorer, budgetMs = SCAN_BUDGET_MS, probes: string[] = PROBES): number {
  for (const p of probes) stage1(scorer, p); // warm up
  let worst = 0;
  for (const p of probes) {
    const t0 = performance.now();
    stage1(scorer, p);
    worst = Math.max(worst, performance.now() - t0);
  }
  if (worst > budgetMs) {
    throw new Error(`scout self-test failed: stage-1 scan took ${worst.toFixed(2)} ms (budget ${budgetMs} ms) over ${scorer.size} intents`);
  }
  return worst;
}
