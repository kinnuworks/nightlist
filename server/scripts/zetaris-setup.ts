// Runs the generated sql/*.sql against Zetaris over its REST API, one statement at a
// time (COMPILE USL is kept whole), stopping at the first error. Results go to
// docs/zetaris-run.md so the setup is reviewable.
//   npm run zetaris:setup -w server            all files
//   npm run zetaris:setup -w server -- 02 06   only the listed steps
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "../src/config.ts";
import { ZetarisLayer } from "../src/datalayer.ts";

if (!config.zetaris.apiKey) {
  console.error("Set ZETARIS_API_KEY (and ZETARIS_REST_URL, ZETARIS_ORG_ID) in .env first.");
  process.exit(1);
}

export function splitStatements(sql: string): string[] {
  const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const compile = body.match(/COMPILE USL[\s\S]*?;\s*(?=\n\s*\n|$)/);
  const out: string[] = [];
  let rest = body;
  if (compile) {
    const [before, after] = body.split(compile[0]);
    out.push(...simple(before), compile[0].trim().replace(/;\s*$/, ""));
    rest = after;
    return [...out, ...simple(rest)];
  }
  return simple(rest);
}
function simple(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; }
    else if (ch === "'" || ch === '"') q = ch;
    else if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const only = process.argv.slice(2);
const files = readdirSync(join(ROOT, "sql")).filter((f) => f.endsWith(".sql") && (!only.length || only.some((o) => f.startsWith(o)))).sort();
const z = new ZetarisLayer();
const report = join(ROOT, "docs", "zetaris-run.md");
writeFileSync(report, `# Zetaris setup run\n\nInstance: ${config.zetaris.restUrl}\nRun at: ${new Date().toISOString()}\n`);
for (const f of files) {
  appendFileSync(report, `\n## ${f}\n`);
  for (const stmt of splitStatements(readFileSync(join(ROOT, "sql", f), "utf8"))) {
    const head = stmt.replace(/\s+/g, " ").slice(0, 110);
    process.stdout.write(`${f}  ${head} ... `);
    try {
      const rows = await z.query(stmt, 50);
      console.log(`ok (${rows.length} rows)`);
      appendFileSync(report, `\n\`\`\`sql\n${stmt}\n\`\`\`\n${rows.length} rows${rows.length ? `\n\n\`\`\`json\n${JSON.stringify(rows.slice(0, 10), null, 1)}\n\`\`\`` : ""}\n`);
    } catch (err) {
      const msg = (err as Error).message;
      if (/already exist/i.test(msg)) { console.log("exists, skipped"); continue; }
      console.log(`FAILED\n${msg}`);
      appendFileSync(report, `\nFAILED: ${msg}\n`);
      process.exit(1);
    }
  }
}
console.log(`\nDone. Results in ${report}`);
