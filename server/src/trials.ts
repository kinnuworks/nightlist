import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { SOURCES, config } from "./config.ts";
import type { Criterion } from "./dsl.ts";

export interface Site { siteId: string; facility: string; city: string; state: string; zip: string; lat: number; lon: number; miles: number }
export interface Trial {
  nctId: string;
  title: string;
  phase: string;
  status: string;
  sponsor: string;
  lastUpdate: string;
  minAge?: number;
  maxAge?: number;
  sex: string;
  eligibility: string;
  criteriaHash: string;
  sites: Site[];
  nearestMiles: number;
}

export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

const years = (s?: string) => {
  const m = s?.match(/(\d+)\s*Year/i);
  return m ? Number(m[1]) : undefined;
};

export function parseStudy(study: any): Trial {
  const ps = study.protocolSection;
  const elig = ps.eligibilityModule ?? {};
  const text: string = elig.eligibilityCriteria ?? "";
  const sites: Site[] = (ps.contactsLocationsModule?.locations ?? [])
    .filter((l: any) => l.country === "United States" && l.geoPoint)
    .map((l: any, i: number) => ({
      siteId: `${ps.identificationModule.nctId}-${i}`,
      facility: l.facility ?? "",
      city: l.city ?? "",
      state: l.state ?? "",
      zip: l.zip ?? "",
      lat: l.geoPoint.lat,
      lon: l.geoPoint.lon,
      miles: milesBetween(config.clinic.lat, config.clinic.lon, l.geoPoint.lat, l.geoPoint.lon),
    }));
  return {
    nctId: ps.identificationModule.nctId,
    title: ps.identificationModule.briefTitle ?? ps.identificationModule.officialTitle ?? "",
    phase: (ps.designModule?.phases ?? []).join("/"),
    status: ps.statusModule?.overallStatus ?? "",
    sponsor: ps.sponsorCollaboratorsModule?.leadSponsor?.name ?? "",
    lastUpdate: ps.statusModule?.lastUpdatePostDateStruct?.date ?? "",
    minAge: years(elig.minimumAge),
    maxAge: years(elig.maximumAge),
    sex: (elig.sex ?? "ALL").toLowerCase(),
    eligibility: text,
    criteriaHash: createHash("sha256").update(text).digest("hex").slice(0, 16),
    sites,
    nearestMiles: sites.length ? Math.min(...sites.map((s) => s.miles)) : Infinity,
  };
}

// The committed snapshot is gzipped; a fresh fetch writes the plain JSON next to it.
export function loadSnapshot(file = join(SOURCES, "ctgov_nsclc_us.json")): { fetchedAt: string; trials: Trial[] } {
  const text = existsSync(file) ? readFileSync(file, "utf8") : gunzipSync(readFileSync(`${file}.gz`)).toString("utf8");
  const raw = JSON.parse(text);
  return { fetchedAt: raw.fetched_at, trials: raw.studies.map(parseStudy) };
}

// Splits ClinicalTrials.gov eligibility text into atomic criteria. The text is a loose
// markdown list under "Inclusion Criteria:" and "Exclusion Criteria:" headings, with
// nested sub-bullets that belong to the line above them.
export function splitCriteria(trial: Pick<Trial, "nctId" | "eligibility">): Criterion[] {
  const lines = trial.eligibility.replace(/\r/g, "").split("\n");
  const out: Criterion[] = [];
  let kind: "inclusion" | "exclusion" | null = null;
  let current: { text: string; indent: number } | null = null;
  const flush = () => {
    if (!current || !kind) return;
    const text = current.text.replace(/\\([[\]<>*_])/g, "$1").replace(/\s+/g, " ").trim();
    if (text.length >= 6 && !/^(inclusion|exclusion) criteria:?$/i.test(text)) {
      out.push({
        criterionId: `${trial.nctId}-${kind === "inclusion" ? "I" : "E"}${String(out.filter((c) => c.kind === kind).length + 1).padStart(2, "0")}`,
        nctId: trial.nctId,
        kind,
        ordinal: out.length + 1,
        text,
        category: "review",
        method: "none",
      });
    }
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    // Headings come as "Inclusion Criteria:", "Key Inclusion Criteria", "Select Exclusion
    // Criteria:", "Main Inclusion Criteria:" and similar short lines.
    const heading = line.trim().replace(/[*_#]/g, "");
    if (heading.length <= 60 && /\binclusion criteria\b/i.test(heading) && !/\bexclusion\b/i.test(heading)) { flush(); kind = "inclusion"; continue; }
    if (heading.length <= 60 && /\bexclusion criteria\b/i.test(heading)) { flush(); kind = "exclusion"; continue; }
    // A list with no heading at all is read as inclusion criteria.
    if (kind === null && /^\s*(?:[*\-•]|\d+[.)])\s+/.test(line)) kind = "inclusion";
    const bullet = line.match(/^(\s*)(?:[*\-•]|\d+[.)]|[a-z][.)])\s+(.*)$/i);
    if (bullet) {
      const indent = bullet[1].length;
      if (current && indent > current.indent) {
        current.text += `; ${bullet[2]}`;
      } else {
        flush();
        current = { text: bullet[2], indent };
      }
    } else if (current) {
      current.text += ` ${line.trim()}`;
    } else if (kind) {
      current = { text: line.trim(), indent: 0 };
    }
  }
  flush();
  return out;
}
