# @nightlist/world-model

The world model is Nightlist's canonical record of what it knows and when it learned it. Every trial snapshot, patient fact and match verdict is written as an event to one append-only log. Everything else (current trial status, current lab values, current matches) is derived from that log and can be rebuilt from it at any time.

The "what changed overnight" panel reads from this log: trials that opened, were amended or closed, patient facts that were added or changed, and matches that are new, changed or dropped since the last run. Each item carries its provenance (source, observed time, recorded time, run id).

## Layout

- `src/index.ts`: the engine. Entities, contexts, relationships and facts, with stable content-derived ids, idempotent ingest, entity merge and unmerge, rebuildable views (graph, facts, timeline, snapshot), and provenance on every write. No network access and no runtime dependencies.
- `src/clinic.ts`: `ClinicWorld`, the Nightlist wrapper used by the server.
- `conformance/`: the Meterless World Model conformance suite, run against `src/index.ts`. See `conformance/NOTICE.md`.
- `test/`: unit tests for the engine and `ClinicWorld` (node:test).

## Usage

```ts
import { ClinicWorld } from "@nightlist/world-model/clinic";

const world = ClinicWorld.open("data/runtime/world.jsonl");
world.ingestTrialSnapshot(trials, "ctgov", "2026-10-27T02:00:00Z");
world.ingestPatientFacts(facts);
world.recordVerdicts("night-2026-10-27", verdicts);
const panel = world.changesSince(previousRunId); // or an ISO time
```

The log is replayed when the file is opened. Use one `ClinicWorld` instance per log file; the engine assumes a single writer. Calling any ingest method twice with the same input appends nothing.

Entities: `patient`, `trial`, `criterion`, `site`, `test`. Relationships: `patient candidate_for trial`, `trial has_criterion criterion`, `trial recruits_at site`, `criterion resolved_by_test test`.

## Running the checks

```bash
npm run conformance -w engines/world-model   # official suite, must print 8/8
npm test -w engines/world-model              # ClinicWorld and engine tests
npm run typecheck -w engines/world-model
```

The latest conformance scorecard is saved in `CONFORMANCE.txt`.
