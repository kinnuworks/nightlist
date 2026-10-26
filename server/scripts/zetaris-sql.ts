// Writes the Zetaris Lightning SQL that builds Nightlist's data layer, generated from
// the same schema file the sample engine uses so the two never drift.
//   sql/01_sources.sql    register the six sources
//   sql/02_explore.sql    exploratory queries, two or three per source
//   sql/03_usl.sql        COMPILE USL trialmatch (DDL for every table)
//   sql/04_activate.sql   bind each USL table to the sources
//   sql/05_dq.sql         data-quality rules
//   sql/06_proof.sql      queries showing the USL is active and the rules execute
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "../src/config.ts";
import { activation, DQ_RULES, USL_DDL, USL_TABLES, zetaris, type SourceNames } from "../src/usl/schema.ts";

const NS = config.zetaris.uslNamespace;
const USL = config.zetaris.usl;
const FILES = process.env.ZETARIS_FILE_ROOT ?? "file:///opt/nightlist/data";
const PG = {
  url: process.env.EHR_JDBC_URL ?? "jdbc:postgresql://host.docker.internal:5433/ehr",
  user: process.env.EHR_DB_USER ?? "nightlist",
  password: process.env.EHR_DB_PASSWORD ?? "nightlist",
};

const src: SourceNames = {
  patients: "ehr.public.patients",
  diagnoses: "ehr.public.diagnoses",
  metastases: "ehr.public.metastases",
  medications: "ehr.public.medications",
  problems: "ehr.public.problems",
  ecog: "ehr.public.ecog",
  labResults: "labsys.results",
  molecular: "labsys.molecular",
  rxnavMap: "terminology.rxnav_medication_map",
  ncitHistology: "terminology.ncit_histology",
  zcta: "terminology.zcta",
  trials: "trialfeed.trials",
  sites: "trialfeed.sites",
  criteria: "trialfeed.criteria",
};

const csvTable = (table: string, db: string, path: string) =>
  `CREATE LIGHTNING FILESTORE TABLE ${table} FROM ${db} FORMAT CSV OPTIONS (\n  path "${FILES}/${path}",\n  header "true",\n  delimiter ","\n);`;

const sources = `-- Source 1: the clinic EHR (PostgreSQL), queried in place.
CREATE DATASOURCE ehr DESCRIBE BY "Clinic EHR export (PostgreSQL)" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "${PG.url}",
  username "${PG.user}",
  password "${PG.password}"
);

-- Source 2: the lab system (results and molecular reports), its own MRN format.
CREATE LIGHTNING DATABASE labsys DESCRIBE BY "Lab information system exports";
${csvTable("results", "labsys", "sources/lab/results.csv")}
${csvTable("molecular", "labsys", "sources/lab/molecular.csv")}

-- Source 3: ClinicalTrials.gov API v2, live. Used by the Watcher to see what opened or changed.
CREATE LIGHTNING DATABASE ctgov DESCRIBE BY "ClinicalTrials.gov API v2 (live)";
CREATE LIGHTNING REST TABLE nsclc_recruiting FROM ctgov REQUEST (
  endpoint "https://clinicaltrials.gov/api/v2/studies?query.cond=non-small%20cell%20lung%20cancer&filter.overallStatus=RECRUITING&fields=NCTId,LastUpdatePostDate,OverallStatus&pageSize=1000&format=json",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER () BODY ();

-- Source 4: RxNav (NLM), live, for spot checks; the resolver writes the full map as a file table.
CREATE LIGHTNING DATABASE rxnav DESCRIBE BY "NLM RxNav REST API (live)";
CREATE LIGHTNING REST TABLE osimertinib_class FROM rxnav REQUEST (
  endpoint "https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?drugName=osimertinib&relaSource=ATC",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER () BODY ();

-- Source 5: NCI Thesaurus (EVS), live, for histology concepts.
CREATE LIGHTNING DATABASE nci DESCRIBE BY "NCI EVS REST API (live)";
CREATE LIGHTNING REST TABLE nsclc_concept FROM nci REQUEST (
  endpoint "https://api-evsrest.nci.nih.gov/api/v1/concept/ncit/C2926",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER () BODY ();

-- Terminology tables resolved from RxNav and NCI EVS, plus Census ZIP centroids.
CREATE LIGHTNING DATABASE terminology DESCRIBE BY "Resolved terminology (RxNav, NCI Thesaurus, Census ZCTA)";
${csvTable("rxnav_medication_map", "terminology", "sources/rxnav/medication_map.csv")}
${csvTable("ncit_histology", "terminology", "sources/nci/histology_ncit.csv")}
${csvTable("zcta", "terminology", "sources/geo/zcta_montgomery_90mi.csv")}

-- Source 6: the compiled trial feed written by the nightly Compiler.
CREATE LIGHTNING DATABASE trialfeed DESCRIBE BY "Compiled trial eligibility (written nightly)";
${csvTable("trials", "trialfeed", "runtime/compiled/trials.csv")}
${csvTable("sites", "trialfeed", "runtime/compiled/sites.csv")}
${csvTable("criteria", "trialfeed", "runtime/compiled/criteria.csv")}
`;

const explore = `-- EHR (PostgreSQL)
SELECT COUNT(*) AS patients, MIN(birth_date) AS oldest, MAX(birth_date) AS youngest FROM ehr.public.patients;
SELECT stage_text, COUNT(*) AS n FROM ehr.public.diagnoses GROUP BY stage_text ORDER BY n DESC;
SELECT order_text, COUNT(*) AS orders FROM ehr.public.medications GROUP BY order_text ORDER BY orders DESC LIMIT 10;

-- Lab system (file store): note the MRN format differs from the EHR
SELECT patient_mrn, COUNT(*) AS results FROM labsys.results GROUP BY patient_mrn ORDER BY results DESC LIMIT 5;
SELECT gene, interpretation, COUNT(*) AS n FROM labsys.molecular GROUP BY gene, interpretation ORDER BY gene;
SELECT unit, COUNT(*) AS n FROM labsys.results GROUP BY unit;

-- ClinicalTrials.gov (REST)
SELECT * FROM ctgov.nsclc_recruiting LIMIT 5;
DESCRIBE ctgov.nsclc_recruiting;

-- RxNav and NCI Thesaurus (REST)
SELECT * FROM rxnav.osimertinib_class LIMIT 5;
SELECT * FROM nci.nsclc_concept LIMIT 1;

-- Terminology tables
SELECT therapy_class, COUNT(*) AS orders_resolved FROM terminology.rxnav_medication_map GROUP BY therapy_class;
SELECT * FROM terminology.ncit_histology;
SELECT COUNT(*) AS zips FROM terminology.zcta;

-- Compiled trial feed
SELECT category, method, COUNT(*) AS n FROM trialfeed.criteria GROUP BY category, method ORDER BY n DESC;
SELECT nct_id, title, nearest_site_miles FROM trialfeed.trials ORDER BY CAST(nearest_site_miles AS DOUBLE) LIMIT 5;
`;

const usl = `CREATE NAMESPACE IF NOT EXISTS lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS ${NS};

COMPILE USL ${USL} DEPLOY NAMESPACE ${NS} DDL
${USL_TABLES.map((t) => USL_DDL[t]).join(";\n")};
`;

const act = activation(src, zetaris, "2026-10-26", config.clinic);
const activate = USL_TABLES.map((t) => `ACTIVATE USL TABLE ${NS}.${USL}.${t} AS\n${act[t]};`).join("\n\n") + "\n";

const dq = DQ_RULES.map((r) => `-- ${r.why}\nREGISTER DQ ${r.name} TABLE ${NS}.${USL}.${r.table} AS ${r.expr};`).join("\n\n") +
  `\n\nLIST DQ USL ${NS}.${USL};\n`;

const proof = `-- The USL is active: these read only semantic-layer tables, never the raw sources.
SHOW TABLES IN ${NS}.${USL};
SELECT d.histology, d.stage_group, COUNT(*) AS patients FROM ${NS}.${USL}.diagnosis d GROUP BY d.histology, d.stage_group ORDER BY patients DESC;
SELECT b.gene, b.alteration, COUNT(DISTINCT b.patient_id) AS patients FROM ${NS}.${USL}.biomarker b WHERE b.status = 'detected' GROUP BY b.gene, b.alteration ORDER BY patients DESC;
SELECT p.patient_id, p.given_name, p.family_name, b.gene, b.alteration, x.therapy_class, x.line_of_therapy
FROM ${NS}.${USL}.patient p
JOIN ${NS}.${USL}.biomarker b ON b.patient_id = p.patient_id AND b.status = 'detected'
JOIN ${NS}.${USL}.therapy x ON x.patient_id = p.patient_id
WHERE b.gene = 'EGFR' ORDER BY p.patient_id LIMIT 10;

-- The data-quality rules execute and catch the seams between the EHR and the lab system.
${DQ_RULES.map((r) => `SHOW DQ INVALID RECORD ${r.name} TABLE ${NS}.${USL}.${r.table};`).join("\n")}
`;

const out = join(ROOT, "sql");
mkdirSync(out, { recursive: true });
const header = "-- Generated by server/scripts/zetaris-sql.ts from server/src/usl/schema.ts. Do not edit by hand.\n\n";
for (const [f, body] of Object.entries({ "01_sources.sql": sources, "02_explore.sql": explore, "03_usl.sql": usl, "04_activate.sql": activate, "05_dq.sql": dq, "06_proof.sql": proof })) {
  writeFileSync(join(out, f), header + body);
  console.log(`wrote sql/${f}`);
}
