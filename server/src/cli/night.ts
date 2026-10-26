import { runNight } from "../night.ts";

const args = new Set(process.argv.slice(2));
const limit = process.argv.find((a) => a.startsWith("--limit="));
const res = await runNight({
  useModel: !args.has("--no-model"),
  quiet: args.has("--quiet"),
  trialLimit: limit ? Number(limit.split("=")[1]) : undefined,
});
console.log(`\nrun ${res.id} written to ${res.outDir}`);
console.log(JSON.stringify(res.summary.statusCounts));
