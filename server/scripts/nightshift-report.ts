// Writes docs/nightshift-run.md from the latest run's trace: every model request that
// went through Nightshift, which model served it, how long it took, and what the
// Compiler and Checker decided. Run after a night with Nightshift connected.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGS, ROOT, RUNTIME } from "../src/config.ts";

const latest = JSON.parse(readFileSync(join(RUNTIME, "latest.json"), "utf8"));
const events = readFileSync(join(LOGS, `${latest.runId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const modelEvents = events.filter((e) => e.model);
if (!modelEvents.length) {
  console.error(`Run ${latest.runId} has no model requests. Connect Nightshift (docs/SETUP.md) and run \`npm run night\` first.`);
  process.exit(1);
}
const status = events.find((e) => e.action === "nightshift_status");
const byModel = new Map<string, { n: number; ms: number }>();
for (const e of modelEvents) {
  const s = byModel.get(e.model) ?? { n: 0, ms: 0 };
  s.n++;
  s.ms += e.durationMs ?? 0;
  byModel.set(e.model, s);
}
const count = (agent: string, st?: string) => events.filter((e) => e.agent === agent && e.model && (!st || e.status === st)).length;
const summary = events.find((e) => e.action === "compile_summary");
const sample = (pred: (e: any) => boolean, n: number) => events.filter(pred).slice(0, n);
const row = (e: any) => `| ${e.ts.slice(11, 19)} | ${e.agent} | ${e.status} | ${e.model} | ${e.durationMs ?? ""} | ${String(e.summary).replace(/\|/g, "/").slice(0, 160)} |`;

const md = `# Nightshift run

Run \`${latest.runId}\`. ${status?.summary ?? ""}

| Model (as reported by Nightshift) | Requests | Mean latency (ms) |
|---|---:|---:|
${[...byModel.entries()].map(([m, s]) => `| ${m} | ${s.n} | ${Math.round(s.ms / s.n)} |`).join("\n")}

Compiler requests: ${count("Compiler")} (${count("Compiler", "retry")} retries, ${count("Compiler", "failed")} failed). Checker requests: ${count("Checker")} (${count("Checker", "ok")} agree, ${count("Checker", "blocked")} disagree and sent to review).

Compile summary: ${summary?.summary ?? "n/a"}

## Sample requests

| Time (UTC) | Agent | Status | Model | ms | Result |
|---|---|---|---|---:|---|
${[...sample((e) => e.agent === "Compiler" && e.model, 12), ...sample((e) => e.agent === "Checker" && e.status === "blocked", 8), ...sample((e) => e.agent === "Checker" && e.status === "ok", 4)].map(row).join("\n")}

The full trace is \`logs/${latest.runId}.jsonl\`.
`;
writeFileSync(join(ROOT, "docs", "nightshift-run.md"), md);
console.log(`wrote docs/nightshift-run.md (${modelEvents.length} model requests)`);
