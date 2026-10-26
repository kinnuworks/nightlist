import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldModel } from "../src/index.ts";

const src = (at: string, kind = "manual") => ({ kind, at });
const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wm-")), "runtime", "world.jsonl");

test("jsonl log replays to the same state", () => {
  const file = tmpLog();
  const a = new WorldModel({ storage: "jsonl", path: file });
  a.upsertEntity({ type: "team", externalKey: { system: "g", id: "a" }, attrs: { city: "X" }, source: src("2026-01-01T00:00:00Z") });
  a.upsertEntity({ type: "person", name: "Ana Ruiz", source: src("2026-01-01T00:00:00Z") });
  a.assertFact({ about: "team:g:a", predicate: "coach", value: "Lee", source: src("2026-01-02T00:00:00Z") });
  const b = new WorldModel({ storage: "jsonl", path: file });
  assert.equal(b.stateShapeCanonical(), a.stateShapeCanonical());
  assert.equal(b.lastSeq(), a.lastSeq());
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, a.lastSeq());
});

test("a torn last line is dropped on load and appends continue cleanly", () => {
  const file = tmpLog();
  const a = new WorldModel({ storage: "jsonl", path: file });
  a.upsertEntity({ type: "x", name: "One", source: src("2026-01-01T00:00:00Z") });
  fs.appendFileSync(file, '{"v":1,"seq":2,"kind":"ent');
  const b = new WorldModel({ storage: "jsonl", path: file });
  assert.equal(b.loadWarnings.length, 1);
  b.upsertEntity({ type: "x", name: "Something Else", source: src("2026-01-02T00:00:00Z") });
  const c = new WorldModel({ storage: "jsonl", path: file });
  assert.equal(c.lastSeq(), 2);
  assert.equal(c.loadWarnings.length, 0);
});

test("identical writes append nothing", () => {
  const w = new WorldModel();
  w.upsertEntity({ type: "x", name: "Same", attrs: { a: 1 }, source: src("2026-01-01T00:00:00Z") });
  w.upsertEntity({ type: "x", name: "Same", attrs: { a: 1 }, source: src("2026-01-03T00:00:00Z") });
  w.relate({ from: "a", type: "r", to: "b", cardinality: "many", source: src("2026-01-01T00:00:00Z") });
  w.relate({ from: "a", type: "r", to: "b", cardinality: "many", source: src("2026-01-05T00:00:00Z") });
  assert.equal(w.lastSeq(), 2);
});

test("resolver auto-merges near-identical names and queues the review band", () => {
  const w = new WorldModel();
  const a = w.upsertEntity({ type: "person", name: "Jonathan Smith", source: src("2026-01-01T00:00:00Z") });
  const b = w.upsertEntity({ type: "person", name: "Jonathon Smith", source: src("2026-01-02T00:00:00Z") });
  assert.equal(b.id, a.id);
  assert.deepEqual(w.entity(a.id)!.aliases.sort(), ["Jonathan Smith", "Jonathon Smith"]);
  assert.equal(w.mergeQueue().length, 0);
  const m = w.upsertEntity({ type: "person", name: "Marcus", source: src("2026-01-03T00:00:00Z") });
  const k = w.upsertEntity({ type: "person", name: "Markus", source: src("2026-01-04T00:00:00Z") });
  assert.notEqual(m.id, k.id);
  assert.equal(w.mergeQueue().length, 1);
  w.approveMerge(w.mergeQueue()[0].id, "op");
  assert.equal(w.entity(k.id)!.id, m.id);
  assert.equal(w.mergeQueue().length, 0);
});

test("merge and unmerge are reversible and views rebuild from the log", () => {
  const w = new WorldModel({ clock: () => new Date("2026-02-01T00:00:00Z") });
  const p = w.upsertEntity({ type: "org", externalKey: { system: "crm", id: "1" }, name: "Acme", source: src("2026-01-01T00:00:00Z") });
  const q = w.upsertEntity({ type: "org", externalKey: { system: "erp", id: "9" }, name: "ACME Inc", source: src("2026-01-01T00:00:00Z") });
  w.assertFact({ about: q.id, predicate: "hq", value: "Austin", source: src("2026-01-02T00:00:00Z") });
  w.merge(q.id, p.id, { by: "op" });
  assert.equal(w.entity(q.id)!.id, p.id);
  assert.equal(w.entity(p.id)!.attrs.hq, "Austin");
  assert.ok(w.verify());
  w.unmerge(q.id, { by: "op" });
  assert.equal(w.entity(q.id)!.id, q.id);
  assert.equal(w.entity(p.id)!.attrs.hq, undefined);
  const before = w.stateShapeCanonical();
  w.rebuild();
  assert.equal(w.stateShapeCanonical(), before);
});

test("most recent fact wins and the loser keeps its provenance", () => {
  const w = new WorldModel();
  const newer = w.assertFact({ about: "person:x:1", predicate: "title", value: "Chair", source: src("2026-05-02T00:00:00Z", "api") });
  const older = w.assertFact({ about: "person:x:1", predicate: "title", value: "Chairman", source: src("2026-05-01T00:00:00Z", "rss") });
  assert.equal(w.entity("person:x:1")!.attrs.title, "Chair");
  assert.equal(w.fact(older.id)!.supersededBy, newer.id);
  assert.equal(w.fact(older.id)!.source.kind, "rss");
});
