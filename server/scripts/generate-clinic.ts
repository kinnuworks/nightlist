// Generates the synthetic clinic: an EHR export and a separate lab system for a
// community oncology practice in Montgomery, Alabama. The two systems do not share
// patient ids (EHR uses patient_id + a 7 digit MRN, the lab uses "MRN" + MRN), and
// medications arrive as free-text order strings, the way real exports do.
//
// Distributions follow published NSCLC figures (see docs/DATA.md). Seeded, so every
// run produces the same clinic.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "sources");
const AS_OF = new Date("2026-10-26T00:00:00Z");

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261026);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
function weighted<T>(pairs: [T, number][]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) {
    if ((r -= w) <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}
const normal = (mu: number, sd: number) => {
  const u = 1 - rnd();
  const v = rnd();
  return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(AS_OF.getTime() - n * 86400000);
const round = (x: number, p = 1) => Math.round(x * 10 ** p) / 10 ** p;

const GIVEN_F = ["Dolores", "Gloria", "Earline", "Patricia", "Bernice", "Loretta", "Annie", "Shirley", "Doris", "Mae", "Joyce", "Brenda", "Carolyn", "Linda", "Ruby", "Wanda", "Hattie", "Peggy", "Teresa", "Opal", "Vera", "Denise", "Yolanda", "Marsha", "Cynthia"];
const GIVEN_M = ["Marcus", "Raymond", "James", "Curtis", "Leon", "Harold", "Otis", "Roy", "Willie", "Calvin", "Dwight", "Floyd", "Larry", "Wendell", "Clarence", "Earl", "Gerald", "Lamar", "Terrence", "Vernon", "Russell", "Dale", "Cedric", "Ronnie", "Alvin"];
const FAMILY = ["Whitfield", "Bell", "Haynes", "Oduya", "Pruitt", "Tolliver", "Nunn", "Langford", "Crenshaw", "Dobbins", "Hightower", "Peebles", "McCants", "Gaines", "Strickland", "Abernathy", "Varner", "Calloway", "Hutchins", "Pettway", "Moorer", "Grimes", "Lockhart", "Sanders", "Tarver", "Holloway", "Rucker", "Faulk", "Mims", "Stallworth", "Ingram", "Ledbetter"];

const zips = readFileSync(join(OUT, "geo", "zcta_montgomery_90mi.csv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => {
    const [zip, lat, lon, miles] = l.split(",");
    return { zip, lat: +lat, lon: +lon, miles: +miles };
  });
const nearZips = zips.filter((z) => z.miles <= 30);

type Histology = "adenocarcinoma" | "squamous" | "large_cell" | "nos";
type Stage = "IA" | "IB" | "IIA" | "IIB" | "IIIA" | "IIIB" | "IIIC" | "IVA" | "IVB";
interface Driver { gene: string; alteration: string; text: string }

interface Patient {
  id: string;
  mrn: string;
  given: string;
  family: string;
  sex: "female" | "male";
  birth: Date;
  zip: string;
  histology: Histology;
  stage: Stage;
  dxDate: Date;
  measurable: "Y" | "N" | "";
  ecog: number | null;
  ecogDate: Date | null;
  brainMets: "" | "active" | "treated_stable";
  otherMets: string[];
  // molecular: which genes were tested, and the driver found (if any)
  tested: Set<string>;
  driver: Driver | null;
  pdl1: number | null;
  meds: { text: string; line: number; setting: string; start: Date; end: Date | null }[];
  problems: { icd10: string; text: string }[];
  labs: Partial<Record<LabKey, number>>;
  labsDays: number;
  hero?: string;
}

type LabKey = "ANC" | "PLT" | "HGB" | "CREAT" | "CRCL" | "TBILI" | "AST" | "ALT";
const LAB_META: Record<LabKey, { loinc: string; name: string; unit: string; refHigh: number | null; mu: number; sd: number }> = {
  ANC: { loinc: "751-8", name: "Neutrophils [#/volume] in Blood by Automated count", unit: "10*3/uL", refHigh: 7.5, mu: 4.2, sd: 1.6 },
  PLT: { loinc: "777-3", name: "Platelets [#/volume] in Blood by Automated count", unit: "10*3/uL", refHigh: 400, mu: 245, sd: 70 },
  HGB: { loinc: "718-7", name: "Hemoglobin [Mass/volume] in Blood", unit: "g/dL", refHigh: 17.5, mu: 11.8, sd: 1.6 },
  CREAT: { loinc: "2160-0", name: "Creatinine [Mass/volume] in Serum or Plasma", unit: "mg/dL", refHigh: 1.3, mu: 0.95, sd: 0.25 },
  CRCL: { loinc: "2164-2", name: "Creatinine renal clearance in 24 hour Urine and Serum or Plasma", unit: "mL/min", refHigh: null, mu: 78, sd: 22 },
  TBILI: { loinc: "1975-2", name: "Bilirubin.total [Mass/volume] in Serum or Plasma", unit: "mg/dL", refHigh: 1.2, mu: 0.6, sd: 0.25 },
  AST: { loinc: "1920-8", name: "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma", unit: "U/L", refHigh: 40, mu: 26, sd: 10 },
  ALT: { loinc: "1742-6", name: "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma", unit: "U/L", refHigh: 41, mu: 24, sd: 11 },
};

// Free-text order strings as they appear in medication exports. RxNav resolves them.
const DRUG_TEXT: Record<string, string[]> = {
  pembrolizumab: ["KEYTRUDA 200 MG/8ML IV SOLN", "pembrolizumab 200 mg IV q3w", "Keytruda (pembrolizumab) infusion"],
  nivolumab: ["OPDIVO 240 MG/24ML IV SOLN", "nivolumab 480 mg IV q4w"],
  atezolizumab: ["TECENTRIQ 1200 MG/20ML IV SOLN", "atezolizumab 1200 mg"],
  durvalumab: ["IMFINZI 500 MG/10ML IV SOLN", "durvalumab 10 mg/kg consolidation"],
  ipilimumab: ["YERVOY 50 MG/10ML IV SOLN"],
  carboplatin: ["CARBOplatin 450 MG/45ML IV SOLN", "carboplatin AUC 5 IV"],
  cisplatin: ["CISplatin 50 MG/50ML IV SOLN"],
  pemetrexed: ["ALIMTA 500 MG IV SOLR", "pemetrexed 500 mg/m2"],
  paclitaxel: ["PACLitaxel 300 MG/50ML IV CONC", "nab-paclitaxel (Abraxane) 100 mg/m2"],
  docetaxel: ["DOCEtaxel 80 MG/4ML IV CONC", "docetaxel 75 mg/m2 q3w"],
  osimertinib: ["TAGRISSO 80 MG PO TABS", "osimertinib 80 mg daily"],
  erlotinib: ["TARCEVA 150 MG PO TABS"],
  alectinib: ["ALECENSA 150 MG PO CAPS", "alectinib 600 mg BID"],
  lorlatinib: ["LORBRENA 100 MG PO TABS"],
  sotorasib: ["LUMAKRAS 120 MG PO TABS", "sotorasib 960 mg daily"],
  adagrasib: ["KRAZATI 200 MG PO TABS"],
  capmatinib: ["TABRECTA 200 MG PO TABS"],
  selpercatinib: ["RETEVMO 80 MG PO CAPS"],
  bevacizumab: ["AVASTIN 400 MG/16ML IV SOLN"],
  ramucirumab: ["CYRAMZA 500 MG/50ML IV SOLN"],
  amivantamab: ["RYBREVANT 350 MG/7ML IV SOLN"],
  "trastuzumab deruxtecan": ["ENHERTU 100 MG IV SOLR"],
  dabrafenib: ["TAFINLAR 75 MG PO CAPS"],
};
const drug = (name: string) => pick(DRUG_TEXT[name]);

const PROBLEMS = {
  ild: { icd10: "J84.10", text: "Pulmonary fibrosis, unspecified" },
  pneumonitis: { icd10: "J70.4", text: "Drug-induced interstitial lung disorder (immune pneumonitis, grade 2)" },
  autoimmune_ra: { icd10: "M06.9", text: "Rheumatoid arthritis, unspecified" },
  autoimmune_lupus: { icd10: "M32.9", text: "Systemic lupus erythematosus, unspecified" },
  autoimmune_crohn: { icd10: "K50.90", text: "Crohn's disease, unspecified" },
  hbv: { icd10: "B18.1", text: "Chronic viral hepatitis B" },
  hcv: { icd10: "B18.2", text: "Chronic viral hepatitis C" },
  hiv: { icd10: "B20", text: "HIV disease" },
  chf: { icd10: "I50.22", text: "Chronic systolic heart failure, NYHA class III" },
  prostate: { icd10: "C61", text: "Malignant neoplasm of prostate (on active surveillance)" },
  breast: { icd10: "Z85.3", text: "Personal history of breast cancer (2009, no active treatment)" },
  copd: { icd10: "J44.9", text: "Chronic obstructive pulmonary disease" },
  htn: { icd10: "I10", text: "Essential hypertension" },
  dm: { icd10: "E11.9", text: "Type 2 diabetes mellitus" },
};

const CORE_GENES = ["EGFR", "ALK", "ROS1", "KRAS", "BRAF", "MET", "RET", "ERBB2", "NTRK"];

function driverFor(histology: Histology): Driver | null {
  // Approximate US frequencies in lung adenocarcinoma; much lower in squamous.
  const scale = histology === "squamous" ? 0.12 : histology === "adenocarcinoma" ? 1 : 0.6;
  const r = rnd();
  const table: [number, () => Driver][] = [
    [0.15, () => weighted<Driver>([
      [{ gene: "EGFR", alteration: "exon19del", text: "EGFR c.2235_2249del p.E746_A750del (exon 19 deletion)" }, 45],
      [{ gene: "EGFR", alteration: "L858R", text: "EGFR c.2573T>G p.L858R (exon 21)" }, 40],
      [{ gene: "EGFR", alteration: "exon20ins", text: "EGFR p.A767_V769dup (exon 20 insertion)" }, 10],
      [{ gene: "EGFR", alteration: "other", text: "EGFR p.G719A (exon 18)" }, 5],
    ])],
    [0.04, () => ({ gene: "ALK", alteration: "fusion", text: "EML4-ALK fusion (variant 1) detected" })],
    [0.015, () => ({ gene: "ROS1", alteration: "fusion", text: "CD74-ROS1 fusion detected" })],
    [0.12, () => ({ gene: "KRAS", alteration: "G12C", text: "KRAS c.34G>T p.G12C" })],
    [0.18, () => pick([
      { gene: "KRAS", alteration: "G12V", text: "KRAS c.35G>T p.G12V" },
      { gene: "KRAS", alteration: "G12D", text: "KRAS c.35G>A p.G12D" },
      { gene: "KRAS", alteration: "G13C", text: "KRAS c.37G>T p.G13C" },
    ])],
    [0.02, () => ({ gene: "BRAF", alteration: "V600E", text: "BRAF c.1799T>A p.V600E" })],
    [0.03, () => ({ gene: "MET", alteration: "exon14skip", text: "MET exon 14 skipping (c.3082+1G>T)" })],
    [0.015, () => ({ gene: "RET", alteration: "fusion", text: "KIF5B-RET fusion detected" })],
    [0.02, () => ({ gene: "ERBB2", alteration: "mutation", text: "ERBB2 (HER2) p.Y772_A775dup exon 20 insertion" })],
    [0.003, () => ({ gene: "NTRK", alteration: "fusion", text: "ETV6-NTRK3 fusion detected" })],
  ];
  let acc = 0;
  for (const [p, make] of table) {
    acc += p * scale;
    if (r < acc) return make();
  }
  return null;
}

function makePatient(i: number): Patient {
  const sex = rnd() < 0.5 ? "female" : "male";
  const age = Math.max(38, Math.min(89, Math.round(normal(67, 9))));
  const birth = new Date(Date.UTC(AS_OF.getUTCFullYear() - age, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27)));
  const histology = weighted<Histology>([["adenocarcinoma", 60], ["squamous", 25], ["large_cell", 5], ["nos", 10]]);
  const stage = weighted<Stage>([["IA", 6], ["IB", 5], ["IIA", 5], ["IIB", 7], ["IIIA", 10], ["IIIB", 9], ["IIIC", 6], ["IVA", 24], ["IVB", 28]]);
  const metastatic = stage.startsWith("IV");
  const dxDate = daysAgo(Math.floor(rnd() * (metastatic ? 700 : 400)) + 20);
  const ecog = rnd() < 0.08 ? null : weighted([[0, 25], [1, 45], [2, 20], [3, 10]]);
  const ecogDate = ecog === null ? null : daysAgo(Math.floor(rnd() * 70));

  // Biomarker testing is incomplete in community practice: only about half of
  // patients have every core gene tested (MYLUNG cohort).
  const tested = new Set<string>();
  const testedMode = weighted([["full", 46], ["partial", 34], ["none", 20]]);
  if (testedMode === "full") CORE_GENES.forEach((g) => tested.add(g));
  if (testedMode === "partial") ["EGFR", "ALK", ...CORE_GENES.filter(() => rnd() < 0.4)].forEach((g) => tested.add(g));
  let driver = testedMode === "none" ? null : driverFor(histology);
  if (driver && !tested.has(driver.gene)) driver = null;
  const pdl1 = rnd() < 0.18 ? null : weighted([[0, 30], [round(1 + rnd() * 48, 0), 35], [round(50 + rnd() * 45, 0), 35]]);

  const brainMets = metastatic && rnd() < 0.25 ? (rnd() < 0.4 ? "active" : "treated_stable") : "";
  const otherMets = metastatic ? ["bone", "liver", "adrenal", "contralateral lung", "pleura"].filter(() => rnd() < 0.3) : [];

  const meds: Patient["meds"] = [];
  const addLine = (line: number, names: string[], monthsAgo: number, months: number, setting = "metastatic") => {
    const start = daysAgo(monthsAgo * 30);
    const end = months > 0 && monthsAgo - months > 0 ? daysAgo((monthsAgo - months) * 30) : null;
    names.forEach((n) => meds.push({ text: drug(n), line, setting, start, end }));
  };
  if (metastatic && rnd() < 0.78) {
    const g = driver?.gene;
    if (g === "EGFR" && driver!.alteration !== "exon20ins") {
      addLine(1, ["osimertinib"], 18, 14);
      if (rnd() < 0.5) addLine(2, ["carboplatin", "pemetrexed"], 4, 0);
    } else if (g === "ALK") {
      addLine(1, [pick(["alectinib", "lorlatinib"])], 20, 0);
    } else if (g === "KRAS" && driver!.alteration === "G12C") {
      addLine(1, ["pembrolizumab", "carboplatin", "pemetrexed"], 14, 8);
      if (rnd() < 0.4) addLine(2, [pick(["sotorasib", "adagrasib"])], 5, 0);
    } else if (g === "MET") {
      addLine(1, ["capmatinib"], 10, 0);
    } else if (g === "RET") {
      addLine(1, ["selpercatinib"], 9, 0);
    } else {
      const first = histology === "squamous" ? ["pembrolizumab", "carboplatin", "paclitaxel"] : ["pembrolizumab", "carboplatin", "pemetrexed"];
      addLine(1, pdl1 !== null && pdl1 >= 50 && rnd() < 0.5 ? ["pembrolizumab"] : first, 12, 7);
      if (rnd() < 0.45) addLine(2, rnd() < 0.5 ? ["docetaxel", "ramucirumab"] : ["docetaxel"], 4, 0);
    }
  } else if (stage.startsWith("III") && rnd() < 0.6) {
    addLine(0, ["carboplatin", "paclitaxel"], 9, 2, "chemoradiation");
    addLine(0, ["durvalumab"], 7, 0, "consolidation");
  }

  const problems: Patient["problems"] = [];
  const maybe = (p: number, key: keyof typeof PROBLEMS) => rnd() < p && problems.push(PROBLEMS[key]);
  maybe(0.04, "ild");
  if (meds.some((m) => /KEYTRUDA|pembro|OPDIVO|nivolumab|TECENTRIQ|IMFINZI/i.test(m.text))) maybe(0.05, "pneumonitis");
  maybe(0.03, "autoimmune_ra");
  maybe(0.015, "autoimmune_lupus");
  maybe(0.015, "autoimmune_crohn");
  maybe(0.02, "hbv");
  maybe(0.02, "hcv");
  maybe(0.01, "hiv");
  maybe(0.06, "chf");
  if (sex === "male") maybe(0.05, "prostate");
  else maybe(0.05, "breast");
  maybe(0.45, "copd");
  maybe(0.55, "htn");
  maybe(0.25, "dm");

  const labs: Patient["labs"] = {};
  for (const k of Object.keys(LAB_META) as LabKey[]) {
    if (rnd() < 0.07) continue;
    const m = LAB_META[k];
    let v = Math.max(0.05, normal(m.mu, m.sd));
    if (k === "ANC" && rnd() < 0.06) v = 0.9 + rnd() * 0.5;
    if (k === "PLT" && rnd() < 0.05) v = 60 + rnd() * 35;
    if ((k === "AST" || k === "ALT") && rnd() < 0.05) v = m.refHigh! * (2.6 + rnd() * 2);
    labs[k] = round(v, k === "PLT" || k === "CRCL" || k === "AST" || k === "ALT" ? 0 : k === "CREAT" || k === "TBILI" ? 2 : 1);
  }

  const z = rnd() < 0.7 ? pick(nearZips) : pick(zips);
  return {
    id: `P${String(1000 + i).padStart(5, "0")}`,
    mrn: String(4100000 + Math.floor(rnd() * 899999)).padStart(7, "0"),
    given: sex === "female" ? pick(GIVEN_F) : pick(GIVEN_M),
    family: pick(FAMILY),
    sex,
    birth,
    zip: z.zip,
    histology,
    stage,
    dxDate,
    measurable: metastatic || stage.startsWith("III") ? (rnd() < 0.85 ? "Y" : rnd() < 0.5 ? "N" : "") : rnd() < 0.3 ? "Y" : "",
    ecog,
    ecogDate,
    brainMets,
    otherMets,
    tested,
    driver,
    pdl1,
    meds,
    problems,
    labs,
    labsDays: Math.floor(rnd() * 45),
  };
}

// Hand-written patients whose stories the demo follows. Everything else is random.
function heroes(start: number): Patient[] {
  const base = (i: number, o: Partial<Patient>): Patient => {
    const p = makePatient(start + i);
    return { ...p, ...o, tested: o.tested ?? new Set(CORE_GENES) };
  };
  const all = new Set(CORE_GENES);
  return [
    base(0, {
      hero: "EGFR exon 19 deletion, progressed on osimertinib",
      given: "Dolores", family: "Whitfield", sex: "female", birth: new Date("1955-03-14"), zip: "36106",
      histology: "adenocarcinoma", stage: "IVB", measurable: "Y", ecog: 1, ecogDate: daysAgo(9), brainMets: "", otherMets: ["bone"],
      tested: all, driver: { gene: "EGFR", alteration: "exon19del", text: "EGFR c.2235_2249del p.E746_A750del (exon 19 deletion)" }, pdl1: 5,
      meds: [{ text: "TAGRISSO 80 MG PO TABS", line: 1, setting: "metastatic", start: daysAgo(560), end: daysAgo(21) }],
      problems: [PROBLEMS.htn], labs: { ANC: 3.9, PLT: 211, HGB: 12.1, CREAT: 0.8, CRCL: 71, TBILI: 0.5, AST: 22, ALT: 19 }, labsDays: 6,
    }),
    base(1, {
      hero: "KRAS G12C after chemo-immunotherapy",
      given: "Marcus", family: "Bell", sex: "male", birth: new Date("1962-08-02"), zip: "36117",
      histology: "adenocarcinoma", stage: "IVA", measurable: "Y", ecog: 1, ecogDate: daysAgo(14), brainMets: "", otherMets: ["adrenal"],
      tested: all, driver: { gene: "KRAS", alteration: "G12C", text: "KRAS c.34G>T p.G12C" }, pdl1: 20,
      meds: [
        { text: "KEYTRUDA 200 MG/8ML IV SOLN", line: 1, setting: "metastatic", start: daysAgo(380), end: daysAgo(40) },
        { text: "carboplatin AUC 5 IV", line: 1, setting: "metastatic", start: daysAgo(380), end: daysAgo(290) },
        { text: "ALIMTA 500 MG IV SOLR", line: 1, setting: "metastatic", start: daysAgo(380), end: daysAgo(40) },
      ],
      problems: [PROBLEMS.copd], labs: { ANC: 4.6, PLT: 260, HGB: 11.4, CREAT: 1.0, CRCL: 82, TBILI: 0.7, AST: 30, ALT: 28 }, labsDays: 3,
    }),
    base(2, {
      hero: "No molecular testing on file at first; NGS results arrive on night 2 of the demo",
      given: "Gloria", family: "Haynes", sex: "female", birth: new Date("1968-11-20"), zip: "36104",
      histology: "adenocarcinoma", stage: "IVA", measurable: "Y", ecog: 0, ecogDate: daysAgo(5), brainMets: "", otherMets: ["pleura"],
      tested: new Set(), driver: null, pdl1: null, meds: [],
      problems: [], labs: { ANC: 5.1, PLT: 300, HGB: 12.9, CREAT: 0.7, CRCL: 95, TBILI: 0.4, AST: 18, ALT: 15 }, labsDays: 2,
    }),
    base(3, {
      hero: "Squamous, PD-L1 60%, treatment-naive",
      given: "Raymond", family: "Oduya", sex: "male", birth: new Date("1957-01-09"), zip: "36066",
      histology: "squamous", stage: "IVB", measurable: "Y", ecog: 0, ecogDate: daysAgo(4), brainMets: "", otherMets: ["liver"],
      tested: new Set(["EGFR", "ALK", "ROS1", "KRAS"]), driver: null, pdl1: 60, meds: [],
      problems: [PROBLEMS.copd, PROBLEMS.htn], labs: { ANC: 6.0, PLT: 330, HGB: 13.2, CREAT: 1.1, CRCL: 68, TBILI: 0.8, AST: 25, ALT: 31 }, labsDays: 8,
    }),
    base(4, {
      hero: "ALK fusion with active brain metastases",
      given: "Earline", family: "Pruitt", sex: "female", birth: new Date("1951-06-30"), zip: "36092",
      histology: "adenocarcinoma", stage: "IVB", measurable: "Y", ecog: 1, ecogDate: daysAgo(11), brainMets: "active", otherMets: ["bone"],
      tested: all, driver: { gene: "ALK", alteration: "fusion", text: "EML4-ALK fusion (variant 1) detected" }, pdl1: 0,
      meds: [{ text: "ALECENSA 150 MG PO CAPS", line: 1, setting: "metastatic", start: daysAgo(610), end: daysAgo(30) }],
      problems: [PROBLEMS.dm], labs: { ANC: 3.3, PLT: 198, HGB: 11.0, CREAT: 0.9, CRCL: 60, TBILI: 0.6, AST: 27, ALT: 22 }, labsDays: 10,
    }),
    base(5, {
      hero: "Low neutrophil count blocks most trials",
      given: "James", family: "Tolliver", sex: "male", birth: new Date("1960-04-17"), zip: "36109",
      histology: "adenocarcinoma", stage: "IVA", measurable: "Y", ecog: 1, ecogDate: daysAgo(6), brainMets: "", otherMets: [],
      tested: all, driver: null, pdl1: 35,
      meds: [
        { text: "pembrolizumab 200 mg IV q3w", line: 1, setting: "metastatic", start: daysAgo(300), end: daysAgo(60) },
        { text: "CARBOplatin 450 MG/45ML IV SOLN", line: 1, setting: "metastatic", start: daysAgo(300), end: daysAgo(210) },
        { text: "pemetrexed 500 mg/m2", line: 1, setting: "metastatic", start: daysAgo(300), end: daysAgo(60) },
        { text: "docetaxel 75 mg/m2 q3w", line: 2, setting: "metastatic", start: daysAgo(45), end: null },
      ],
      problems: [PROBLEMS.htn], labs: { ANC: 1.1, PLT: 140, HGB: 9.6, CREAT: 1.0, CRCL: 74, TBILI: 0.6, AST: 24, ALT: 20 }, labsDays: 2,
    }),
    base(6, {
      hero: "MET exon 14 with chronic hepatitis B",
      given: "Patricia", family: "Nunn", sex: "female", birth: new Date("1964-09-03"), zip: "36116",
      histology: "adenocarcinoma", stage: "IVA", measurable: "Y", ecog: 1, ecogDate: daysAgo(20), brainMets: "", otherMets: ["bone"],
      tested: all, driver: { gene: "MET", alteration: "exon14skip", text: "MET exon 14 skipping (c.3082+1G>T)" }, pdl1: 70,
      meds: [{ text: "TABRECTA 200 MG PO TABS", line: 1, setting: "metastatic", start: daysAgo(240), end: daysAgo(14) }],
      problems: [PROBLEMS.hbv], labs: { ANC: 4.0, PLT: 180, HGB: 12.4, CREAT: 0.8, CRCL: 79, TBILI: 0.9, AST: 38, ALT: 44 }, labsDays: 12,
    }),
    base(7, {
      hero: "RET fusion, first line",
      given: "Curtis", family: "Langford", sex: "male", birth: new Date("1974-02-25"), zip: "36111",
      histology: "adenocarcinoma", stage: "IVB", measurable: "Y", ecog: 0, ecogDate: daysAgo(3), brainMets: "treated_stable", otherMets: ["liver"],
      tested: all, driver: { gene: "RET", alteration: "fusion", text: "KIF5B-RET fusion detected" }, pdl1: 10, meds: [],
      problems: [], labs: { ANC: 5.5, PLT: 275, HGB: 13.8, CREAT: 0.9, CRCL: 104, TBILI: 0.5, AST: 21, ALT: 26 }, labsDays: 4,
    }),
  ];
}

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
function write(rel: string, rows: Record<string, unknown>[]) {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv(rows));
  console.log(`${rel}: ${rows.length} rows`);
}

const STAGE_TEXT: Record<Stage, string> = {
  IA: "Stage IA (cT1b cN0 cM0)", IB: "Stage IB (cT2a cN0 cM0)", IIA: "Stage IIA (cT2b cN0 cM0)", IIB: "Stage IIB (cT3 cN0 cM0)",
  IIIA: "Stage IIIA (cT1c cN2 cM0)", IIIB: "Stage IIIB (cT3 cN2 cM0)", IIIC: "Stage IIIC (cT4 cN3 cM0)",
  IVA: "Stage IVA (cT2a cN2 cM1b)", IVB: "Stage IVB (cT3 cN3 cM1c)",
};
const HIST_TEXT: Record<Histology, string[]> = {
  adenocarcinoma: ["Adenocarcinoma of right upper lobe of lung", "Lung adenocarcinoma, left lower lobe", "Non-small cell lung carcinoma, adenocarcinoma subtype"],
  squamous: ["Squamous cell carcinoma of right lower lobe of lung", "Squamous cell carcinoma, left main bronchus"],
  large_cell: ["Large cell carcinoma of lung"],
  nos: ["Non-small cell lung cancer, not otherwise specified", "Malignant neoplasm of upper lobe, right bronchus or lung"],
};
const ICD_FOR: Record<Histology, string> = { adenocarcinoma: "C34.11", squamous: "C34.31", large_cell: "C34.90", nos: "C34.90" };

function main() {
  const randomCount = 232;
  const patients = [...heroes(0), ...Array.from({ length: randomCount }, (_, i) => makePatient(100 + i))];
  // Unique MRNs
  const seen = new Set<string>();
  for (const p of patients) {
    while (seen.has(p.mrn)) p.mrn = String(+p.mrn + 1).padStart(7, "0");
    seen.add(p.mrn);
  }
  patients.forEach((p, i) => (p.id = `P${String(10001 + i)}`));

  write("ehr/patients.csv", patients.map((p) => ({
    patient_id: p.id, mrn: p.mrn, given_name: p.given, family_name: p.family, sex: p.sex,
    birth_date: iso(p.birth), zip: p.zip, demo_story: p.hero ?? "",
  })));
  write("ehr/diagnoses.csv", patients.map((p, i) => ({
    dx_id: `DX${30001 + i}`, patient_id: p.id, icd10: ICD_FOR[p.histology], diagnosis_text: pick(HIST_TEXT[p.histology]),
    stage_text: STAGE_TEXT[p.stage], diagnosis_date: iso(p.dxDate), measurable_disease: p.measurable,
  })));
  let metId = 50001;
  write("ehr/metastases.csv", patients.flatMap((p) => [
    ...(p.brainMets ? [{ met_id: `M${metId++}`, patient_id: p.id, site: "brain", status: p.brainMets, noted_date: iso(daysAgo(30 + Math.floor(rnd() * 200))) }] : []),
    ...p.otherMets.map((s) => ({ met_id: `M${metId++}`, patient_id: p.id, site: s, status: "active", noted_date: iso(daysAgo(30 + Math.floor(rnd() * 200))) })),
  ]));
  let medId = 70001;
  write("ehr/medications.csv", patients.flatMap((p) => p.meds.map((m) => ({
    med_order_id: `RX${medId++}`, patient_id: p.id, order_text: m.text, line_of_therapy: m.line, setting: m.setting,
    start_date: iso(m.start), end_date: m.end ? iso(m.end) : "",
  }))));
  let probId = 90001;
  write("ehr/problems.csv", patients.flatMap((p) => p.problems.map((pr) => ({
    problem_id: `PL${probId++}`, patient_id: p.id, icd10: pr.icd10, description: pr.text, status: "active",
  }))));
  write("ehr/ecog.csv", patients.filter((p) => p.ecog !== null).map((p) => ({
    patient_id: p.id, ecog_score: p.ecog, recorded_date: iso(p.ecogDate!),
  })));

  // Lab system: its own accession numbers and MRN format.
  let acc = 1;
  const labRows: Record<string, unknown>[] = [];
  for (const p of patients) {
    const collected = daysAgo(p.labsDays);
    for (const [k, v] of Object.entries(p.labs) as [LabKey, number][]) {
      const m = LAB_META[k];
      labRows.push({
        accession: `L26-${String(acc++).padStart(6, "0")}`, patient_mrn: `MRN${p.mrn}`, loinc: m.loinc, test_name: m.name,
        value: v, unit: m.unit, ref_high: m.refHigh ?? "", collected_at: `${iso(collected)}T07:${String(10 + (acc % 49)).padStart(2, "0")}:00`,
      });
    }
  }
  // Real interface seams the semantic layer's DQ rules should catch: results filed
  // under a mistyped MRN, and results the analyzer exported without a unit.
  for (let k = 0; k < 6; k++) {
    const p = pick(patients);
    const m = LAB_META[pick(Object.keys(LAB_META) as LabKey[])];
    labRows.push({
      accession: `L26-${String(acc++).padStart(6, "0")}`, patient_mrn: `MRN${p.mrn.slice(0, 5)}${p.mrn.slice(6)}${p.mrn[5]}`,
      loinc: m.loinc, test_name: m.name, value: round(m.mu, 1), unit: m.unit, ref_high: m.refHigh ?? "", collected_at: `${iso(daysAgo(3))}T08:00:00`,
    });
  }
  labRows.filter((_, i) => i % 211 === 17).forEach((r) => (r.unit = ""));
  write("lab/results.csv", labRows);

  const molRows: Record<string, unknown>[] = [];
  let rep = 1;
  for (const p of patients) {
    const reported = iso(daysAgo(Math.floor((AS_OF.getTime() - p.dxDate.getTime()) / 86400000) - 14));
    const assay = rnd() < 0.6 ? "Tissue NGS panel (FoundationOne CDx)" : "Plasma ctDNA panel (Guardant360 CDx)";
    for (const g of CORE_GENES) {
      if (!p.tested.has(g)) continue;
      const hit = p.driver?.gene === g;
      molRows.push({
        report_id: `MOL-${String(rep).padStart(5, "0")}`, patient_mrn: `MRN${p.mrn}`, gene: g,
        result_text: hit ? p.driver!.text : "No pathogenic variant detected",
        interpretation: hit ? "Pathogenic" : "Not detected", assay, reported_date: reported,
      });
    }
    rep++;
    if (p.pdl1 !== null) {
      molRows.push({
        report_id: `IHC-${String(rep++).padStart(5, "0")}`, patient_mrn: `MRN${p.mrn}`, gene: "PD-L1",
        result_text: `PD-L1 (22C3) tumor proportion score ${p.pdl1}%`, interpretation: p.pdl1 >= 1 ? "Positive" : "Negative",
        assay: "PD-L1 IHC 22C3 pharmDx", reported_date: reported,
      });
    }
  }
  write("lab/molecular.csv", molRows);

  writeFileSync(join(OUT, "clinic.json"), JSON.stringify({
    name: "River Region Cancer Care (fictional practice)",
    city: "Montgomery, AL", lat: 32.3668, lon: -86.3, asOf: iso(AS_OF), patients: patients.length,
  }, null, 2));
}

main();
