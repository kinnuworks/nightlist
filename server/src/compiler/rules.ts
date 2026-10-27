// Deterministic compiler for the criteria that recur across lung cancer trials.
// It only compiles a clause when every part of the clause is understood; anything it
// is unsure about is left for the model compiler or for a human read.
import type { Criterion, Leaf, Pred } from "../dsl.ts";

type Result = { pred: Pred; caveats: string[] } | null;

const SCREENING = /\b(consent|willing|able to (comply|swallow|understand)|comply with|contracept|pregnan|breast[- ]?feed|lactat|child[- ]?bearing|sperm|abstinen|life expectancy|signed|legally authori[sz]ed|agree to|archival|tumou?r tissue|tissue sample|biopsy specimen|provide (a )?(fresh|tumou?r)|vaccin|washout|investigational (agent|product|drug)|clinical trial|study (drug|treatment|intervention)|first dose|enrol|randomi[sz]ation)\b/i;

const num = (s: string) => Number(s.replace(/,/g, ""));
const CMP = String.raw`(≥|>=|=>|≤|<=|=<|>|<|at least|greater than or equal to|less than or equal to|no (?:more|greater) than|more than|less than|above|below|of at least|of)`;
function op(sym: string): ">=" | "<=" | ">" | "<" {
  const s = sym.toLowerCase();
  if (["≥", ">=", "=>", "at least", "greater than or equal to", "of at least", "of"].includes(s)) return ">=";
  if (["≤", "<=", "=<", "less than or equal to", "no more than", "no greater than"].includes(s)) return "<=";
  if (["more than", "above", ">"].includes(s)) return ">";
  return "<";
}

function ecog(t: string): Result {
  if (!/\b(ecog|eastern cooperative|performance status|\bPS\b)/i.test(t) || /karnofsky|lansky/i.test(t) && !/ecog/i.test(t)) return null;
  const range = t.match(/\b([0-4])\s*(?:-|–|to)\s*([0-4])\b/);
  const le = t.match(/(?:≤|<=|=<|less than or equal to|of|score of)\s*([0-4])\b/i);
  const lt = t.match(/(?<![=<])<(?!=)\s*([1-4])\b/);
  const list = t.match(/\b(0|1)(?:\s*,\s*[0-4])*\s*,?\s*(?:or|and)\s*([0-4])\b/);
  let max: number | undefined;
  if (range) max = Number(range[2]);
  else if (list) max = Number(list[2]);
  else if (le) max = Number(le[1]);
  else if (lt) max = Number(lt[1]) - 1;
  if (max === undefined) return null;
  return { pred: { k: "ecog", max }, caveats: [] };
}

function age(t: string): Result {
  if (!/\b(age|aged|years old|years of age)\b/i.test(t) || /life expectancy/i.test(t)) return null;
  const m = t.match(new RegExp(`${CMP}\\s*(\\d{2})\\s*years`, "i")) ?? t.match(/(\d{2})\s*years (?:of age )?or older/i);
  if (!m) return null;
  const value = Number(m[2] ?? m[1]);
  const o = m[2] ? op(m[1]) : ">=";
  if (o === ">=" || o === ">") return { pred: { k: "age", min: o === ">" ? value + 1 : value }, caveats: [] };
  return { pred: { k: "age", max: o === "<" ? value - 1 : value }, caveats: [] };
}

function diagnosis(t: string, kind: string): Result {
  if (kind !== "inclusion") return null;
  // A diagnosis sentence that also names a driver gene is a biomarker criterion; reading
  // only its stage would drop the part that matters.
  if (genesIn(t).length || /\b(egfr|alk|ros-?1|kras|braf|MET|ret|her2|erbb2|ntrk)\b/.test(t) || /actionable|driver (mutation|alteration)|genomic alteration/i.test(t)) return null;
  if (!/(non[- ]?small[- ]?cell|nsclc|lung (adeno|squamous|cancer))/i.test(t)) return null;
  if (!/(histolog|cytolog|diagnos|confirmed|documented|pathologic)/i.test(t)) return null;
  if (/(prior|previous|line of therapy|lines of therapy|adjuvant|treatment for)/i.test(t)) return null;
  if (/(including but not limited|solid tumou?r|breast|colorectal|prostate|ovarian|melanoma|pancrea|gastric|urothelial|head and neck|any of the following tumou?r)/i.test(t)) return null;
  const parts: Pred[] = [];
  if (/squamous (or|and|and\/or) non[- ]?squamous|non[- ]?squamous (or|and|and\/or) squamous|any histolog/i.test(t)) { /* any NSCLC histology */ }
  else if (/non[- ]?squamous|nonsquamous/i.test(t)) parts.push({ k: "histology", anyOf: ["adenocarcinoma", "large_cell", "nos"] });
  else if (/squamous/i.test(t) && !/adeno/i.test(t)) parts.push({ k: "histology", anyOf: ["squamous"] });
  else if (/adenocarcinoma/i.test(t) && !/squamous/i.test(t)) parts.push({ k: "histology", anyOf: ["adenocarcinoma"] });
  const iv = /(stage\s*iv|metastatic|stage\s*4|\bM1|\badvanced\b)/i.test(t);
  const iii = /(stage\s*iii|locally advanced|unresectable|\badvanced\b(?! or metastatic disease is excluded)|not (eligible|a candidate|amenable) for (curative|definitive)|stage\s*3)/i.test(t);
  const early = /(stage\s*(i|ia|ib|ii|iia|iib)\b|resectable|early[- ]stage|resected|resection|surgery|surgical)/i.test(t) && !/unresectable/i.test(t);
  if (early && !iii && !iv) return null; // early-stage and perioperative eligibility needs surgical detail
  if (iv && iii) parts.push({ k: "stage", anyOf: ["III", "IV"] });
  else if (iv) parts.push({ k: "stage", anyOf: ["IV"] });
  else if (iii) parts.push({ k: "stage", anyOf: ["III"] });
  if (!parts.length) parts.push({ k: "histology", anyOf: ["adenocarcinoma", "squamous", "large_cell", "nos"] });
  const caveats = /recurrent|relapsed|progress/i.test(t) ? ["disease progression history is not checked"] : [];
  return { pred: parts.length === 1 ? parts[0] : { k: "and", all: parts }, caveats };
}

function genesIn(t: string): { gene: string; alterations?: string[] }[] {
  const out: { gene: string; alterations?: string[] }[] = [];
  const add = (gene: string, alterations?: string[]) => out.push({ gene, alterations });
  if (/\bEGFR\b/.test(t) || (/\begfr\b/i.test(t) && !/glomerular|ml\/min|mL\/min/i.test(t))) {
    const alts = [
      /exon\s*19|ex19|19del/i.test(t) && "exon19del",
      /l858r/i.test(t) && "L858R",
      /exon\s*20|ex20/i.test(t) && "exon20ins",
    ].filter(Boolean) as string[];
    if (/\buncommon\b|\batypical\b|\brare\b/i.test(t)) alts.push("other");
    else if (!alts.length && /sensiti[sz]ing|activating|\bcommon\b/i.test(t)) alts.push("exon19del", "L858R");
    add("EGFR", alts.length ? alts : undefined);
  }
  if (/\balk\b/i.test(t)) add("ALK", ["fusion"]);
  if (/\bros-?1\b/i.test(t)) add("ROS1", ["fusion"]);
  if (/\bkras\b/i.test(t)) {
    const alts = ["G12C", "G12D", "G12V", "G13C"].filter((a) => new RegExp(a, "i").test(t));
    add("KRAS", alts.length ? alts : undefined);
  }
  if (/\bbraf\b/i.test(t)) add("BRAF", /v600/i.test(t) ? ["V600E"] : undefined);
  if (/\bMET\b|c-?met/.test(t) && /(exon\s*14|met amplification|met alteration|met mutation)/i.test(t)) add("MET", /exon\s*14/i.test(t) ? ["exon14skip"] : undefined);
  if (/\bRET\b/.test(t)) add("RET", /(fusion|rearrange)/i.test(t) ? ["fusion"] : undefined);
  if (/\b(her2|erbb2)\b/i.test(t) && /(mutation|exon\s*20)/i.test(t)) add("ERBB2", undefined);
  if (/\bntrk[123]?\b/i.test(t)) add("NTRK", ["fusion"]);
  return out;
}

// Variants the semantic layer cannot tell apart from other alterations of the same gene.
const UNMODELLED_VARIANT = /\b(g12[abefh-uw-z]|g13[abd-z]|q61[a-z]?|t790m|c797s|exon\s*18|g719|l861q|s768i|non[- ]?v600|class (ii|iii)|amplification|overexpression|copy number|ihc\s*[0-3])\b/i;

function biomarker(t: string, kind: string): Result {
  if (UNMODELLED_VARIANT.test(t)) return null;
  // "Prior treatment with a KRAS G12C inhibitor" is a therapy history question, not a
  // biomarker one; "EGFR mutation for which a TKI is approved" is still a biomarker.
  if (/(prior|previous(ly)?|received|treated with|treatment with|exposure to|progress(ed|ion|ive disease) on)[^.;]{0,50}(inhibitors?|tkis?|tyrosine kinase|targeted therap)/i.test(t.replace(/\([^()]*\)/g, ""))) return null;
  if (/(applicable to|only for|patients only|participants only)/i.test(t)) return null;
  if (/pd-?l1/i.test(t) && !/(egfr|alk|ros1|kras|braf|ret|ntrk|her2|erbb2)/i.test(t)) return null;
  const genes = genesIn(t);
  if (!genes.length) return null;
  if (/(other|additional|any) (actionable|targetable|driver|oncogenic)/i.test(t) && genes.length < 2) return null;
  const negative = /(\bno (known |documented )?(egfr|alk|ros-?1|kras|braf|met|ret|her2|erbb2|ntrk|actionable|sensitizing)|\bno\b[^.;]{0,30}(mutation|rearrangement|fusion|alteration)|without|negative for|wild[- ]?type|absence of|not have|must not have|lack of|do not harbor|non-?(egfr|alk))/i.test(t);
  const caveats: string[] = [];
  if (/(tissue|plasma|ctdna|central|local|fda[- ]approved|validated) (test|assay|laborator)/i.test(t)) caveats.push("assay type and testing laboratory are not checked");
  if (/(or other|unknown status|if (known|available)|status (is )?unknown)/i.test(t)) caveats.push("wording allows untested status; review if UNKNOWN");
  const leaves = genes.map((g) => ({ k: "biomarker", gene: g.gene, alterations: g.alterations, status: "detected" }) as Pred);
  if (kind === "inclusion" && !negative) {
    // "EGFR exon 19 deletion or L858R" is one gene with alternatives; several genes are alternatives too.
    return { pred: leaves.length === 1 ? leaves[0] : { k: "or", any: leaves }, caveats };
  }
  if (kind === "inclusion" && negative) {
    // "No known EGFR mutation" lets untested patients through; "negative for EGFR" needs a result.
    const knownOnly = /(no known|without (a )?known|absence of (a )?(known|documented)|not have (a )?known|absence of)/i.test(t) && !/negative (test|result)|tested negative|wild[- ]?type/i.test(t);
    const neg = genes.map((g) => knownOnly
      ? ({ k: "not", p: { k: "biomarker", gene: g.gene, alterations: g.alterations, status: "detected" } } as Pred)
      : ({ k: "biomarker", gene: g.gene, alterations: g.alterations, status: "not_detected" }) as Pred);
    return { pred: neg.length === 1 ? neg[0] : { k: "and", all: neg }, caveats };
  }
  if (kind === "exclusion" && !negative) return { pred: leaves.length === 1 ? leaves[0] : { k: "or", any: leaves }, caveats };
  return null;
}

function pdl1(t: string): Result {
  if (!/pd-?l1/i.test(t) || !/(tps|tumou?r proportion|expression|%)/i.test(t)) return null;
  if (/(cps|combined positive|tumou?r area positivity|tap\b|immune cell)/i.test(t)) return null;
  const range = t.match(/(\d{1,2})\s*%?\s*(?:-|–|to)\s*(\d{2})\s*%/);
  if (range) return { pred: { k: "pdl1", minTps: Number(range[1]), maxTps: Number(range[2]) }, caveats: ["PD-L1 assay clone is not checked"] };
  const m = t.match(new RegExp(`${CMP}\\s*(\\d{1,3})\\s*%`, "i"));
  if (!m) return null;
  const v = Number(m[2]);
  const o = op(m[1]);
  const pred: Pred = o === ">=" ? { k: "pdl1", minTps: v } : o === ">" ? { k: "pdl1", minTps: v + 0.0001 } : o === "<" ? { k: "pdl1", maxTps: v - 0.0001 } : { k: "pdl1", maxTps: v };
  return { pred, caveats: ["PD-L1 assay clone is not checked"] };
}

function brain(t: string, kind: string): Result {
  if (kind !== "exclusion" || !/(brain|cns|central nervous system|leptomeningeal|intracranial)/i.test(t) || !/metasta|disease|lesion/i.test(t)) return null;
  if (/leptomeningeal/i.test(t) && !/brain|cns/i.test(t)) return null;
  const activeOnly = /(active|untreated|symptomatic|unstable|progressing|require[sd]? (steroid|treatment)|unless|except|stable|previously treated)/i.test(t);
  return { pred: { k: "brain_mets", activeOnly }, caveats: activeOnly ? ["stability window and steroid use are not checked"] : [] };
}

function conditions(t: string, kind: string): Result {
  if (kind !== "exclusion") return null;
  if (/(hiv|hepatitis|hbv|hcv|human immunodeficiency)/i.test(t) && /(not (well )?controlled|uncontrolled|active infection|viral load|unless|undetectable|cured|treated)/i.test(t)) return null;
  if (/interfere|investigator'?s? (judg|opinion)|could (likely )?affect|in the opinion/i.test(t)) return null;
  if (/(aids|complication|kaposi|castleman|opportunistic)/i.test(t)) return null;
  if (/(transplant|diverticul|asthma|copd|chronic obstructive|pulmonary embol|tuberculosis|sarcoid|radiation pneumonitis|pulmonary hypertension|bowel)/i.test(t)) return null;
  const found: Pred[] = [];
  const cav: string[] = [];
  if (/\bhiv\b|human immunodeficiency/i.test(t)) found.push({ k: "condition", category: "hiv" });
  if (/hepatitis b|\bhbv\b/i.test(t)) found.push({ k: "condition", category: "hbv" });
  if (/hepatitis c|\bhcv\b/i.test(t)) found.push({ k: "condition", category: "hcv" });
  if (/interstitial lung disease|\bild\b|pulmonary fibrosis/i.test(t)) found.push({ k: "condition", category: "ild" });
  if (/pneumonitis/i.test(t)) found.push({ k: "condition", category: "pneumonitis" }, { k: "condition", category: "ild" });
  if (/autoimmune/i.test(t)) {
    found.push({ k: "condition", category: "autoimmune" });
    if (/(vitiligo|type 1 diabetes|hypothyroid|psoriasis|except|exception)/i.test(t)) cav.push("listed autoimmune exceptions are not applied");
  }
  if (/(congestive )?heart failure|nyha/i.test(t)) found.push({ k: "condition", category: "heart_failure" });
  if (/(additional|another|second|prior|concurrent|other) (primary )?(malignanc|cancer)/i.test(t)) {
    const activeOnly = /(active|progressing|requir(ed|ing) (active )?treatment|currently (being )?treated|residual disease)/i.test(t) && !/history of/i.test(t);
    found.push({ k: "condition", category: "other_malignancy_active" });
    if (!activeOnly) found.push({ k: "condition", category: "other_malignancy_history" });
    cav.push("history window and cured-cancer exceptions are not applied");
  }
  if (!found.length) return null;
  if (/within \d+ (day|week|month|year)/i.test(t)) cav.push("time window not checked");
  return { pred: found.length === 1 ? found[0] : { k: "or", any: found }, caveats: cav };
}

function priorTherapy(t: string, kind: string): Result {
  // Washout periods ("within 4 weeks of first dose") are confirmed at screening, not here.
  if (/within \d+\s*(day|week|month)|half-?lives|prior to (the )?(first dose|randomi|enrol)/i.test(t)) return null;
  // "In an adjuvant, locally advanced, or metastatic setting" means any setting, which is what the check counts.
  const anySetting = /adjuvant,?\s+(locally advanced,?\s+)?(or|and\/or)\s+(locally advanced|metastatic|advanced)|adjuvant,\s+locally advanced,?\s+or\s+metastatic/i.test(t);
  const tA = anySetting ? t.replace(/adjuvant/gi, "") : t;
  if (/(adverse (event|reaction)|toxicit|intoleran|hypersensitiv|allerg|discontinu|mmae|pan-?(kras|ras)|exactly|neoadjuvant|adjuvant|locally advanced disease is|permitted|allowed)/i.test(tA)) return null;
  if (/chemotherap/i.test(t) && !/platinum/i.test(t)) return null;
  // Named agents are narrower than a drug class; leave them for the model or a human.
  if (/(osimertinib|gefitinib|erlotinib|afatinib|lazertinib|amivantamab|pembrolizumab|nivolumab|atezolizumab|durvalumab|cemiplimab|alectinib|lorlatinib|brigatinib|crizotinib|capmatinib|tepotinib|selpercatinib|pralsetinib|dabrafenib)/i.test(t) && !/(egfr[- ]?tki|tyrosine kinase inhibitor|checkpoint|anti-?pd)/i.test(t)) return null;
  const classes: string[] = [];
  if (/(anti-?pd-?\(?l?\)?1|pd-?1|pd-?l1 (inhibitor|antibod|therap)|checkpoint inhibitor|immune checkpoint|immunotherapy|\bico\b|\bicis?\b)/i.test(t) && !/expression|tps/i.test(t)) classes.push("PD1_PDL1");
  if (/platinum/i.test(t)) classes.push("PLATINUM");
  if (/osimertinib|egfr[- ]?tki|egfr tyrosine kinase inhibitor/i.test(t)) classes.push("EGFR_TKI");
  if (/(kras g12c inhibitor|targeting kras g12c|sotorasib|adagrasib)/i.test(t)) classes.push("KRAS_G12C");
  if (/(alk (tki|inhibitor)|alectinib|lorlatinib|brigatinib|crizotinib)/i.test(t)) classes.push("ALK_TKI");
  if (/\btaxanes?\b/i.test(t) && !/docetaxel|paclitaxel/i.test(t)) classes.push("TAXANE");
  if (/docetaxel|paclitaxel/i.test(t) && !classes.length) return null;
  const noSystemic = /(no prior|not (have )?received (any )?prior|treatment[- ]na[iï]ve|have not received) (systemic|anti-?cancer|chemo)/i.test(t);
  const anyPrior = /prior systemic (therapy|treatment)|prior (anti-?cancer|chemotherapy)/i.test(t);
  if (noSystemic && /(metastatic|advanced|stage iv|recurrent)/i.test(t)) {
    return { pred: { k: "lines", max: 0 }, caveats: ["adjuvant and consolidation therapy are not counted as metastatic lines"] };
  }
  if (!classes.length) {
    if (kind === "exclusion" && anyPrior && /(metastatic|advanced|stage iv)/i.test(t) && !/more than|>|≥/.test(t)) {
      return { pred: { k: "lines", min: 1 }, caveats: ["adjuvant and consolidation therapy are not counted as metastatic lines"] };
    }
    return null;
  }
  const progressed = /(progress|refractory|resistant|failed|after|following|received|prior|previously treated|exposure|treatment (targeting|with)|therapy with)/i.test(t);
  if (!progressed) return null;
  const negated = /\b(no|not|without|naive|na[iï]ve)\b/i.test(t);
  const present = kind === "exclusion" ? !negated : !negated;
  return {
    pred: { k: "prior_therapy", classes: classes as any, present },
    caveats: ["dose, duration and reason for stopping are not checked", ...(/(3rd|third)[- ]generation/i.test(t) ? ["which EGFR TKI generation is not checked"] : []), ...(/most recent line/i.test(t) ? ["whether it was the most recent line is not checked"] : [])],
  };
}

interface LabSpec { analyte: "ANC" | "PLT" | "HGB" | "CREAT" | "CRCL" | "TBILI" | "AST" | "ALT"; rx: RegExp }
const LABS: LabSpec[] = [
  { analyte: "ANC", rx: /(absolute neutrophil|neutrophil count|\banc\b)/i },
  { analyte: "PLT", rx: /platelet/i },
  { analyte: "HGB", rx: /h(a)?emoglobin|\bhgb\b|\bhb\b/i },
  { analyte: "CRCL", rx: /creatinine clearance|\bcrcl\b|\begfr\b(?=.*(ml\/min|mL\/min))|glomerular filtration/i },
  { analyte: "CREAT", rx: /(serum )?creatinine(?! clearance)/i },
  { analyte: "TBILI", rx: /bilirubin/i },
  { analyte: "AST", rx: /\bast\b|aspartate|sgot/i },
  { analyte: "ALT", rx: /\balt\b|alanine|sgpt/i },
];

function labValue(analyte: LabSpec["analyte"], seg: string): { op: ">=" | "<=" | ">" | "<"; value: number; xUln?: boolean } | null {
  const m = seg.match(new RegExp(`${CMP}\\s*([\\d.,]+)\\s*(?:x|×|\\*|times)?\\s*(uln|upper limit of normal|institutional upper limit|uln\\b)?`, "i"));
  if (!m) return null;
  let value = num(m[2]);
  if (Number.isNaN(value)) return null;
  const after = seg.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 40);
  const xUln = Boolean(m[3]) || /(×|\bx\b|times)\s*(the\s+)?(institutional\s+|local\s+)?(upper limit of normal|uln)/i.test(after);
  if (!xUln) {
    if (analyte === "ANC" && value >= 100) value = value / 1000;
    if (analyte === "PLT" && value >= 1000) value = value / 1000;
    if (analyte === "HGB" && /g\/l/i.test(seg) && value > 30) value = value / 10;
    if (analyte === "CREAT" && /µmol|umol/i.test(seg)) return null;
    if (analyte === "TBILI" && /µmol|umol/i.test(seg)) return null;
  }
  return xUln ? { op: op(m[1]), value, xUln: true } : { op: op(m[1]), value };
}

function labs(t: string, kind: string): Result {
  if (kind === "exclusion" && !/(inadequate|abnormal|out of range|insufficient)/i.test(t)) return null;
  const parts: Pred[] = [];
  const cav: string[] = [];
  // Split into segments per analyte mention so each threshold binds to the right test.
  const segs = t.split(/;|\n|,(?=\s*[A-Z][a-z]+ )/);
  for (const seg of segs) {
    const hits = LABS.filter((l) => l.rx.test(seg));
    if (!hits.length) continue;
    if (hits.some((h) => h.analyte === "AST") && hits.some((h) => h.analyte === "ALT")) {
      const v = labValue("AST", seg);
      if (!v) return null;
      parts.push({ k: "lab", analyte: "AST", ...v }, { k: "lab", analyte: "ALT", ...v });
      if (/liver metasta|hepatic metasta/i.test(seg)) cav.push("higher limit allowed with liver metastases is not applied");
      continue;
    }
    if (hits.some((h) => h.analyte === "CREAT") && hits.some((h) => h.analyte === "CRCL")) {
      const [a, b] = seg.split(/\bor\b/i);
      const v1 = a && labValue("CREAT", a);
      const v2 = b && labValue("CRCL", b);
      if (v1 && v2) { parts.push({ k: "or", any: [{ k: "lab", analyte: "CREAT", ...v1 }, { k: "lab", analyte: "CRCL", ...v2 }] }); continue; }
      return null;
    }
    const h = hits[0];
    const v = labValue(h.analyte, seg);
    if (!v) return null;
    parts.push({ k: "lab", analyte: h.analyte, ...v });
    if (h.analyte === "TBILI" && /gilbert/i.test(seg)) cav.push("Gilbert's syndrome exception is not applied");
  }
  if (!parts.length) return null;
  if (/(transfusion|growth factor|within \d+ days)/i.test(t)) cav.push("transfusion and growth-factor timing is not checked");
  // An exclusion list ("inadequate organ function: ANC < 1.5; platelets < 100") excludes
  // when any value is out of range.
  return { pred: parts.length === 1 ? parts[0] : kind === "exclusion" ? { k: "or", any: parts } : { k: "and", all: parts }, caveats: cav };
}

function lines(t: string, kind: string): Result {
  t = t.replace(/\bone\b/gi, "1").replace(/\btwo\b/gi, "2").replace(/\bthree\b/gi, "3");
  if (kind !== "inclusion" || !/((prior|previous)\s+(systemic\s+)?(lines?|regimens?|therap)|\d\s+(prior\s+)?lines? of (systemic )?therapy)/i.test(t)) return null;
  if (/exactly/i.test(t)) return null;
  if (/adjuvant|neoadjuvant|within \d/i.test(t) && !/advanced|metastatic/i.test(t)) return null;
  const between = t.match(/at least\s+(\d)\s+(?:and|but)\s+no more than\s+(\d)/i) ?? t.match(/(\d)\s*(?:-|–|to)\s*(\d)\s+prior/i);
  const atMost = t.match(/(?:no more than|up to|at most|≤|<=)\s*(\d)\s+(?:prior|previous|line|regimen|systemic)/i) ?? t.match(/(\d)\s+or fewer\s+prior/i);
  const atLeast = t.match(/(?:at least|≥|>=|minimum of)\s*(\d)\s+(?:prior|previous|lines?|regimens?|systemic)/i);
  const cav = ["adjuvant and consolidation therapy are not counted as metastatic lines"];
  if (between) return { pred: { k: "lines", min: Number(between[1]), max: Number(between[2]) }, caveats: cav };
  if (atMost && atLeast) return { pred: { k: "lines", min: Number(atLeast[1]), max: Number(atMost[1]) }, caveats: cav };
  if (atMost) return { pred: { k: "lines", max: Number(atMost[1]) }, caveats: cav };
  if (atLeast) return { pred: { k: "lines", min: Number(atLeast[1]) }, caveats: cav };
  return null;
}

function measurable(t: string, kind: string): Result {
  if (kind !== "inclusion" || !/measurable (disease|lesion)|recist/i.test(t) || /evaluable|non-?measurable/i.test(t) && !/measurable disease/i.test(t)) return null;
  return { pred: { k: "measurable_disease" }, caveats: ["radiology read date is not checked"] };
}

const MATCHERS = [labs, ecog, age, pdl1, biomarker, brain, conditions, lines, priorTherapy, diagnosis, measurable];

// Criteria that apply only to another cohort, or to another cancer in a basket trial,
// cannot be checked against a lung cancer patient without knowing the cohort.
const OTHER_SCOPE = /^(cohort|part|arm|phase|dose (escalation|expansion)|for (the )?(maintenance|expansion|escalation|part|cohort|arm)[^:]*only)\b|\b(part \d|part [a-c]\b|expansion group|arms? \d|sub-?stud(y|ies)|cohort [a-z0-9]{1,3}\b|group [a-c1-9]\b|step 2|randomi[sz]ation step)|\bmay (have )?(received|be|include)\b|other protocol-defined|\b(colorectal|\bcrc\b|breast|prostate|ovarian|melanoma|pancrea|gastric|urothelial|bladder|head and neck|hepatocellular|endometrial|cervical|renal cell|mesothelioma|sarcoma|lymphoma|leukemia|myeloma|small[- ]cell lung)/i;
const SCREENING_FIRST_ALWAYS = /(contracept|pregnan|child[- ]bearing|washout|half-?lives|corticosteroid|steroids? (at|>)|have elapsed|must have elapsed)/i;
const TIMED = /(within \d+\s*(hours?|days?|weeks?|months?)|(prior to|before) (the )?(first dose|start of study|enrol|randomi|c1d1))/i;
const TIMED_EXPOSURE = /(therap|treatment|chemo|radiat|radiotherap|surgery|surgical|vaccin|drug|agent|medication|inhibitor|antibod|transfusion|investigational)/i;
// Washouts, contraception and similar items are confirmed at screening even when they
// name a drug; labs and performance status "within 14 days" are still record checks.
const SCREENING_FIRST = { test: (t: string) => SCREENING_FIRST_ALWAYS.test(t) || (TIMED.test(t) && TIMED_EXPOSURE.test(t) && !/(ecog|performance status|neutrophil|platelet|h(a)?emoglobin|creatinine|bilirubin|ast|alt\b|clearance)/i.test(t)) };
const NOT_A_THRESHOLD = /\b(grade|toxicit|ctcae|adverse event|transfusion-dependent)\b/i;

// Plausible threshold ranges per analyte; anything outside is treated as a parse error.
const PLAUSIBLE: Record<string, [number, number]> = {
  ANC: [0.5, 5], PLT: [25, 300], HGB: [6, 14], CREAT: [0.5, 3.5], CRCL: [15, 120], TBILI: [0.5, 5], AST: [1, 10], ALT: [1, 10],
};
function plausible(p: Pred): boolean {
  switch (p.k) {
    case "and": return p.all.every(plausible);
    case "or": return p.any.every(plausible);
    case "not": return plausible(p.p);
    case "lab": {
      const [lo, hi] = p.xUln ? [0.5, 10] : PLAUSIBLE[p.analyte];
      return p.value >= lo && p.value <= hi;
    }
    case "pdl1": return (p.minTps ?? 0) >= 0 && (p.maxTps ?? 100) <= 100;
    case "age": return (p.min ?? 18) >= 10 && (p.max ?? 100) <= 110;
    default: return true;
  }
}
function dedupe(p: Pred): Pred {
  if (p.k === "or" || p.k === "and") {
    const items = (p.k === "or" ? p.any : p.all).map(dedupe);
    const seen = new Set<string>();
    const uniq = items.filter((x) => !seen.has(JSON.stringify(x)) && seen.add(JSON.stringify(x)));
    if (uniq.length === 1) return uniq[0];
    return p.k === "or" ? { k: "or", any: uniq } : { k: "and", all: uniq };
  }
  return p;
}
const CARDIAC_OTHERS = /(myocardial|stroke|angina|arrhythm|qtc|cerebrovascular|cerebral vascular|thrombo|embol|cardiomyopathy)/i;

export function compileByRules(c: Pick<Criterion, "text" | "kind">): { pred: Pred; caveats: string[] } | null {
  const t = c.text;
  if (OTHER_SCOPE.test(t)) return null;
  // Exceptions turn a rule inside out ("targetable alterations, with the exception of
  // HER2"); a person reads those.
  // Brain metastases "unless treated and stable" and autoimmune "except vitiligo" are
  // handled by their own matchers in the conservative direction.
  const handledException = /(brain|cns|central nervous system)[^.;]{0,40}metasta/i.test(t) || /autoimmune/i.test(t);
  if (!handledException && /(with the exception of|except(ing)? (for|those|patients|participants|in)|\bexcept\b|\bunless\b|other than|apart from)/i.test(t)) return null;
  // An inclusion sentence that also says who is not eligible needs a person to read it.
  if (c.kind === "inclusion" && /(not eligible|are excluded|will be excluded|ineligible)/i.test(t)) return null;
  // A bracketed "(such as osimertinib, ...)" right after a drug class only gives examples
  // of the class the rule checks; any other "such as" list needs a person.
  const tEx = t.replace(/\((such as|e\.g\.,?)[^()]*\)(?=\s*egfr[- ]?tki)/i, "");
  if (/(including,? but not limited to|\be\.g\.|\beg,|such as|following criteria|any (other )?(targetable|actionable)|etc\b)/i.test(tEx)) return null;
  // Washouts, contraception and similar items are confirmed at screening even when
  // they name a drug or a condition.
  if (SCREENING_FIRST.test(t)) return null;
  for (const m of MATCHERS) {
    if (m === labs && NOT_A_THRESHOLD.test(t)) continue;
    const r = m(t, c.kind);
    if (!r) continue;
    const pred = dedupe(r.pred);
    if (!plausible(pred)) return null;
    const caveats = [...r.caveats];
    if (m === conditions && CARDIAC_OTHERS.test(t) && JSON.stringify(pred).includes("heart_failure")) return null;
    if (m === diagnosis && pred.k === "histology" && pred.anyOf.length === 4) caveats.push("only confirms an NSCLC diagnosis");
    return { pred, caveats };
  }
  return null;
}

// Sentences that define who the trial is for: the disease, its stage, a driver gene,
// therapy history or resectability. If one of these cannot be compiled it must stay in
// front of a person, never be filed as a screening-visit formality.
export const DISEASE_DEFINING = /\b(newly diagnosed|solid tumou?rs?|recurren(t|ce)|diagnos(is|ed) of|nsclc|non[- ]?small|carcinoma|adenocarcinoma|squamous|histolog|cytolog|stage\s*(i|ii|iii|iv|1|2|3|4)|metastatic|locally advanced|unresectable|resect|egfr|alk|ros-?1|kras|braf|MET|ret|her2|erbb2|ntrk|pd-?l1|mutation|fusion|rearrangement|alteration|biomarker|prior (systemic|therapy|treatment|line)|line[s]? of (systemic )?therapy|progress(ed|ion)|refractory|treatment[- ]na[iï]ve|tki|immunotherapy|checkpoint|platinum|chemotherapy|brain metasta|cns metasta)\b/i;

export function isDiseaseDefining(text: string): boolean {
  return DISEASE_DEFINING.test(text);
}

export function isScreeningItem(text: string): boolean {
  return SCREENING.test(text) && !isDiseaseDefining(text);
}
