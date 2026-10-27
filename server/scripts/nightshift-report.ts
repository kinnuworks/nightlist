// Writes docs/nightshift-run.md from one or more runs' traces: every model request that
// went through Nightshift, which model served it, how long it took, and what the
// Compiler and Checker decided. Run after a night with Nightshift connected.
//   npm run nightshift:report -w server                     (latest run)
//   npm run nightshift:report -w server -- <runId> <runId>  (several runs, in order)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, LOGS, ROOT, RUNTIME } from "../src/config.ts";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : [JSON.parse(readFileSync(join(RUNTIME, "latest.json"), "utf8")).runId];
const runs = ids.map((id) => ({ id, events: readFileSync(join(LOGS, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)) }));
const events = runs.flatMap((r) => r.events);
const modelEvents = events.filter((e) => e.model);
if (!modelEvents.length) {
  console.error(`No model requests in ${ids.join(", ")}. Connect Nightshift (docs/SETUP.md) and run \`npm run night\` first.`);
  process.exit(1);
}

// Nightshift lists every route and model it can reach; only the NVIDIA ones and the
// routes Nightlist asks for matter here.
const offered = (events.find((e) => e.action === "nightshift_status")?.summary ?? "").replace(/^.*routes: /, "").split(", ");
const nvidiaOffered = offered.filter((m) => m.startsWith("nvidia/"));

const byModel = new Map<string, { agent: string; n: number; ms: number }>();
for (const e of modelEvents) {
  const key = `${e.agent}|${e.model}`;
  const s = byModel.get(key) ?? { agent: e.agent, n: 0, ms: 0 };
  s.n++;
  s.ms += e.durationMs ?? 0;
  byModel.set(key, s);
}
const count = (agent: string, action: string, st?: string) => events.filter((e) => e.agent === agent && e.action === action && (!st || e.status === st)).length;
const sample = (pred: (e: any) => boolean, n: number) => events.filter(pred).slice(0, n);
const row = (e: any) => `| ${e.ts.slice(0, 10)} ${e.ts.slice(11, 19)} | ${e.agent} | ${e.status} | ${e.model} | ${e.durationMs ?? ""} | ${String(e.summary).replace(/\|/g, "/").slice(0, 160)} |`;
const nonNvidia = modelEvents.filter((e) => !String(e.model).startsWith("nvidia/")).length;

const md = `# Nightshift run

Runs: ${runs.map((r) => `\`${r.id}\` (${r.events.filter((e) => e.model).length} model requests)`).join(", ")}. Every model call goes to Meterless Nightshift at \`${config.nightshift.baseUrl}\` with the \`meterless-app: nightlist\` header. The Compiler asks for the \`${config.nightshift.compileModel}\` route and the Checker for \`${config.nightshift.checkModel}\`; Nightshift picks the model and reports which one served each request, and that is what the trace records.

NVIDIA models Nightshift offered: ${nvidiaOffered.map((m) => `\`${m}\``).join(", ") || "none listed"}.

| Agent | Model that served the request (as reported by Nightshift) | Requests | Mean latency (ms) |
|---|---|---:|---:|
${[...byModel.values()].sort((a, b) => b.n - a.n).map((s) => `| ${s.agent} | ${[...byModel.entries()].find(([, v]) => v === s)![0].split("|")[1]} | ${s.n} | ${Math.round(s.ms / s.n)} |`).join("\n")}

Requests served by a model other than NVIDIA Nemotron: ${nonNvidia}.

Compiler: ${count("Compiler", "compile_criterion", "ok")} criteria compiled by the model, ${count("Compiler", "compile_criterion", "retry")} retries and ${count("Compiler", "compile_criterion", "failed")} failures (a failure sends the criterion to human review). Checker: ${count("Checker", "back_translate")} back-translations, ${count("Checker", "back_translate", "ok")} agreed and ${count("Checker", "back_translate", "blocked")} disagreed, which at the time of these runs sent the criterion to human review. The pipeline now keeps a disputed model draft in review and flags a disputed rule instead; see the README's NVIDIA section for why.

${runs.map((r) => `- \`${r.id}\`: ${r.events.find((e) => e.action === "compile_summary")?.summary ?? "stopped before the compile summary"}`).join("\n")}

## Sample requests

| Time (UTC) | Agent | Status | Model | ms | Result |
|---|---|---|---|---:|---|
${[...sample((e) => e.agent === "Compiler" && e.model, 10), ...sample((e) => e.agent === "Checker" && e.status === "blocked", 10), ...sample((e) => e.agent === "Checker" && e.status === "ok", 4)].map(row).join("\n")}

Full traces: ${runs.map((r) => `\`logs/${r.id}.jsonl\``).join(", ")}.
`;
writeFileSync(join(ROOT, "docs", "nightshift-run.md"), md);
console.log(`wrote docs/nightshift-run.md (${modelEvents.length} model requests, ${nonNvidia} not NVIDIA)`);
