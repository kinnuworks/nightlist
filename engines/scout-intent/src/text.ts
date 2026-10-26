// Tokenizing and light stemming shared by scoring and interpretation.

export interface Token {
  raw: string;
  stem: string;
  start: number;
  end: number;
  /** Looks like a parameter value (a name, date or time word) rather than an intent signal. */
  param?: boolean;
}

export const TIME_WORDS = new Set([
  "today", "tomorrow", "yesterday", "tonight", "week", "weekend", "month", "quarter", "year", "day",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
]);

export const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "for", "in", "on", "at", "by", "with", "about",
  "me", "my", "i", "we", "our", "us", "you", "your", "it", "its", "this", "that", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had", "do", "does", "did",
  "what", "whats", "which", "who", "whom", "how", "should", "can", "could", "would", "will", "shall",
  "please", "all", "any", "some", "from", "into", "up", "out", "over", "then", "also", "just", "there",
  "here", "so", "if", "as", "than", "too", "very", "not", "no", "yes", "get", "got", "let", "lets",
  "im", "ive", "id", "youre", "theyre", "them", "they", "their", "he", "she", "him", "her", "his",
  "hers", "each", "every", "both", "own", "same", "other", "such", "only", "again", "once", "more",
  "most", "much", "many", "now", "out", "off", "via", "per", "within", "across",
]);

// Small lemma table applied before suffix stripping. Domain words whose
// derived forms the suffix rules would not join.
export const LEMMAS: Record<string, string> = {
  recovery: "recover", recoveries: "recover",
  compose: "draft", book: "schedule", reschedule: "schedule", investigate: "research", contrast: "compare",
  digest: "summarize", tldr: "summarize",
  summary: "summarize", summaries: "summarize", summarise: "summarize", summarization: "summarize", recap: "summarize",
  comparison: "compare", comparisons: "compare", versus: "compare", vs: "compare",
  "e-mail": "email", emails: "email", mail: "email", mails: "email",
  sent: "send", wrote: "write", written: "write",
  meetings: "meeting", calendars: "calendar",
  competitors: "competitor", competition: "competitor", competitive: "competitor",
  analyses: "analysis",
};

export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, "").replace(/['’]/g, "");
  if (LEMMAS[w]) w = LEMMAS[w];
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/[^su]s$/.test(w) && !/(is|us|ss)$/.test(w)) w = w.slice(0, -1);
  if (w.length >= 6 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length >= 5 && w.endsWith("ed") && !w.endsWith("eed")) w = w.slice(0, -2);
  if (/([^aeiouls])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

export function isNumeric(raw: string): boolean {
  return /^\d+(?:[.,]\d+)?[kmb]?$/i.test(raw);
}

/** All word tokens with offsets. Stopwords are kept; callers filter with `contentTokens`. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let sentenceStart = true;
  let prevEnd = 0;
  for (const m of text.matchAll(WORD)) {
    const raw = m[0];
    const start = m.index!;
    if (/[.!?:\n]/.test(text.slice(prevEnd, start))) sentenceStart = true;
    const lower = raw.toLowerCase().replace(/['’]s$/, "");
    const named = !sentenceStart && /^\p{Lu}/u.test(raw) && !/^\p{Lu}+$/u.test(raw.replace(/['’]s$/, "")) ;
    const camel = /^\p{L}+\p{Lu}\p{L}*$/u.test(raw) && /\p{Ll}/u.test(raw);
    const param = named || camel || TIME_WORDS.has(lower) || /^q[1-4]$|^fy\d+$|\d/.test(lower);
    out.push({ raw, stem: stem(raw), start, end: start + raw.length, param });
    sentenceStart = false;
    prevEnd = start + raw.length;
  }
  return out;
}

export function isStopword(raw: string): boolean {
  return STOPWORDS.has(raw.toLowerCase().replace(/['’]/g, ""));
}

/** Tokens that carry meaning for intent scoring. */
export function contentTokens(text: string): Token[] {
  return tokenize(text).filter((t) => !isStopword(t.raw) && !isNumeric(t.raw) && t.stem.length > 0);
}

export function contentStems(text: string): string[] {
  return [...new Set(contentTokens(text).map((t) => t.stem))];
}

// Invisible and direction-changing characters that have no place in a prompt.
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

export function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
