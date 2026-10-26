// Builds the demo state: two overnight runs a day apart, so "what changed overnight"
// shows real events. Night 1: two trials are not yet open and Gloria Haynes has no
// molecular results. Between nights her NGS and PD-L1 results arrive in the lab inbox,
// two trials open, and a coordinator records a travel limit for Earline Pruitt.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { NavigatorMemory } from "@nightlist/hmem";
import { RUNTIME, SOURCES } from "../src/config.ts";
import { runNight } from "../src/night.ts";

rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(join(RUNTIME, "demo"), { recursive: true });
const snapFile = join(SOURCES, "ctgov_nsclc_us.json");
const full = JSON.parse(existsSync(snapFile) ? readFileSync(snapFile, "utf8") : gunzipSync(readFileSync(`${snapFile}.gz`)).toString("utf8"));
const LATE = ["NCT05967689", "NCT07100080"];
const night1 = { ...full, studies: full.studies.filter((s: any) => !LATE.includes(s.protocolSection.identificationModule.nctId)) };
writeFileSync(join(RUNTIME, "demo", "snapshot-night1.json"), JSON.stringify(night1));

const quiet = !process.argv.includes("--verbose");
const n1 = await runNight({ snapshotFile: join(RUNTIME, "demo", "snapshot-night1.json"), quiet });
console.log(`night 1: ${n1.id}`);

const patients = readFileSync(join(SOURCES, "ehr", "patients.csv"), "utf8").split("\n");
const gloria = patients.find((l) => l.includes("Gloria,Haynes"))!.split(",");
const mrn = `MRN${gloria[1]}`;
mkdirSync(join(RUNTIME, "inbox", "lab"), { recursive: true });
const genes = ["EGFR", "ALK", "ROS1", "KRAS", "BRAF", "MET", "RET", "ERBB2", "NTRK"];
const rows = genes.map((g) => `MOL-90001,${mrn},${g},${g === "EGFR" ? "EGFR c.2573T>G p.L858R (exon 21)" : "No pathogenic variant detected"},${g === "EGFR" ? "Pathogenic" : "Not detected"},Plasma ctDNA panel (Guardant360 CDx),2026-10-26`);
rows.push(`IHC-90002,${mrn},PD-L1,PD-L1 (22C3) tumor proportion score 15%,Positive,PD-L1 IHC 22C3 pharmDx,2026-10-26`);
writeFileSync(join(RUNTIME, "inbox", "lab", "molecular.csv"), "report_id,patient_mrn,gene,result_text,interpretation,assay,reported_date\n" + rows.join("\n") + "\n");

const memory = NavigatorMemory.open(join(RUNTIME, "hmem.json"));
memory.remember({ patientId: "P10005", kind: "preference", text: "Patient will not travel more than 100 miles for a trial; daughter drives her.", actor: "R. Calloway (research coordinator)" });
memory.remember({ patientId: "P10003", kind: "decision", text: "Ordered plasma NGS (Guardant360) after Nightlist flagged 28 trials one data item away.", actor: "R. Calloway (research coordinator)" });
memory.save();

const n2 = await runNight({ quiet });
console.log(`night 2: ${n2.id}`);
console.log(JSON.stringify({ night1: n1.summary.statusCounts, night2: n2.summary.statusCounts, newMatchesNight2: n2.summary.newMatches }));
