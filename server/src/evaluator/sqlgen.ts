// Turns predicate leaves into SQL. Each leaf becomes a column that evaluates to
// 'T', 'F' or 'U' (unknown: the clinic has no data to decide) for every patient.
// The leaves run inside the data layer; code only combines them.
import type { Leaf, Pred } from "../dsl.ts";

export interface Tables { (name: string): string }

const list = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");

export function leaves(p: Pred): Leaf[] {
  if (p.k === "and") return p.all.flatMap(leaves);
  if (p.k === "or") return p.any.flatMap(leaves);
  if (p.k === "not") return leaves(p.p);
  return [p];
}

export function leafKey(l: Leaf): string {
  return JSON.stringify(l);
}

export function leafSql(l: Leaf, t: Tables, labCutoff: string): string {
  const pid = "p.patient_id";
  switch (l.k) {
    case "age": {
      const conds = [l.min !== undefined && `p.age_years >= ${l.min}`, l.max !== undefined && `p.age_years <= ${l.max}`].filter(Boolean).join(" AND ");
      return `CASE WHEN p.age_years IS NULL THEN 'U' WHEN ${conds || "1=1"} THEN 'T' ELSE 'F' END`;
    }
    case "sex":
      return `CASE WHEN p.sex IS NULL THEN 'U' WHEN p.sex = '${l.is}' THEN 'T' ELSE 'F' END`;
    case "histology": {
      const allowsNos = l.anyOf.includes("nos");
      return `(SELECT CASE WHEN COUNT(*) = 0 THEN 'U'
        WHEN SUM(CASE WHEN d.histology IN (${list(l.anyOf)}) THEN 1 ELSE 0 END) > 0 THEN 'T'
        ${allowsNos ? "" : "WHEN SUM(CASE WHEN d.histology = 'nos' OR d.histology IS NULL THEN 1 ELSE 0 END) > 0 THEN 'U'"}
        ELSE 'F' END FROM ${t("diagnosis")} d WHERE d.patient_id = ${pid})`;
    }
    case "stage":
      return `(SELECT CASE WHEN COUNT(d.stage_group) = 0 THEN 'U'
        WHEN SUM(CASE WHEN d.stage_group IN (${list(l.anyOf)}) THEN 1 ELSE 0 END) > 0 THEN 'T' ELSE 'F' END
        FROM ${t("diagnosis")} d WHERE d.patient_id = ${pid})`;
    case "ecog":
      return `CASE WHEN p.ecog IS NULL THEN 'U' WHEN p.ecog <= ${l.max} THEN 'T' ELSE 'F' END`;
    case "measurable_disease":
      return `(SELECT CASE WHEN MAX(d.measurable_disease) = 'Y' THEN 'T' WHEN MAX(d.measurable_disease) = 'N' THEN 'F' ELSE 'U' END
        FROM ${t("diagnosis")} d WHERE d.patient_id = ${pid})`;
    case "biomarker": {
      const alt = l.alterations?.length ? ` AND b.alteration IN (${list(l.alterations)})` : "";
      const hit = `EXISTS (SELECT 1 FROM ${t("biomarker")} b WHERE b.patient_id = ${pid} AND b.gene = '${l.gene}' AND b.status = 'detected'${alt})`;
      const tested = `EXISTS (SELECT 1 FROM ${t("biomarker")} b WHERE b.patient_id = ${pid} AND b.gene = '${l.gene}' AND b.status IN ('detected', 'not_detected'))`;
      return l.status === "detected"
        ? `CASE WHEN ${hit} THEN 'T' WHEN ${tested} THEN 'F' ELSE 'U' END`
        : `CASE WHEN ${hit} THEN 'F' WHEN ${tested} THEN 'T' ELSE 'U' END`;
    }
    case "pdl1": {
      const conds = [l.minTps !== undefined && `MAX(b.tps) >= ${l.minTps}`, l.maxTps !== undefined && `MAX(b.tps) <= ${l.maxTps}`].filter(Boolean).join(" AND ");
      return `(SELECT CASE WHEN MAX(b.tps) IS NULL THEN 'U' WHEN ${conds} THEN 'T' ELSE 'F' END
        FROM ${t("biomarker")} b WHERE b.patient_id = ${pid} AND b.gene = 'PDL1')`;
    }
    case "prior_therapy": {
      const cls = l.classes.includes("ANY_SYSTEMIC") ? "1=1" : `x.therapy_class IN (${list(l.classes)})`;
      const has = `EXISTS (SELECT 1 FROM ${t("therapy")} x WHERE x.patient_id = ${pid} AND ${cls})`;
      const unresolved = `EXISTS (SELECT 1 FROM ${t("therapy")} x WHERE x.patient_id = ${pid} AND x.therapy_class = 'UNRESOLVED')`;
      return l.present
        ? `CASE WHEN ${has} THEN 'T' WHEN ${unresolved} THEN 'U' ELSE 'F' END`
        : `CASE WHEN ${has} THEN 'F' WHEN ${unresolved} THEN 'U' ELSE 'T' END`;
    }
    case "lines": {
      const n = `(SELECT COUNT(DISTINCT x.line_of_therapy) FROM ${t("therapy")} x WHERE x.patient_id = ${pid} AND x.setting = 'metastatic' AND x.line_of_therapy >= 1)`;
      const conds = [l.min !== undefined && `${n} >= ${l.min}`, l.max !== undefined && `${n} <= ${l.max}`].filter(Boolean).join(" AND ");
      return `CASE WHEN ${conds} THEN 'T' ELSE 'F' END`;
    }
    case "lab": {
      // Latest result for the analyte; results older than the cutoff count as missing.
      const latest = `FROM ${t("lab")} r WHERE r.patient_id = ${pid} AND r.analyte = '${l.analyte}' AND r.value IS NOT NULL AND r.unit IS NOT NULL
        AND r.collected_date = (SELECT MAX(r2.collected_date) FROM ${t("lab")} r2 WHERE r2.patient_id = ${pid} AND r2.analyte = '${l.analyte}' AND r2.unit IS NOT NULL)`;
      const lhs = l.xUln ? `MAX(r.value) / NULLIF(MAX(r.uln), 0)` : "MAX(r.value)";
      return `(SELECT CASE WHEN COUNT(*) = 0 OR MAX(r.collected_date) < DATE '${labCutoff}' ${l.xUln ? "OR MAX(r.uln) IS NULL" : ""} THEN 'U'
        WHEN ${lhs} ${l.op} ${l.value} THEN 'T' ELSE 'F' END ${latest})`;
    }
    case "condition":
      return `CASE WHEN EXISTS (SELECT 1 FROM ${t("condition")} c WHERE c.patient_id = ${pid} AND c.category = '${l.category}') THEN 'T' ELSE 'F' END`;
    case "brain_mets": {
      const status = l.activeOnly ? " AND m.status = 'active'" : "";
      return `CASE WHEN EXISTS (SELECT 1 FROM ${t("metastasis")} m WHERE m.patient_id = ${pid} AND m.site = 'brain'${status}) THEN 'T' ELSE 'F' END`;
    }
  }
}

// Evidence query: the source rows a reviewer needs to see for one leaf and one patient.
export function evidenceSql(l: Leaf, t: Tables, patientId: string): string {
  const id = `'${patientId.replace(/'/g, "''")}'`;
  switch (l.k) {
    case "age":
    case "sex":
    case "ecog":
      return `SELECT patient_id, sex, birth_date, age_years, ecog, ecog_date FROM ${t("patient")} WHERE patient_id = ${id}`;
    case "histology":
    case "stage":
    case "measurable_disease":
      return `SELECT patient_id, diagnosis_text, histology, histology_ncit, stage, stage_group, measurable_disease, diagnosis_date FROM ${t("diagnosis")} WHERE patient_id = ${id}`;
    case "biomarker":
      return `SELECT patient_id, lab_mrn, gene, status, alteration, result_text, assay, reported_date FROM ${t("biomarker")} WHERE patient_id = ${id} AND gene = '${l.gene}'`;
    case "pdl1":
      return `SELECT patient_id, lab_mrn, gene, tps, result_text, assay, reported_date FROM ${t("biomarker")} WHERE patient_id = ${id} AND gene = 'PDL1'`;
    case "prior_therapy":
    case "lines":
      return `SELECT patient_id, order_text, rxcui, ingredient, atc_code, therapy_class, line_of_therapy, setting, start_date, end_date FROM ${t("therapy")} WHERE patient_id = ${id} ORDER BY start_date`;
    case "lab":
      return `SELECT patient_id, lab_mrn, accession, loinc, analyte, value, unit, uln, collected_date FROM ${t("lab")} WHERE patient_id = ${id} AND analyte = '${l.analyte}' ORDER BY collected_date DESC`;
    case "condition":
      return `SELECT patient_id, icd10, description, category FROM ${t("condition")} WHERE patient_id = ${id}`;
    case "brain_mets":
      return `SELECT patient_id, site, status, noted_date FROM ${t("metastasis")} WHERE patient_id = ${id}`;
  }
}

// What a coordinator would do to resolve an UNKNOWN leaf.
export interface DataItem { id: string; label: string; needsTissue: boolean; standardOfCare: boolean }
export function dataItemFor(l: Leaf): DataItem {
  switch (l.k) {
    case "biomarker":
      return { id: "ngs_panel", label: "Comprehensive NGS panel (EGFR, ALK, ROS1, KRAS, BRAF, MET, RET, ERBB2, NTRK); plasma ctDNA is an option when tissue is limited", needsTissue: false, standardOfCare: true };
    case "pdl1":
      return { id: "pdl1_ihc", label: "PD-L1 IHC (22C3) on existing tumor tissue", needsTissue: true, standardOfCare: true };
    case "lab":
      return ["ANC", "PLT", "HGB"].includes(l.analyte)
        ? { id: "cbc", label: "CBC with differential (results older than 30 days count as missing)", needsTissue: false, standardOfCare: true }
        : { id: "cmp", label: "Comprehensive metabolic panel with creatinine clearance", needsTissue: false, standardOfCare: true };
    case "ecog":
      return { id: "ecog", label: "Document ECOG performance status at the next visit", needsTissue: false, standardOfCare: true };
    case "measurable_disease":
      return { id: "recist", label: "Radiology read for measurable disease (RECIST 1.1)", needsTissue: false, standardOfCare: true };
    case "histology":
      return { id: "path_review", label: "Pathology review to classify histology", needsTissue: false, standardOfCare: true };
    case "stage":
      return { id: "staging", label: "Complete staging workup", needsTissue: false, standardOfCare: true };
    case "prior_therapy":
    case "lines":
      return { id: "med_reconcile", label: "Reconcile unresolved medication orders", needsTissue: false, standardOfCare: true };
    default:
      return { id: "chart_review", label: "Chart review", needsTissue: false, standardOfCare: true };
  }
}

export type Tri = "T" | "F" | "U";
export function combine(p: Pred, value: (l: Leaf) => Tri): Tri {
  switch (p.k) {
    case "and": {
      const vs = p.all.map((x) => combine(x, value));
      return vs.includes("F") ? "F" : vs.includes("U") ? "U" : "T";
    }
    case "or": {
      const vs = p.any.map((x) => combine(x, value));
      return vs.includes("T") ? "T" : vs.includes("U") ? "U" : "F";
    }
    case "not": {
      const v = combine(p.p, value);
      return v === "T" ? "F" : v === "F" ? "T" : "U";
    }
    default:
      return value(p);
  }
}
