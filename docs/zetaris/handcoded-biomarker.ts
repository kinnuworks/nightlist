// The hand-coded version of one USL table (biomarker), written for comparison only.
// It does what the USL activation query in server/src/usl/schema.ts does: join the lab
// system's molecular reports to EHR patients and normalise the report wording.
// Run: npx tsx docs/zetaris/handcoded-biomarker.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "data", "sources");

function parseCsv(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"' && quoted) { cur += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const patients = parseCsv(join(root, "ehr", "patients.csv"));
const byMrn = new Map(patients.map((p) => [p.mrn, p.patient_id]));

function alteration(text: string, gene: string, interpretation: string): string | null {
  if (text.includes("exon 19 deletion")) return "exon19del";
  if (text.includes("L858R")) return "L858R";
  if (text.includes("exon 20 insertion") && gene === "EGFR") return "exon20ins";
  for (const v of ["G12C", "G12D", "G12V", "G13C", "V600E"]) if (text.includes(v)) return v;
  if (text.includes("exon 14")) return "exon14skip";
  if (text.includes("fusion")) return "fusion";
  return interpretation === "Pathogenic" ? "other" : null;
}

const rows = parseCsv(join(root, "lab", "molecular.csv")).map((m) => ({
  result_key: `${m.report_id}-${m.gene}`,
  patient_id: byMrn.get(m.patient_mrn.replace("MRN", "")) ?? null,
  gene: m.gene === "PD-L1" ? "PDL1" : m.gene,
  status: ["Pathogenic", "Positive"].includes(m.interpretation) ? "detected" : ["Not detected", "Negative"].includes(m.interpretation) ? "not_detected" : "indeterminate",
  alteration: alteration(m.result_text, m.gene, m.interpretation),
  tps: m.gene === "PD-L1" ? Number(m.result_text.match(/score ([0-9.]+)%/)?.[1]) : null,
  assay: m.assay,
  reported_date: m.reported_date,
}));

console.log(`${rows.length} biomarker rows, ${rows.filter((r) => !r.patient_id).length} unmatched`);
// Still missing compared with the USL: the same logic for the other nine tables, type
// checking against a declared schema, data-quality rules and their invalid-record views,
// re-running when a source changes, and making any of this queryable by other tools.
