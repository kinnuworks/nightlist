// The data layer the agents query. Live mode sends SQL to Zetaris (Lightning SQL over
// its REST API); sample mode runs the identical semantic-layer SQL in DuckDB over the
// same source files, so judges can run everything without credentials.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, RUNTIME, SOURCES } from "./config.ts";
import { activation, DQ_RULES, duckdb, USL_TABLES, type SourceNames, type UslTable } from "./usl/schema.ts";

export type Row = Record<string, unknown>;

export interface DataLayer {
  readonly kind: "zetaris" | "duckdb";
  table(name: UslTable): string;
  query(sql: string): Promise<Row[]>;
  dqInvalid(rule: (typeof DQ_RULES)[number]): Promise<Row[]>;
  close(): Promise<void>;
}

export const SAMPLE_SOURCES: SourceNames = {
  patients: "ehr.patients",
  diagnoses: "ehr.diagnoses",
  metastases: "ehr.metastases",
  medications: "ehr.medications",
  problems: "ehr.problems",
  ecog: "ehr.ecog",
  labResults: "labsys.results",
  molecular: "labsys.molecular",
  rxnavMap: "rxnav.medication_map",
  ncitHistology: "nci.histology_ncit",
  zcta: "geo.zcta",
  trials: "ctgov.trials",
  sites: "ctgov.sites",
  criteria: "ctgov.criteria",
};

const RAW_FILES: [string, string][] = [
  ["ehr.patients", "ehr/patients.csv"],
  ["ehr.diagnoses", "ehr/diagnoses.csv"],
  ["ehr.metastases", "ehr/metastases.csv"],
  ["ehr.medications", "ehr/medications.csv"],
  ["ehr.problems", "ehr/problems.csv"],
  ["ehr.ecog", "ehr/ecog.csv"],
  ["labsys.results", "lab/results.csv"],
  ["labsys.molecular", "lab/molecular.csv"],
  ["rxnav.medication_map", "rxnav/medication_map.csv"],
  ["nci.histology_ncit", "nci/histology_ncit.csv"],
  ["geo.zcta", "geo/zcta_montgomery_90mi.csv"],
];

export class DuckLayer implements DataLayer {
  readonly kind = "duckdb" as const;
  private constructor(private conn: DuckDBConnection, private inst: DuckDBInstance) {}

  static async open(asOf: string, compiledDir = join(RUNTIME, "compiled")): Promise<DuckLayer> {
    const inst = await DuckDBInstance.create(":memory:");
    const conn = await inst.connect();
    const layer = new DuckLayer(conn, inst);
    for (const s of ["ehr", "labsys", "rxnav", "nci", "geo", "ctgov", "usl"]) await conn.run(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    for (const [table, rel] of RAW_FILES) {
      await conn.run(`CREATE TABLE ${table} AS SELECT * FROM read_csv('${join(SOURCES, rel)}', header = true, all_varchar = true)`);
      // New lab interface files land in the inbox between nights.
      const inbox = join(RUNTIME, "inbox", rel);
      if (existsSync(inbox)) await conn.run(`INSERT INTO ${table} SELECT * FROM read_csv('${inbox}', header = true, all_varchar = true)`);
    }
    for (const [table, file] of [["ctgov.trials", "trials.csv"], ["ctgov.sites", "sites.csv"], ["ctgov.criteria", "criteria.csv"]]) {
      const path = join(compiledDir, file);
      if (!existsSync(path)) throw new Error(`missing ${path}; run the compile step first`);
      await conn.run(`CREATE TABLE ${table} AS SELECT * FROM read_csv('${path}', header = true, all_varchar = true)`);
    }
    const act = activation(SAMPLE_SOURCES, duckdb, asOf, config.clinic);
    for (const t of USL_TABLES) await conn.run(`CREATE TABLE usl.${t} AS ${act[t]}`);
    return layer;
  }

  table(name: UslTable) {
    return `usl.${name}`;
  }

  async query(sql: string): Promise<Row[]> {
    const r = await this.conn.runAndReadAll(sql);
    return r.getRowObjectsJson() as Row[];
  }

  async dqInvalid(rule: (typeof DQ_RULES)[number]): Promise<Row[]> {
    return this.query(`SELECT * FROM ${this.table(rule.table)} WHERE NOT (${rule.expr}) OR (${rule.expr}) IS NULL`);
  }

  async close() {
    this.conn.closeSync();
    this.inst.closeSync();
  }
}

export class ZetarisLayer implements DataLayer {
  readonly kind = "zetaris" as const;
  private base = config.zetaris.restUrl.replace(/\/$/, "");

  table(name: UslTable) {
    return `${config.zetaris.uslNamespace}.${config.zetaris.usl}.${name}`;
  }

  async query(sql: string, limit = 100000): Promise<Row[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.zetaris.timeoutMs);
    try {
      const res = await fetch(`${this.base}/sql-editor/sqls/run`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${config.zetaris.apiKey}`,
          "X-Org-ID": config.zetaris.orgId,
          "X-Request-ID": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId: crypto.randomUUID(), sql, source: "SqlEditor", limit }),
      });
      if (!res.ok) throw new Error(`Zetaris HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return normalizeRows(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  async dqInvalid(rule: (typeof DQ_RULES)[number]): Promise<Row[]> {
    return this.query(`SHOW DQ INVALID RECORD ${rule.name} TABLE ${this.table(rule.table)}`);
  }

  async close() {}
}

// The REST API has returned rows as objects or as arrays plus a column list; accept both.
export function normalizeRows(out: any): Row[] {
  const data = out?.data ?? out?.rows ?? out?.result ?? out;
  if (!Array.isArray(data)) return [];
  if (!data.length || !Array.isArray(data[0])) return data as Row[];
  const cols: string[] = (out.columns ?? out.schema ?? out.header ?? []).map((c: any) => (typeof c === "string" ? c : c.name ?? c.columnName));
  return data.map((r: unknown[]) => Object.fromEntries(r.map((v, i) => [cols[i] ?? `c${i}`, v])));
}

export async function openDataLayer(asOf: string): Promise<DataLayer> {
  if (!config.sampleMode && config.zetaris.apiKey) return new ZetarisLayer();
  return DuckLayer.open(asOf);
}
