// Exercises the model path against a local stand-in for the Nightshift runtime: the
// same OpenAI-compatible routes, bearer auth and meterless headers. It checks that
// a compiled predicate is validated, a disagreeing back-translation sends the
// criterion to review, and the serving model is recorded in the trace.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const seen: { auth?: string; app?: string; models: string[] } = { models: [] };
const server = createServer(async (req, res) => {
  seen.auth = req.headers.authorization;
  seen.app = req.headers["meterless-app"] as string;
  if (req.url === "/v1/models") {
    res.writeHead(req.headers.authorization === "Bearer test-token" ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "meterless/deep" }, { id: "meterless/fast" }] }));
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const { model, messages } = JSON.parse(body);
  seen.models.push(model);
  const user = messages[messages.length - 1].content as string;
  let content: string;
  if (model === "meterless/deep") {
    content = user.includes("companion diagnostic")
      ? '```json\n{"pred":{"k":"biomarker","gene":"MET","alterations":["exon14skip"],"status":"detected"},"category":"check","caveats":[]}\n```'
      : '{"pred":{"k":"ecog","max":1},"category":"check","caveats":[]}';
  } else {
    // The checker disagrees with the deliberately wrong ECOG compile.
    content = user.includes("ECOG <= 1") ? '{"restated":"ECOG 0 or 1","agree":false,"reason":"sentence is about hemoglobin"}' : '{"restated":"MET exon 14 skipping detected","agree":true,"reason":"matches"}';
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: model === "meterless/deep" ? "nemotron-3-super" : "nemotron-3.5-lightning", choices: [{ message: { content } }] }));
});
await new Promise<void>((ok) => server.listen(0, ok));
const port = (server.address() as any).port;

process.env.SAMPLE_MODE = "true";
process.env.NIGHTSHIFT_URL = process.env.METERLESS_BASE_URL = `127.0.0.1:${port}`;
process.env.NIGHTSHIFT_TOKEN = process.env.METERLESS_RUNTIME_TOKEN = "test-token";
process.env.NIGHTLIST_RUNTIME = mkdtempSync(join(tmpdir(), "nightlist-ns-"));
process.env.NIGHTLIST_LOGS = join(process.env.NIGHTLIST_RUNTIME, "logs");
process.env.NIGHTLIST_COMPILED = join(process.env.NIGHTLIST_RUNTIME, "compiled");
const { Nightshift } = await import("../src/nightshift.ts");
const { compileTrials } = await import("../src/compiler/pipeline.ts");
const { Trace } = await import("../src/log.ts");

test("Nightshift status uses /v1/models and the token", async () => {
  const st = await new Nightshift().status();
  assert.equal(st.state, "online");
  assert.equal(seen.auth, "Bearer test-token");
  assert.equal(seen.app, "nightlist");
});

test("model compile, back-translation and the trace", async () => {
  const trace = new Trace("test-model", { quiet: true });
  const trial: any = {
    nctId: "NCT09999999", title: "t", phase: "", status: "RECRUITING", sponsor: "", lastUpdate: "", sex: "all", criteriaHash: "x", sites: [], nearestMiles: 10,
    eligibility: "Inclusion Criteria:\n* Tumor must be positive for the study target as determined by the companion diagnostic named in the protocol\n* Recovered from all prior toxicities with an unusual composite scale the rules do not know",
  };
  const { criteria } = await compileTrials([trial], trace, { useModel: true, concurrency: 1 });
  const met = criteria.find((c) => c.text.includes("companion diagnostic"))!;
  const other = criteria.find((c) => c.text.includes("composite scale"))!;
  assert.equal(met.method, "model");
  assert.equal(met.category, "check");
  assert.equal(met.check?.status, "agree");
  assert.equal(other.category, "review", "a disagreeing back-translation sends the criterion to review");
  assert.equal(other.check?.status, "disagree");
  assert.ok(seen.models.includes("meterless/deep") && seen.models.includes("meterless/fast"));
  const events = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.agent === "Checker" && e.status === "blocked" && e.model === "nemotron-3.5-lightning"));
  assert.ok(events.some((e) => e.agent === "Compiler" && e.model === "nemotron-3-super"));
});

after(() => {
  server.closeAllConnections();
  server.close();
});
