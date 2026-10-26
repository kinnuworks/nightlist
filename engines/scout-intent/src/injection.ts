// Injection check: known patterns, role drift, out-of-band tool references,
// hidden control characters and encoded payloads. Deterministic, no model.

export type InjectionKind =
  | "pattern"
  | "role-drift"
  | "role-marker"
  | "tool-ref"
  | "exfiltration"
  | "privilege"
  | "embedded-control"
  | "encoded"
  | "verdict"
  | "model";

export interface PatternRule {
  id: string;
  kind: InjectionKind;
  re: RegExp;
  weight: number;
  /** A hard rule blocks on its own, whatever the threshold. */
  hard?: boolean;
}

export interface InjectionFinding {
  id: string;
  kind: InjectionKind;
  weight: number;
  hard: boolean;
  evidence: string;
  /** Character range in the original text, when the match maps back to it. */
  span?: [number, number];
}

export interface InjectionResult {
  detected: boolean;
  kind?: InjectionKind;
  score: number;
  evidence: string[];
  findings: InjectionFinding[];
}

export interface ScanOptions {
  /** Tool or capability ids that are legitimately reachable. Others named in a "use X" phrase are flagged. */
  knownTools?: Iterable<string>;
  extraRules?: PatternRule[];
  /** Score at or above which the text counts as an injection. */
  blockAt?: number;
  /** Max characters of matched text kept as evidence. Payloads are never kept in full. */
  evidenceChars?: number;
}

const OVERRIDE_NOUN = "(?:instructions?|prompts?|rules?|directions?|directives?|guidelines?|context|messages?|constraints?|polic(?:y|ies)|guardrails?|commands?|orders?|programming|training)";

export const CORE_RULES: PatternRule[] = [
  // Instruction override.
  { id: "override.ignore-instructions", kind: "pattern", hard: true, weight: 1,
    re: new RegExp(`\\b(?:ignore|disregard|forget|neglect)\\b[\\w\\s,'"-]{0,40}?\\b(?:previous|prior|above|earlier|preceding|foregoing|all|any|the|your|my|these|those|system|original|initial|other)\\b[\\w\\s,'"-]{0,30}?\\b${OVERRIDE_NOUN}\\b`, "i") },
  { id: "override.ignore-previous", kind: "pattern", hard: true, weight: 1,
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|everything\s+)?(?:of\s+)?(?:the\s+|that\s+|what(?:'s|\s+is|\s+was)\s+)?(?:previous(?:ly)?|prior|above|earlier|preceding|before|said)\b/i },
  { id: "override.disregard-party", kind: "pattern", hard: true, weight: 1,
    re: /\b(?:disregard|ignore)\s+(?:the\s+|your\s+|any\s+|all\s+)?(?:user|system|developer|operator|assistant|safety|guardrails?)\b/i },
  { id: "override.override-rules", kind: "pattern", hard: true, weight: 1,
    re: new RegExp(`\\boverride\\s+(?:the\\s+|your\\s+|all\\s+|any\\s+)?(?:system\\s+|safety\\s+|previous\\s+|prior\\s+|original\\s+)?${OVERRIDE_NOUN}`, "i") },
  { id: "override.system-override", kind: "pattern", weight: 0.7,
    re: /\b(?:system|admin(?:istrator)?|developer|security)\s+override\b/i },
  { id: "override.new-instructions", kind: "pattern", weight: 0.8,
    re: /\bnew\s+(?:instructions?|rules?|system\s+prompt|directives?)\s*:/i },

  // Role markers and embedded control.
  { id: "marker.chat-tag", kind: "role-marker", hard: true, weight: 1,
    re: /<\s*\/?\s*(?:system|user|assistant|developer|tool|instructions?|im_start|im_end|sys)\s*>/i },
  { id: "marker.inst", kind: "role-marker", hard: true, weight: 1, re: /\[\s*\/?\s*(?:inst|sys|system)\s*\]/i },
  { id: "marker.sys-block", kind: "role-marker", hard: true, weight: 1, re: /<<\s*\/?\s*sys\s*>>/i },
  { id: "marker.special-token", kind: "role-marker", hard: true, weight: 1, re: /<\|[a-z_]{2,30}\|>/i },
  { id: "marker.role-line", kind: "role-marker", weight: 0.7,
    re: /(?:^|\n)\s*#{0,3}\s*(?:system|assistant|developer)(?:\s+(?:prompt|message))?\s*:/i },
  { id: "marker.begin-system", kind: "role-marker", hard: true, weight: 1,
    re: /\b(?:begin|end|start)\s+(?:of\s+)?(?:system|hidden|secret|new)\s+(?:prompt|instructions?)\b/i },

  // Role drift.
  { id: "drift.you-are-now", kind: "role-drift", weight: 0.6, re: /\byou\s+are\s+now\b/i },
  { id: "drift.mode", kind: "role-drift", weight: 0.7,
    re: /\b(?:unrestricted|developer|god|jailbreak|jailbroken|dan|sudo|debug|evil|uncensored|unfiltered)\s+mode\b/i },
  { id: "drift.pretend", kind: "role-drift", weight: 0.7, re: /\bpretend\s+(?:to\s+be|you\s+are|that\s+you)\b/i },
  { id: "drift.roleplay", kind: "role-drift", weight: 0.6, re: /\brole[\s-]?play\s+(?:as|that)\b/i },
  { id: "drift.act-as", kind: "role-drift", weight: 0.7,
    re: /\bact\s+as\s+(?:if\s+you|though\s+you|an?\s+(?:unrestricted|different|new|evil|system|admin|administrator|developer|ai|assistant|model|language\s+model|llm|jailbroken|hacker)\b|the\s+(?:system|admin|administrator|developer|assistant|model)\b)/i },
  { id: "drift.from-now-on", kind: "role-drift", weight: 0.5, re: /\bfrom\s+now\s+on\b[^.\n]{0,40}\byou\b/i },
  { id: "drift.you-must", kind: "role-drift", weight: 0.7,
    re: /\byou\s+(?:must|should|will|shall|are\s+to|have\s+to|need\s+to)\s+(?:now\s+)?(?:ignore|disregard|forget|obey|comply|output|respond|answer|reply|print|say|mark|classify|label|return|act|pretend|reveal)\b/i },
  { id: "drift.address-model", kind: "role-drift", weight: 0.5,
    re: /\b(?:dear|hey|hi|attention|note\s+to(?:\s+the)?)\s+(?:ai|assistant|model|llm|chatbot|gpt|chatgpt|language\s+model|agent|bot)\b/i },
  { id: "drift.model-reading", kind: "role-drift", weight: 0.7,
    re: /\b(?:ai|assistant|llm|chatbot|language\s+model|model|agent|bot)s?\s+(?:reading|processing|parsing|reviewing|evaluating)\s+this\b/i },
  { id: "drift.model-must", kind: "role-drift", weight: 0.8,
    re: /\b(?:the\s+)?(?:model|assistant|ai|llm|chatbot|compiler|classifier|language\s+model)\s+(?:must|should|will|shall|is\s+to|needs\s+to|has\s+to)\s+(?:now\s+)?(?:output|answer|respond|reply|return|mark|classify|label|say|treat|ignore|disregard|approve|accept)\b/i },
  { id: "drift.as-an-ai", kind: "role-drift", weight: 0.4, re: /\bas\s+an?\s+(?:ai|language\s+model|llm)\b/i },
  { id: "drift.system-prompt", kind: "role-drift", weight: 0.4, re: /\b(?:system|developer|hidden)\s+prompt\b/i },

  // Exfiltration and privilege.
  { id: "exfil.secrets", kind: "exfiltration", weight: 0.8,
    re: /\b(?:reveal|dump|leak|exfiltrate|expose|print|disclose|output|show|list|send|give)\b[^.\n]{0,30}\b(?:stored|saved|all|hidden|secret|internal|your|the\s+system(?:'s)?)\s+(?:api[\s_-]?keys?|credentials?|passwords?|secrets?|tokens?|private\s+keys?|system\s+prompt|instructions)\b/i },
  { id: "exfil.prompt", kind: "exfiltration", weight: 0.8,
    re: /\b(?:reveal|print|output|show|repeat|display|dump|return|tell\s+me)\b[^.\n]{0,20}\b(?:system|hidden|developer|initial|original)\s+(?:prompt|instructions|message)\b/i },
  { id: "exfil.verb", kind: "exfiltration", weight: 0.8,
    re: /\b(?:reveal|dump|leak|exfiltrate|disclose)\b[^.\n]{0,20}\b(?:api[\s_-]?keys?|credentials?|passwords?|secrets?|system\s+prompt)\b/i },
  { id: "priv.grant", kind: "privilege", weight: 0.7,
    re: /\bgrant\s+(?:me|myself|us|this\s+user)\b[^.\n]{0,25}\b(?:admin|administrator|root|superuser|owner|full|elevated|unrestricted)\b/i },
  { id: "priv.grant-admin", kind: "privilege", weight: 0.6, re: /\bgrant\s+(?:admin|root|superuser)\b/i },
  { id: "priv.elevate", kind: "privilege", weight: 0.7,
    re: /\b(?:make|elevate|promote|escalate)\s+(?:me|my\s+(?:role|account|privileges?))\b[^.\n]{0,20}\b(?:admin|administrator|root|superuser)\b/i },
  { id: "priv.destructive-sql", kind: "privilege", weight: 0.7,
    re: /\b(?:drop|truncate)\s+(?:the\s+)?(?:[a-z_]+\s+)?table\b|\bdelete\s+from\s+[a-z_]+|\brm\s+-rf\b/i },
  { id: "priv.disable-safety", kind: "privilege", weight: 0.7,
    re: /\b(?:disable|turn\s+off|bypass|circumvent|deactivate)\s+(?:the\s+|all\s+|any\s+|your\s+)?(?:safety|security|guard(?:rail)?s?|filters?|moderation|content\s+polic(?:y|ies)|restrictions?)\b/i },

  // Tool and URL calls.
  { id: "tool.markup", kind: "tool-ref", hard: true, weight: 1,
    re: /<\s*\/?\s*(?:tool_call|tool_use|function_calls?|invoke|parameter)\b[^>]*>/i },
  { id: "tool.call-syntax", kind: "tool-ref", weight: 0.8, re: /\b(?:functions|tools)\.[a-z_]{3,}\s*\(/i },
  { id: "tool.json-call", kind: "tool-ref", weight: 0.7, re: /"(?:tool|tool_name|function|function_call|arguments)"\s*:/i },
  { id: "tool.call-verb", kind: "tool-ref", weight: 0.6,
    re: /\b(?:call|invoke|use|run|execute|trigger|launch)\s+(?:the\s+|a\s+|this\s+)?(?:tool|function|plugin|endpoint|webhook|shell|script|command)\b/i },
  { id: "tool.url-action", kind: "tool-ref", weight: 0.8,
    re: /\b(?:fetch|visit|open|navigate\s+to|browse(?:\s+to)?|download|curl|wget|post\s+(?:it\s+|this\s+|data\s+)?to|upload\s+(?:it\s+|this\s+)?to|send\s+(?:it|this|that|data|everything|the\s+\w+)\s+to|go\s+to|load|request)\s+(?:the\s+)?(?:url\s+|link\s+|page\s+)?(?:https?:\/\/|www\.)\S+/i },
  { id: "tool.markdown-image", kind: "tool-ref", weight: 0.7, re: /!\[[^\]]*\]\(\s*(?:https?:)?\/\/[^)]*\)/i },
  { id: "tool.url", kind: "tool-ref", weight: 0.25, re: /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*/i },

  // Markdown or banner disguise.
  { id: "disguise.header", kind: "pattern", weight: 0.35,
    re: /(?:^|\n)\s*#{1,6}\s*(?:important|attention|urgent|system|instructions?|admin|override|note\s+to)\b/i },
  { id: "disguise.banner", kind: "pattern", weight: 0.4,
    re: /\b(?:important|attention|urgent)\s*[:!]+\s*(?:you|the\s+(?:ai|assistant|model|system))\b/i },
];

// Hidden direction, zero-width and tag characters.
const HIDDEN = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LITERAL_HIDDEN = /\\u(?:202[a-e]|200[b-f]|206[0-9]|feff)|&#x?(?:202e|8238|200b|8203|feff|65279);/i;

const HOMOGLYPHS: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s",
  "\u0410": "A", "\u0415": "E", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0425": "X", "\u0406": "I", "\u03BF": "o", "\u03B9": "i", "\u03B1": "a",
};

function deHomoglyph(s: string): string {
  return s.replace(/[\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0456\u0458\u0455\u0410\u0415\u041E\u0420\u0421\u0425\u0406\u03BF\u03B9\u03B1]/g, (c) => HOMOGLYPHS[c] ?? c);
}

function decodeEscapes(s: string): string {
  return s
    .replace(/\\u\{?([0-9a-f]{4,5})\}?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e as "lt"])
    .replace(/(?:%[0-9a-f]{2}){2,}/gi, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

// "i g n o r e  a l l" -> "ignore all"
function collapseSpacedLetters(s: string): string {
  return s.replace(/\b(?:[a-z][ ._]){3,}[a-z]\b/gi, (m) => m.replace(/(?<=\w)[ ._](?=\w)/g, "").replace(/\s+/g, ""));
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };

function unleet(s: string): string {
  return s.replace(/[a-z]*[013457@$][a-z013457@$]*/gi, (w) => (/[a-z]/i.test(w) ? w.replace(/[013457@$]/g, (c) => LEET[c]) : w));
}

function printableRatio(s: string): number {
  if (!s.length) return 0;
  let ok = 0;
  for (const ch of s) if (/[\x20-\x7E\n\r\t]/.test(ch)) ok++;
  return ok / s.length;
}

/** Decoded views of base64, hex and percent-encoded runs that decode to readable text. */
export function decodePayloads(text: string): { kind: string; decoded: string; raw: string }[] {
  const out: { kind: string; decoded: string; raw: string }[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    const raw = m[0];
    if (/^[ACGTUN]+$/i.test(raw) || !/[a-z]/.test(raw) || !/[A-Z0-9]/.test(raw)) continue;
    try {
      const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (decoded.length >= 12 && printableRatio(decoded) > 0.9 && /[a-z]{3,}\s+[a-z]{2,}/i.test(decoded)) out.push({ kind: "base64", decoded, raw });
    } catch {
      // not base64
    }
  }
  for (const m of text.matchAll(/\b(?:[0-9a-f]{2}[\s:]?){12,}\b/gi)) {
    const hex = m[0].replace(/[\s:]/g, "");
    const decoded = Buffer.from(hex, "hex").toString("utf8");
    if (printableRatio(decoded) > 0.9 && /[a-z]{3,}\s+[a-z]{2,}/i.test(decoded)) out.push({ kind: "hex", decoded, raw: m[0] });
  }
  for (const m of text.matchAll(/(?:%[0-9a-f]{2}[^%\s]{0,3}){5,}/gi)) {
    try {
      const decoded = decodeURIComponent(m[0]);
      if (decoded !== m[0]) out.push({ kind: "percent", decoded, raw: m[0] });
    } catch {
      // malformed
    }
  }
  return out;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "..." : t;
}

function combine(findings: InjectionFinding[]): number {
  const best = new Map<string, number>();
  for (const f of findings) best.set(f.id, Math.max(best.get(f.id) ?? 0, f.weight));
  let keep = 1;
  for (const w of best.values()) keep *= 1 - Math.min(1, w);
  return Math.round((1 - keep) * 1000) / 1000;
}

const TOOL_IDENT = /\b(?:use|call|invoke|run|execute|trigger|open|access|via|through|using)\s+(?:the\s+)?([a-z][a-z0-9]*(?:[_.][a-z0-9]+)+)\b/gi;

export function scanInjection(text: string, opts: ScanOptions = {}, depth = 0): InjectionResult {
  const evidenceChars = opts.evidenceChars ?? 48;
  const findings: InjectionFinding[] = [];
  const rules = [...CORE_RULES, ...(opts.extraRules ?? [])];

  const hidden = text.match(HIDDEN)?.length ?? 0;
  const c0 = text.match(C0)?.length ?? 0;
  if (hidden || c0 || LITERAL_HIDDEN.test(text)) {
    findings.push({ id: "control.hidden-chars", kind: "embedded-control", weight: 0.45, hard: false,
      evidence: `${hidden + c0 || "escaped"} hidden or direction control character(s)` });
  }

  // Several normalized views. Matches are reported once per rule.
  const base = text.replace(HIDDEN, "").replace(C0, " ");
  const views = new Set<string>([base]);
  const decoded = decodeEscapes(base).replace(HIDDEN, "");
  views.add(decoded);
  // Tag characters can smuggle ASCII text that renders as nothing.
  const smuggled = [...text.matchAll(TAGS)].map((m) => String.fromCharCode(m[0].codePointAt(0)! - 0xE0000)).join("");
  if (smuggled.trim()) views.add(smuggled);
  const nfkc = deHomoglyph(decoded.normalize("NFKC"));
  views.add(nfkc);
  views.add(collapseSpacedLetters(nfkc));
  // Run-on text: treat a capitalized word after a space as a new sentence.
  views.add(nfkc.replace(/([^\s.!?;:])\s+(?=[A-Z][a-z]+\s)/g, "$1. "));
  views.add(unleet(nfkc));

  const hit = new Set<string>();
  for (const view of views) {
    for (const r of rules) {
      if (hit.has(r.id)) continue;
      const m = r.re.exec(view);
      if (!m) continue;
      hit.add(r.id);
      const span: [number, number] | undefined = view === base || view === text ? [m.index, m.index + m[0].length] : undefined;
      findings.push({ id: r.id, kind: r.kind, weight: r.weight, hard: Boolean(r.hard), evidence: clip(m[0], evidenceChars), span });
    }
  }

  // Out-of-band tool references: a named tool the current plan cannot reach.
  if (opts.knownTools) {
    const known = new Set([...opts.knownTools].map((t) => t.toLowerCase()));
    for (const m of nfkc.matchAll(TOOL_IDENT)) {
      const ident = m[1].toLowerCase();
      const parts = ident.split(/[_.]/);
      if (ident.length < 6 || !parts.some((p) => p.length >= 3) || known.has(ident)) continue;
      if (/^(?:e\.g|i\.e|etc|vs)\b/.test(ident) || /^v?\d/.test(ident)) continue;
      findings.push({ id: "tool.out-of-band", kind: "tool-ref", weight: 0.6, hard: false, evidence: `unknown tool "${clip(ident, 32)}"` });
      break;
    }
  }

  // Encoded payloads: scan decoded text once.
  if (depth < 1) {
    for (const p of decodePayloads(decoded)) {
      const inner = scanInjection(p.decoded, { ...opts, knownTools: undefined }, depth + 1);
      if (inner.findings.some((f) => f.weight >= 0.6)) {
        findings.push({ id: `encoded.${p.kind}`, kind: "encoded", weight: 1, hard: true,
          evidence: `${p.kind} payload decodes to: ${inner.findings.map((f) => f.id).join(", ")}` });
      } else if (p.kind !== "percent") {
        findings.push({ id: `encoded.${p.kind}-blob`, kind: "encoded", weight: 0.3, hard: false, evidence: `opaque ${p.kind} text (${p.raw.length} chars)` });
      }
    }
  }

  const score = combine(findings);
  const blockAt = opts.blockAt ?? 0.7;
  const detected = findings.some((f) => f.hard) || score >= blockAt;
  const top = [...findings].sort((a, b) => b.weight - a.weight)[0];
  return { detected, kind: top?.kind, score, evidence: findings.map((f) => `${f.id}: ${f.evidence}`), findings };
}
