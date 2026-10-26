// Pulls recruiting interventional NSCLC trials with a US site from ClinicalTrials.gov
// API v2 into data/sources/ctgov_nsclc_us.json (the Watcher's snapshot).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCES } from "../src/config.ts";

const API = "https://clinicaltrials.gov/api/v2/studies";
const params = new URLSearchParams({
  "query.cond": "non-small cell lung cancer",
  "filter.overallStatus": "RECRUITING",
  "filter.advanced": "AREA[StudyType]INTERVENTIONAL AND AREA[LocationCountry]United States",
  pageSize: "200",
  countTotal: "true",
  format: "json",
});
const studies: unknown[] = [];
for (;;) {
  const r = await fetch(`${API}?${params}`);
  if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 5000)); continue; }
  if (!r.ok) throw new Error(`ClinicalTrials.gov HTTP ${r.status}`);
  const body: any = await r.json();
  studies.push(...body.studies);
  console.log(`fetched ${studies.length}${body.totalCount ? ` / ${body.totalCount}` : ""}`);
  if (!body.nextPageToken) break;
  params.set("pageToken", body.nextPageToken);
  await new Promise((ok) => setTimeout(ok, 1300));
}
writeFileSync(join(SOURCES, "ctgov_nsclc_us.json"), JSON.stringify({ fetched_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), studies }));
console.log(`wrote ${studies.length} studies`);
