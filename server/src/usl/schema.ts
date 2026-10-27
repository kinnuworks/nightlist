// The Unified Semantic Layer for trial matching. The same DDL is compiled into Zetaris
// (COMPILE USL ... DEPLOY) and the same activation SELECTs bind each USL table to the
// fragmented sources. In sample mode the identical SELECTs run in DuckDB.

export interface SourceNames {
  patients: string;
  diagnoses: string;
  metastases: string;
  medications: string;
  problems: string;
  ecog: string;
  labResults: string;
  molecular: string;
  rxnavMap: string;
  ncitHistology: string;
  zcta: string;
  trials: string;
  sites: string;
  criteria: string;
}

export interface Dialect {
  name: "duckdb" | "zetaris";
  ageYears(col: string, asOf: string): string;
  miles(lat1: string, lon1: string, lat2: string, lon2: string): string;
}

const haversine = (lat1: string, lon1: string, lat2: string, lon2: string) =>
  `(3958.8 * 2 * ASIN(SQRT(POWER(SIN(RADIANS(${lat2} - ${lat1}) / 2), 2) + COS(RADIANS(${lat1})) * COS(RADIANS(${lat2})) * POWER(SIN(RADIANS(${lon2} - ${lon1}) / 2), 2))))`;

export const duckdb: Dialect = {
  name: "duckdb",
  ageYears: (c, asOf) => `CAST(FLOOR(datediff('day', CAST(${c} AS DATE), DATE '${asOf}') / 365.25) AS INTEGER)`,
  miles: haversine,
};

export const zetaris: Dialect = {
  name: "zetaris",
  ageYears: (c, asOf) => `CAST(FLOOR(datediff(DATE '${asOf}', CAST(${c} AS DATE)) / 365.25) AS INT)`,
  miles: haversine,
};

export const USL_TABLES = [
  "patient",
  "diagnosis",
  "metastasis",
  "biomarker",
  "lab",
  "therapy",
  "condition",
  "trial",
  "site",
  "criterion",
] as const;
export type UslTable = (typeof USL_TABLES)[number];

export const USL_DDL: Record<UslTable, string> = {
  patient: `CREATE TABLE patient (
  patient_id varchar(16) NOT NULL PRIMARY KEY,
  mrn varchar(16),
  given_name varchar(64),
  family_name varchar(64),
  sex varchar(8),
  birth_date date,
  age_years int,
  zip varchar(5),
  lat double,
  lon double,
  miles_to_clinic double,
  ecog int,
  ecog_date date,
  demo_story varchar(200)
)`,
  diagnosis: `CREATE TABLE diagnosis (
  dx_id varchar(16) NOT NULL PRIMARY KEY,
  patient_id varchar(16) NOT NULL FOREIGN KEY REFERENCES patient(patient_id),
  icd10 varchar(10),
  diagnosis_text varchar(200),
  histology varchar(20),
  histology_ncit varchar(10),
  stage varchar(6),
  stage_group varchar(4),
  metastatic boolean,
  measurable_disease varchar(1),
  diagnosis_date date
)`,
  metastasis: `CREATE TABLE metastasis (
  met_id varchar(16) NOT NULL PRIMARY KEY,
  patient_id varchar(16) NOT NULL FOREIGN KEY REFERENCES patient(patient_id),
  site varchar(40),
  status varchar(20),
  noted_date date
)`,
  biomarker: `CREATE TABLE biomarker (
  result_key varchar(40) NOT NULL PRIMARY KEY,
  patient_id varchar(16) FOREIGN KEY REFERENCES patient(patient_id),
  lab_mrn varchar(16),
  gene varchar(10),
  status varchar(16),
  alteration varchar(20),
  tps double,
  result_text varchar(200),
  assay varchar(80),
  reported_date date
)`,
  lab: `CREATE TABLE lab (
  accession varchar(16) NOT NULL PRIMARY KEY,
  patient_id varchar(16) FOREIGN KEY REFERENCES patient(patient_id),
  lab_mrn varchar(16),
  loinc varchar(10),
  analyte varchar(8),
  value double,
  unit varchar(16),
  uln double,
  collected_date date
)`,
  therapy: `CREATE TABLE therapy (
  med_order_id varchar(16) NOT NULL PRIMARY KEY,
  patient_id varchar(16) NOT NULL FOREIGN KEY REFERENCES patient(patient_id),
  order_text varchar(120),
  rxcui varchar(12),
  ingredient varchar(60),
  atc_code varchar(10),
  therapy_class varchar(24),
  line_of_therapy int,
  setting varchar(20),
  start_date date,
  end_date date
)`,
  condition: `CREATE TABLE condition (
  problem_id varchar(16) NOT NULL PRIMARY KEY,
  patient_id varchar(16) NOT NULL FOREIGN KEY REFERENCES patient(patient_id),
  icd10 varchar(10),
  description varchar(200),
  category varchar(24)
)`,
  trial: `CREATE TABLE trial (
  nct_id varchar(12) NOT NULL PRIMARY KEY,
  title varchar(400),
  phase varchar(40),
  overall_status varchar(24),
  sponsor varchar(200),
  last_update date,
  min_age int,
  max_age int,
  sex varchar(8),
  criteria_hash varchar(16),
  nearest_site_miles double
)`,
  site: `CREATE TABLE site (
  site_id varchar(24) NOT NULL PRIMARY KEY,
  nct_id varchar(12) NOT NULL FOREIGN KEY REFERENCES trial(nct_id),
  facility varchar(200),
  city varchar(80),
  state varchar(40),
  zip varchar(10),
  lat double,
  lon double,
  miles_to_clinic double
)`,
  criterion: `CREATE TABLE criterion (
  criterion_id varchar(24) NOT NULL PRIMARY KEY,
  nct_id varchar(12) NOT NULL FOREIGN KEY REFERENCES trial(nct_id),
  kind varchar(10),
  ordinal int,
  text varchar(2000),
  category varchar(16),
  method varchar(12),
  check_status varchar(12),
  compiled_json varchar(4000)
)`,
};

// Activation queries: how each USL table is assembled from the raw sources. This is
// where the fragmentation is resolved (lab MRN format, free-text medication orders,
// free-text histology and stage, molecular report wording).
export function activation(s: SourceNames, d: Dialect, asOf: string, clinic: { lat: number; lon: number }): Record<UslTable, string> {
  const histology = `CASE
      WHEN LOWER(dx.diagnosis_text) LIKE '%adenocarcinoma%' THEN 'adenocarcinoma'
      WHEN LOWER(dx.diagnosis_text) LIKE '%squamous%' THEN 'squamous'
      WHEN LOWER(dx.diagnosis_text) LIKE '%large cell%' THEN 'large_cell'
      ELSE 'nos' END`;
  const stage = `regexp_extract(dx.stage_text, 'Stage (I{1,3}V?[ABC]?|IV[AB]?)', 1)`;
  return {
    patient: `SELECT p.patient_id, p.mrn, p.given_name, p.family_name, p.sex,
  CAST(p.birth_date AS DATE) AS birth_date,
  ${d.ageYears("p.birth_date", asOf)} AS age_years,
  LPAD(CAST(p.zip AS VARCHAR(5)), 5, '0') AS zip, CAST(z.lat AS DOUBLE) AS lat, CAST(z.lon AS DOUBLE) AS lon,
  ${d.miles("CAST(z.lat AS DOUBLE)", "CAST(z.lon AS DOUBLE)", String(clinic.lat), String(clinic.lon))} AS miles_to_clinic,
  CAST(e.ecog_score AS INT) AS ecog, CAST(e.recorded_date AS DATE) AS ecog_date,
  p.demo_story
FROM ${s.patients} p
LEFT JOIN ${s.zcta} z ON LPAD(CAST(z.zip AS VARCHAR(5)), 5, '0') = LPAD(CAST(p.zip AS VARCHAR(5)), 5, '0')
LEFT JOIN ${s.ecog} e ON e.patient_id = p.patient_id`,

    diagnosis: `SELECT dx.dx_id, dx.patient_id, dx.icd10, dx.diagnosis_text,
  ${histology} AS histology,
  n.ncit_code AS histology_ncit,
  ${stage} AS stage,
  CASE WHEN ${stage} LIKE 'IV%' THEN 'IV' WHEN ${stage} LIKE 'III%' THEN 'III' WHEN ${stage} LIKE 'II%' THEN 'II' WHEN ${stage} LIKE 'I%' THEN 'I' END AS stage_group,
  ${stage} LIKE 'IV%' AS metastatic,
  CAST(dx.measurable_disease AS VARCHAR(1)) AS measurable_disease,
  CAST(dx.diagnosis_date AS DATE) AS diagnosis_date
FROM ${s.diagnoses} dx
LEFT JOIN ${s.ncitHistology} n ON n.histology_key = ${histology}`,

    metastasis: `SELECT m.met_id, m.patient_id, m.site, m.status, CAST(m.noted_date AS DATE) AS noted_date FROM ${s.metastases} m`,

    biomarker: `SELECT CONCAT(m.report_id, '-', m.gene) AS result_key, p.patient_id, m.patient_mrn AS lab_mrn,
  CASE WHEN m.gene = 'PD-L1' THEN 'PDL1' ELSE m.gene END AS gene,
  CASE WHEN m.interpretation IN ('Pathogenic', 'Positive') THEN 'detected'
       WHEN m.interpretation IN ('Not detected', 'Negative') THEN 'not_detected'
       ELSE 'indeterminate' END AS status,
  CASE
    WHEN m.result_text LIKE '%exon 19 deletion%' THEN 'exon19del'
    WHEN m.result_text LIKE '%L858R%' THEN 'L858R'
    WHEN m.result_text LIKE '%exon 20 insertion%' AND m.gene = 'EGFR' THEN 'exon20ins'
    WHEN m.result_text LIKE '%G12C%' THEN 'G12C'
    WHEN m.result_text LIKE '%G12D%' THEN 'G12D'
    WHEN m.result_text LIKE '%G12V%' THEN 'G12V'
    WHEN m.result_text LIKE '%G13C%' THEN 'G13C'
    WHEN m.result_text LIKE '%V600E%' THEN 'V600E'
    WHEN m.result_text LIKE '%exon 14%' THEN 'exon14skip'
    WHEN m.result_text LIKE '%fusion%' THEN 'fusion'
    WHEN m.interpretation = 'Pathogenic' THEN 'other'
  END AS alteration,
  CASE WHEN m.gene = 'PD-L1' THEN CAST(regexp_extract(m.result_text, 'score ([0-9.]+)%', 1) AS DOUBLE) END AS tps,
  m.result_text, m.assay, CAST(m.reported_date AS DATE) AS reported_date
FROM ${s.molecular} m
LEFT JOIN ${s.patients} p ON p.mrn = REPLACE(m.patient_mrn, 'MRN', '')`,

    lab: `SELECT r.accession, p.patient_id, r.patient_mrn AS lab_mrn, r.loinc,
  CASE r.loinc WHEN '751-8' THEN 'ANC' WHEN '777-3' THEN 'PLT' WHEN '718-7' THEN 'HGB' WHEN '2160-0' THEN 'CREAT'
    WHEN '2164-2' THEN 'CRCL' WHEN '1975-2' THEN 'TBILI' WHEN '1920-8' THEN 'AST' WHEN '1742-6' THEN 'ALT' END AS analyte,
  CAST(r.value AS DOUBLE) AS value, r.unit, CAST(r.ref_high AS DOUBLE) AS uln, CAST(SUBSTR(CAST(r.collected_at AS VARCHAR(30)), 1, 10) AS DATE) AS collected_date
FROM ${s.labResults} r
LEFT JOIN ${s.patients} p ON p.mrn = REPLACE(r.patient_mrn, 'MRN', '')`,

    therapy: `SELECT m.med_order_id, m.patient_id, m.order_text, CAST(x.rxcui AS VARCHAR(12)) AS rxcui, x.ingredient, x.atc_code,
  COALESCE(x.therapy_class, 'UNRESOLVED') AS therapy_class,
  CAST(m.line_of_therapy AS INT) AS line_of_therapy, m.setting,
  CAST(m.start_date AS DATE) AS start_date, CAST(NULLIF(CAST(m.end_date AS VARCHAR(10)), '') AS DATE) AS end_date
FROM ${s.medications} m
LEFT JOIN ${s.rxnavMap} x ON x.order_text = m.order_text`,

    condition: `SELECT pr.problem_id, pr.patient_id, pr.icd10, pr.description,
  CASE
    WHEN pr.icd10 IN ('J84.10', 'J84.9') THEN 'ild'
    WHEN pr.icd10 = 'J70.4' OR LOWER(pr.description) LIKE '%pneumonitis%' THEN 'pneumonitis'
    WHEN pr.icd10 LIKE 'M06%' OR pr.icd10 LIKE 'M32%' OR pr.icd10 LIKE 'K50%' OR pr.icd10 LIKE 'K51%' THEN 'autoimmune'
    WHEN pr.icd10 = 'B18.1' THEN 'hbv'
    WHEN pr.icd10 = 'B18.2' THEN 'hcv'
    WHEN pr.icd10 = 'B20' THEN 'hiv'
    WHEN pr.icd10 LIKE 'I50%' THEN 'heart_failure'
    WHEN pr.icd10 LIKE 'C%' AND pr.icd10 NOT LIKE 'C34%' THEN 'other_malignancy_active'
    WHEN pr.icd10 LIKE 'Z85%' THEN 'other_malignancy_history'
    ELSE 'other' END AS category
FROM ${s.problems} pr`,

    trial: `SELECT t.nct_id, t.title, t.phase, t.overall_status, t.sponsor, CAST(t.last_update AS DATE) AS last_update,
  CAST(t.min_age AS INT) AS min_age, CAST(t.max_age AS INT) AS max_age, t.sex, t.criteria_hash,
  CAST(t.nearest_site_miles AS DOUBLE) AS nearest_site_miles
FROM ${s.trials} t`,

    site: `SELECT st.site_id, st.nct_id, st.facility, st.city, st.state, st.zip, CAST(st.lat AS DOUBLE) AS lat, CAST(st.lon AS DOUBLE) AS lon,
  ${d.miles("CAST(st.lat AS DOUBLE)", "CAST(st.lon AS DOUBLE)", String(clinic.lat), String(clinic.lon))} AS miles_to_clinic
FROM ${s.sites} st`,

    criterion: `SELECT c.criterion_id, c.nct_id, c.kind, CAST(c.ordinal AS INT) AS ordinal, c.text, c.category, c.method, c.check_status, c.compiled_json
FROM ${s.criteria} c`,
  };
}

// Data-quality rules registered on the USL (REGISTER DQ <rule> TABLE ... AS <expr>).
// Each one targets a real seam between the EHR and the lab system.
export const DQ_RULES: { name: string; table: UslTable; expr: string; why: string }[] = [
  { name: "lab_row_resolves_to_patient", table: "lab", expr: "patient_id IS NOT NULL", why: "Lab results whose MRN matches no EHR patient cannot be used for screening." },
  { name: "lab_has_unit_and_value", table: "lab", expr: "unit IS NOT NULL AND value IS NOT NULL AND value >= 0", why: "A lab value without a unit cannot be compared with a criterion threshold." },
  { name: "biomarker_resolves_to_patient", table: "biomarker", expr: "patient_id IS NOT NULL", why: "Molecular reports must link to an EHR patient through the MRN." },
  { name: "biomarker_has_assay_and_date", table: "biomarker", expr: "assay IS NOT NULL AND reported_date IS NOT NULL", why: "Trials often require the assay type and date of a biomarker result." },
  { name: "therapy_class_resolved", table: "therapy", expr: "therapy_class <> 'UNRESOLVED'", why: "Prior-therapy criteria depend on RxNav resolving every medication order." },
  { name: "trial_is_recruiting", table: "trial", expr: "overall_status = 'RECRUITING'", why: "Only recruiting trials belong on the worklist." },
];
