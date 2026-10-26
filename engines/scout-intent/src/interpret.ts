// Interpret stage: bind parameters and entity references, decide on clarification.
import type { Intent, ParamProp } from "./registry.ts";
import { slug, tokenize } from "./text.ts";

export interface EntityRef {
  kind: string;
  id: string;
  label: string;
  resolved: boolean;
}

export interface ParamError {
  param: string;
  value: unknown;
  rule: string;
}

export interface Binding {
  parameters: Record<string, unknown>;
  references: Record<string, EntityRef>;
  errors: ParamError[];
  missing: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, dozen: 12, couple: 2, single: 1,
};

const UNIT_AFTER = /^\s*(?:-\s*)?(?:days?|weeks?|months?|years?|hours?|minutes?|quarters?|mins?|hrs?|%|percent)\b/i;

const STAGES = [
  "prospecting", "qualification", "qualified", "discovery", "demo", "evaluation", "proposal",
  "negotiation", "commit", "closed-won", "closed-lost", "closed won", "closed lost",
];

const TONES = ["formal", "friendly", "casual", "warm", "concise", "direct", "polite", "urgent", "apologetic", "persuasive"];

const TIME_EXPR = [
  /\b(?:this|next|last|past|coming)\s+(?:week|weekend|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:last|past|next)\s+\d+\s+(?:days|weeks|months|quarters|years)\b/i,
  /\b\d+\s*-?\s*(?:day|week|month|quarter|year)s?\b/i,
  /\bq[1-4](?:\s+(?:fy)?\d{2,4})?\b/i,
  /\bfy\s?\d{2,4}\b/i,
  /\b(?:today|tomorrow|tonight|yesterday)\b/i,
  /\b(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i,
];

const NON_ENTITY = new Set([
  "I", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February",
  "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
]);

interface Entity {
  label: string;
  kind: "person" | "org" | "entity";
  start: number;
}

/** Capitalized names and CamelCase product names, with a rough kind. */
export function extractEntities(text: string): Entity[] {
  const toks = tokenize(text);
  const out: Entity[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const raw = t.raw.replace(/['’]s$/, "");
    if (!t.param || NON_ENTITY.has(raw) || /\d/.test(raw) || !/^\p{Lu}/u.test(raw) && !/\p{Lu}/u.test(raw.slice(1))) continue;
    let label = raw;
    // Join "Acme Corp", "Maya Chen".
    while (i + 1 < toks.length && toks[i + 1].param && /^\p{Lu}/u.test(toks[i + 1].raw) && !NON_ENTITY.has(toks[i + 1].raw)
      && /^\s+$/.test(text.slice(toks[i].end, toks[i + 1].start))) {
      i++;
      label += " " + toks[i].raw.replace(/['’]s$/, "");
    }
    const before = text.slice(Math.max(0, t.start - 12), t.start).toLowerCase();
    const after = text.slice(toks[i].end, toks[i].end + 14).toLowerCase();
    let kind: Entity["kind"] = "entity";
    if (/\b(?:to|email|e-mail|ping|message|call|with|cc|dear|for)\s+$/.test(before) && /^\s+(?:at|from|of)\b|^\s*$|^\s+about\b|^[,.]/.test(after)) kind = "person";
    else if (/\b(?:at|from|of the|the|for)\s+$/.test(before) || /^\s+(?:deal|account|renewal|team|inc|corp|contract|opportunity)\b/.test(after)) kind = "org";
    out.push({ label, kind, start: t.start });
  }
  return out;
}

function money(text: string): { value: number; index: number; end: number }[] {
  const out: { value: number; index: number; end: number }[] = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\b|\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)\s*(?:usd|dollars)?\b/gi;
  for (const m of text.matchAll(re)) {
    const n = parseFloat((m[1] ?? m[3]).replace(/,/g, ""));
    const u = (m[2] ?? m[4] ?? "").toLowerCase();
    const mult = u === "k" || u === "thousand" ? 1e3 : u === "m" || u === "million" ? 1e6 : u === "b" || u === "billion" ? 1e9 : 1;
    out.push({ value: Math.round(n * mult), index: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

function counts(text: string): number[] {
  const out: number[] = [];
  const moneySpans = money(text);
  const re = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozen|couple)\b/gi;
  for (const m of text.matchAll(re)) {
    const i = m.index!;
    if (moneySpans.some((s) => i >= s.index && i < s.end)) continue;
    if (/[qQ]$/.test(text.slice(Math.max(0, i - 1), i)) || /[-.:/]\d*$/.test(text.slice(Math.max(0, i - 1), i))) continue;
    if (UNIT_AFTER.test(text.slice(i + m[0].length))) continue;
    const w = m[1].toLowerCase();
    out.push(/^\d+$/.test(w) ? parseInt(w, 10) : NUMBER_WORDS[w]);
  }
  return out;
}

function timeExpr(text: string): string | undefined {
  let best: { s: string; i: number } | undefined;
  for (const re of TIME_EXPR) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.i)) best = { s: m[0].replace(/^on\s+/i, ""), i: m.index };
  }
  if (!best) return undefined;
  return best.s.replace(/(\d+)\s*-\s*(day|week|month|quarter|year)s?/i, (_, n, u) => `${n} ${u}${n === "1" ? "" : "s"}`);
}

function cleanPhrase(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/^(?:the|a|an|our|my|this|that)\s+/i, "").replace(/[\s,.;:!?]+$/, "").trim();
  return t || undefined;
}

function enumValue(text: string, values: unknown[]): unknown {
  const words = new Set(tokenize(text).map((t) => t.stem));
  const lower = text.toLowerCase();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const s = tokenize(v).map((t) => t.stem);
    if (s.length === 1 ? words.has(s[0]) : lower.includes(v.toLowerCase())) return v;
  }
  return undefined;
}

function typeOf(p: ParamProp): string | undefined {
  return Array.isArray(p.type) ? p.type[0] : p.type;
}

/** Best-effort value for one schema property, chosen by property name and type. */
function bindOne(name: string, p: ParamProp, text: string, ents: Entity[]): unknown {
  const n = name.toLowerCase();
  if (p.enum) return enumValue(text, p.enum);
  const type = typeOf(p);
  if (/^(value|amount|price|budget|arr|acv)(min|max)?$/.test(n) || /(value|amount)(min|max)$/.test(n)) {
    const ms = money(text);
    if (!ms.length) return undefined;
    const dirMin = /\b(?:over|above|more than|greater than|at least|>=?|exceeding|min(?:imum)?)\s*$/i;
    const dirMax = /\b(?:under|below|less than|at most|<=?|max(?:imum)?)\s*$/i;
    for (const m of ms) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (n.endsWith("min") && dirMin.test(before)) return m.value;
      if (n.endsWith("max") && dirMax.test(before)) return m.value;
      if (!n.endsWith("min") && !n.endsWith("max")) return m.value;
    }
    return undefined;
  }
  if (type === "integer" || type === "number" || /^(count|limit|top|n|number|size)$/.test(n)) {
    const c = counts(text)[0];
    if (c !== undefined) return c;
    if (/^(count|limit|n|number)$/.test(n) && /\b(?:[Tt]he|[Tt]his|[Tt]hat)\s+(?:\p{Lu}[\p{L}]*\s+)?(?:deal|account|renewal|opportunity|customer)\b(?!s)/u.test(text)) return 1;
    return undefined;
  }
  if (n === "stage" || n === "status") {
    const lower = text.toLowerCase();
    const hit = STAGES.find((s) => new RegExp(`\\b${s}\\b`).test(lower));
    return hit?.replace(" ", "-");
  }
  if (n === "tone") return TONES.find((t) => new RegExp(`\\b${t}\\b`, "i").test(text));
  if (/^(window|period|when|date|deadline|horizon|timeframe|time|due|range)$/.test(n)) return timeExpr(text);
  if (/^(account|company|org|organization|customer|client)$/.test(n)) {
    return (ents.find((e) => e.kind === "org") ?? ents.find((e) => e.kind === "entity"))?.label;
  }
  if (/^(recipient|contact|person|to|owner|assignee|attendee)$/.test(n)) return ents.find((e) => e.kind === "person")?.label;
  if (type === "array" || /s$/.test(n) && n !== "status") {
    const named = ents.filter((e) => e.kind !== "person").map((e) => e.label);
    return named.length >= 2 ? named : undefined;
  }
  if (n === "topic" || n === "subject") {
    const m = /\babout\s+([^,.;!?]+?)(?:\s+(?:and|then|by|before|for)\b|[,.;!?]|$)/i.exec(text)
      ?? /\b(?:in|on|into|for)\s+(?:the\s+)?([\w\s-]+?\s+(?:space|market|industry|sector|segment|category))\b/i.exec(text);
    if (m) return cleanPhrase(m[1]);
    const ent = ents.find((e) => e.kind !== "person");
    if (ent) return ent.label;
    if (/^\s*(?:what|who|how|why|when|where|which|is|are|do|does|can|could|should|would)\b/i.test(text)) return undefined;
    const obj = /^\s*\w+\s+(?:(?:out|up|down|over|through)\s+)?(?:(?:a|an|the|our|my)\s+)?([^,.;!?]+?)(?:\s+(?:to|for|by|about|from|with|and|of)\b|[,.;!?]|$)/i.exec(text);
    return cleanPhrase(obj?.[1]);
  }
  if (n === "title" || n === "name") {
    const m = /\b(?:schedule|book|create|add|set up|put me|plan|arrange)\s+(?:a|an|the)?\s*([^,.;!?]+?)(?:\s+(?:for|on|at|next|this|with|to)\b|[,.;!?]|$)/i.exec(text);
    return cleanPhrase(m?.[1]);
  }
  if (n === "audience") {
    const m = /\bto\s+((?:all|every|our|the)\s+[\w\s-]+?)(?:[,.;!?]|\s+(?:about|by|on|with)\b|$)/i.exec(text);
    return cleanPhrase(m?.[1]) ?? undefined;
  }
  if (n === "template") {
    const m = /\b(?:the|our|a)\s+([\w\s-]+?\s+(?:announcement|newsletter|template|campaign|update|email))\b/i.exec(text);
    return cleanPhrase(m?.[1]);
  }
  return undefined;
}

export function validateParam(name: string, p: ParamProp, value: unknown): ParamError | undefined {
  const type = typeOf(p);
  if (p.enum && !p.enum.includes(value)) return { param: name, value, rule: "enum" };
  if (type === "integer" && !Number.isInteger(value)) return { param: name, value, rule: "type:integer" };
  if (type === "number" && typeof value !== "number") return { param: name, value, rule: "type:number" };
  if (type === "string" && typeof value !== "string") return { param: name, value, rule: "type:string" };
  if (type === "array" && !Array.isArray(value)) return { param: name, value, rule: "type:array" };
  if (typeof value === "number") {
    if (p.minimum !== undefined && value < p.minimum) return { param: name, value, rule: `minimum:${p.minimum}` };
    if (p.maximum !== undefined && value > p.maximum) return { param: name, value, rule: `maximum:${p.maximum}` };
  }
  return undefined;
}

export interface BindContext {
  entities?: Record<string, string>;
  parameters?: Record<string, unknown>;
}

export function bind(intent: Intent, span: string, ctx: BindContext = {}): Binding {
  const ents = extractEntities(span);
  const parameters: Record<string, unknown> = {};
  const errors: ParamError[] = [];
  const props = intent.parameters?.properties ?? {};
  for (const [name, p] of Object.entries(props)) {
    let v = bindOne(name, p, span, ents);
    if (v === undefined && ctx.parameters && name in ctx.parameters) v = ctx.parameters[name];
    if (v === undefined) continue;
    const err = validateParam(name, p, v);
    if (err) errors.push(err);
    parameters[name] = v;
  }
  const missing = (intent.parameters?.required ?? []).filter((r) => parameters[r] === undefined);
  const references: Record<string, EntityRef> = {};
  const used = new Map<string, number>();
  for (const e of ents) {
    const kind = e.kind === "org" ? "account" : e.kind;
    const n = (used.get(kind) ?? 0) + 1;
    used.set(kind, n);
    const k = n === 1 ? kind : `${kind}${n}`;
    const known = ctx.entities?.[e.label.toLowerCase()] ?? ctx.entities?.[e.label];
    references[k] = { kind, id: known ?? `${kind}:${slug(e.label)}`, label: e.label, resolved: Boolean(known) };
  }
  return { parameters, references, errors, missing };
}

// Anaphora that only make sense with shared history the prompt does not carry.
const VAGUE = [
  /\b(?:the|that|this)\s+(?:[\p{Lu}][\p{L}]*\s+)?(?:thing|stuff|situation|issue|matter|problem|mess)\b/iu,
  /\b(?:we|you|i)\s+(?:talked|spoke|discussed|chatted|agreed)\s+(?:about|on)?\b/i,
  /\bas\s+(?:discussed|mentioned|agreed|planned)\b/i,
  /\bthe\s+usual\b/i,
  /^\s*(?:do|handle|fix|sort out|deal with|take care of)\s+(?:it|that|this|them)\s*[.!?]*\s*$/i,
];

/** Unresolved references: phrases that point at context the request does not include. */
export function vagueReference(text: string, ctx?: { references?: Record<string, unknown>; turns?: string[] }): string | undefined {
  if (ctx?.references && Object.keys(ctx.references).length) return undefined;
  for (const re of VAGUE) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}
