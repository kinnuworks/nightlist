// The criterion language. Every eligibility criterion is compiled into one of these
// predicates (or marked as needing a human read). Predicates only name fields that
// exist in the semantic layer, so a model cannot invent data the clinic does not hold.
import { z } from "zod";

export const GENES = ["EGFR", "ALK", "ROS1", "KRAS", "BRAF", "MET", "RET", "ERBB2", "NTRK"] as const;
export const ALTERATIONS = ["exon19del", "L858R", "exon20ins", "G12C", "G12D", "G12V", "G13C", "V600E", "exon14skip", "fusion", "other"] as const;
export const THERAPY_CLASSES = [
  "PD1_PDL1", "CTLA4", "PLATINUM", "PEMETREXED", "TAXANE", "EGFR_TKI", "ALK_TKI", "KRAS_G12C", "MET_TKI",
  "RET_TKI", "ANTI_VEGF", "EGFR_MET_BISPECIFIC", "ADC", "BRAF_TKI", "ANY_SYSTEMIC",
] as const;
export const HISTOLOGIES = ["adenocarcinoma", "squamous", "large_cell", "nos"] as const;
export const STAGE_GROUPS = ["I", "II", "III", "IV"] as const;
export const ANALYTES = ["ANC", "PLT", "HGB", "CREAT", "CRCL", "TBILI", "AST", "ALT"] as const;
export const CONDITIONS = [
  "ild", "pneumonitis", "autoimmune", "hbv", "hcv", "hiv", "heart_failure", "other_malignancy_active", "other_malignancy_history",
] as const;

const leaf = z.discriminatedUnion("k", [
  z.object({ k: z.literal("age"), min: z.number().optional(), max: z.number().optional() }),
  z.object({ k: z.literal("sex"), is: z.enum(["female", "male"]) }),
  z.object({ k: z.literal("histology"), anyOf: z.array(z.enum(HISTOLOGIES)).min(1) }),
  z.object({ k: z.literal("stage"), anyOf: z.array(z.enum(STAGE_GROUPS)).min(1) }),
  z.object({ k: z.literal("ecog"), max: z.number().int().min(0).max(4) }),
  z.object({
    k: z.literal("biomarker"),
    gene: z.enum(GENES),
    alterations: z.array(z.enum(ALTERATIONS)).optional(),
    status: z.enum(["detected", "not_detected"]),
  }),
  z.object({ k: z.literal("pdl1"), minTps: z.number().optional(), maxTps: z.number().optional() }),
  z.object({ k: z.literal("prior_therapy"), classes: z.array(z.enum(THERAPY_CLASSES)).min(1), present: z.boolean() }),
  z.object({ k: z.literal("lines"), max: z.number().int().optional(), min: z.number().int().optional() }),
  z.object({
    k: z.literal("lab"),
    analyte: z.enum(ANALYTES),
    op: z.enum([">=", "<=", ">", "<"]),
    value: z.number(),
    // when true the threshold is a multiple of the upper limit of normal
    xUln: z.boolean().optional(),
  }),
  z.object({ k: z.literal("condition"), category: z.enum(CONDITIONS) }),
  z.object({ k: z.literal("brain_mets"), activeOnly: z.boolean() }),
  z.object({ k: z.literal("measurable_disease") }),
]);

export type Leaf = z.infer<typeof leaf>;
export type Pred = Leaf | { k: "and"; all: Pred[] } | { k: "or"; any: Pred[] } | { k: "not"; p: Pred };

export const predSchema: z.ZodType<Pred> = z.lazy(() =>
  z.union([
    leaf,
    z.object({ k: z.literal("and"), all: z.array(predSchema).min(1) }),
    z.object({ k: z.literal("or"), any: z.array(predSchema).min(1) }),
    z.object({ k: z.literal("not"), p: predSchema }),
  ]),
) as z.ZodType<Pred>;

// Category tells the worklist how to treat a criterion that is not compiled to a check:
// "screening" items (consent, contraception, pregnancy test, ability to swallow) are
// confirmed at the screening visit, not from records; "review" needs a human read.
export type Category = "check" | "screening" | "review";

export interface Criterion {
  criterionId: string;
  nctId: string;
  kind: "inclusion" | "exclusion";
  ordinal: number;
  text: string;
  category: Category;
  method: "rule" | "model" | "structured" | "none";
  pred?: Pred;
  // anything the check deliberately ignores, e.g. "time window not checked"
  caveat?: string;
  check?: { status: "agree" | "disagree" | "unchecked"; backTranslation?: string; model?: string; reason?: string };
}

export function describe(p: Pred): string {
  switch (p.k) {
    case "and": return p.all.map(describe).join(" AND ");
    case "or": return `(${p.any.map(describe).join(" OR ")})`;
    case "not": return `NOT (${describe(p.p)})`;
    case "age": return [p.min !== undefined && `age >= ${p.min}`, p.max !== undefined && `age <= ${p.max}`].filter(Boolean).join(" and ");
    case "sex": return `sex is ${p.is}`;
    case "histology": return `histology in {${p.anyOf.join(", ")}}`;
    case "stage": return `stage group in {${p.anyOf.join(", ")}}`;
    case "ecog": return `ECOG <= ${p.max}`;
    case "biomarker": return `${p.gene}${p.alterations ? ` ${p.alterations.join("/")}` : ""} ${p.status === "detected" ? "detected" : "not detected"}`;
    case "pdl1": return `PD-L1 TPS ${[p.minTps !== undefined && `>= ${p.minTps}%`, p.maxTps !== undefined && `<= ${p.maxTps}%`].filter(Boolean).join(" and ")}`;
    case "prior_therapy": return `${p.present ? "has had" : "has not had"} ${p.classes.join(" or ")}`;
    case "lines": return `prior metastatic lines ${[p.min !== undefined && `>= ${p.min}`, p.max !== undefined && `<= ${p.max}`].filter(Boolean).join(" and ")}`;
    case "lab": return `${p.analyte} ${p.op} ${p.value}${p.xUln ? " x ULN" : ""}`;
    case "condition": return `has ${p.category.replace(/_/g, " ")}`;
    case "brain_mets": return p.activeOnly ? "has active brain metastases" : "has brain metastases";
    case "measurable_disease": return "has measurable disease";
  }
}
