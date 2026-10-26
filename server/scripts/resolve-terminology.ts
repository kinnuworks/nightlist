// Resolves free-text medication orders through RxNav (order text -> RxCUI ->
// ingredient -> ATC class) and histology terms through the NCI Thesaurus (EVS).
// Results are written as small reference tables that the semantic layer joins on.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "data", "sources");
const RXNAV = "https://rxnav.nlm.nih.gov/REST";
const EVS = "https://api-evsrest.nci.nih.gov/api/v1/concept/ncit";

// Nightlist therapy classes, keyed by ATC code prefix, then by ingredient where ATC
// is too coarse (several PD-1 agents share L01FF, platinum agents share L01XA).
const ATC_CLASS: [string, string][] = [
  ["L01FF", "PD1_PDL1"],
  ["L01FX04", "CTLA4"],
  ["L01XA", "PLATINUM"],
  ["L01BA04", "PEMETREXED"],
  ["L01CD", "TAXANE"],
  ["L01EB", "EGFR_TKI"],
  ["L01ED", "ALK_TKI"],
  ["L01XX73", "KRAS_G12C"],
  ["L01XX72", "KRAS_G12C"],
  ["L01EX17", "MET_TKI"],
  ["L01EX22", "RET_TKI"],
  ["L01FG", "ANTI_VEGF"],
  ["L01FX16", "EGFR_MET_BISPECIFIC"],
  ["L01FD04", "ADC"],
  ["L01EC02", "BRAF_TKI"],
];
const INGREDIENT_CLASS: Record<string, string> = {
  pembrolizumab: "PD1_PDL1", nivolumab: "PD1_PDL1", atezolizumab: "PD1_PDL1", durvalumab: "PD1_PDL1", ipilimumab: "CTLA4",
  carboplatin: "PLATINUM", cisplatin: "PLATINUM", pemetrexed: "PEMETREXED", paclitaxel: "TAXANE", docetaxel: "TAXANE",
  osimertinib: "EGFR_TKI", erlotinib: "EGFR_TKI", alectinib: "ALK_TKI", lorlatinib: "ALK_TKI", sotorasib: "KRAS_G12C",
  adagrasib: "KRAS_G12C", capmatinib: "MET_TKI", selpercatinib: "RET_TKI", bevacizumab: "ANTI_VEGF", ramucirumab: "ANTI_VEGF",
  amivantamab: "EGFR_MET_BISPECIFIC", "fam-trastuzumab deruxtecan": "ADC", "trastuzumab deruxtecan": "ADC", dabrafenib: "BRAF_TKI",
};

async function getJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) {
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`rate limited: ${url}`);
}

function cleanOrder(text: string): string {
  // Brand names in parentheses carry the generic; dose strings confuse approximate match.
  const paren = text.match(/\(([^)]+)\)/);
  const base = paren && !/\d/.test(paren[1]) ? paren[1] : text;
  return base.replace(/\b\d[\d.,/]*\s*(MG|MG\/ML|ML|AUC|MG\/M2|MG\/KG)?\b.*$/i, "").replace(/nab-/i, "").trim();
}

async function resolveOrder(text: string) {
  const term = cleanOrder(text);
  const approx = await getJson(`${RXNAV}/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=1`);
  const cand = approx?.approximateGroup?.candidate?.[0];
  if (!cand) return { order_text: text, query_term: term, rxcui: "", ingredient: "", atc_code: "", atc_name: "", therapy_class: "UNRESOLVED" };
  const related = await getJson(`${RXNAV}/rxcui/${cand.rxcui}/related.json?tty=IN`);
  const ingredient = related?.relatedGroup?.conceptGroup?.flatMap((g: any) => g.conceptProperties ?? [])?.[0];
  const inRxcui = ingredient?.rxcui ?? cand.rxcui;
  const inName = (ingredient?.name ?? term).toLowerCase();
  const cls = await getJson(`${RXNAV}/rxclass/class/byRxcui.json?rxcui=${inRxcui}&relaSource=ATC`);
  const atc = cls?.rxclassDrugInfoList?.rxclassDrugInfo?.[0]?.rxclassMinConceptItem;
  const atcCode = atc?.classId ?? "";
  const therapyClass =
    INGREDIENT_CLASS[inName] ?? ATC_CLASS.find(([prefix]) => atcCode.startsWith(prefix))?.[1] ?? "OTHER_ANTINEOPLASTIC";
  return { order_text: text, query_term: term, rxcui: inRxcui, ingredient: inName, atc_code: atcCode, atc_name: atc?.className ?? "", therapy_class: therapyClass };
}

function readCsvColumn(path: string, column: string): string[] {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const idx = head.split(",").indexOf(column);
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    return cells[idx];
  });
}

const toCsv = (rows: Record<string, string>[]) => {
  const cols = Object.keys(rows[0]);
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(String(r[c] ?? ""))).join(","))].join("\n") + "\n";
};

async function main() {
  const orders = [...new Set(readCsvColumn(join(SRC, "ehr", "medications.csv"), "order_text"))].sort();
  const rows = [];
  for (const o of orders) {
    const row = await resolveOrder(o);
    console.log(`${row.therapy_class.padEnd(20)} ${row.rxcui.padEnd(8)} ${row.ingredient.padEnd(24)} <- ${o}`);
    rows.push(row);
    await new Promise((ok) => setTimeout(ok, 120));
  }
  mkdirSync(join(SRC, "rxnav"), { recursive: true });
  writeFileSync(join(SRC, "rxnav", "medication_map.csv"), toCsv(rows));

  const NCIT: [string, string][] = [
    ["C2926", "nsclc"],
    ["C3512", "adenocarcinoma"],
    ["C3493", "squamous"],
    ["C4450", "large_cell"],
  ];
  const ncit = [];
  for (const [code, key] of NCIT) {
    const c = await getJson(`${EVS}/${code}?include=summary`);
    ncit.push({ ncit_code: code, histology_key: key, preferred_name: c.name ?? "", ncit_version: c.version ?? "" });
    console.log(`${code} ${c.name}`);
  }
  mkdirSync(join(SRC, "nci"), { recursive: true });
  writeFileSync(join(SRC, "nci", "histology_ncit.csv"), toCsv(ncit));
}

main();
