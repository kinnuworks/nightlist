# @nightlist/hmem

Memory for Nightlist. It keeps what navigators tell us between nightly runs:

- decisions about a patient and a trial,
- corrections to compiled eligibility criteria,
- patient preferences (distance, visit days, contact method),
- plain facts about sites and data sources.

The next night, the run asks for the memories that matter for the patient and trial in
front of it and puts them back into its context. Every change is written to an
append-only ledger, so the UI can show who changed what and when.

The engine follows the Meterless H-MEM spec: tiered layers (short term, working, long
term), hybrid ranking, feedback, conflict detection, a preview-first sleep cycle and
dreaming proposals that need human approval. It runs offline. Text is embedded with a
local hashed token vector, so there are no model calls and no network access.

## Use from the server

```ts
import { NavigatorMemory } from "@nightlist/hmem";

const memory = NavigatorMemory.open("data/runtime/hmem.json"); // saves after every change

memory.remember({
  criterionId: "NCT01234567:exc-3",
  trialId: "NCT01234567",
  kind: "correction",
  text: "Treated brain metastases stable for 4 weeks are allowed.",
  actor: "md:lee",
});

memory.correctionFor("NCT01234567:exc-3");  // latest correction that has not been superseded
memory.recall({ patientId: "p1", trialId: "NCT01234567", query: "brain metastases" });
memory.nightly();                            // conflicts, sleep, dreaming; returns a JSON report
memory.history(id);                          // audit trail for one memory
```

Notes:

- A new correction for a criterion supersedes the previous one. The old one is kept for audit.
- Recall never returns another patient's memories, and it skips superseded records and
  records marked `wrong`.
- `nightly()` only proposes dream records. Use `approveProposal` or `rejectProposal`.
- The default recall threshold is 0.2 (the engine default is 0.35) because the local
  embedder gives lower similarity scores than a learned model.

The lower level `HMEM` class is also exported, with `toJSON()`, `HMEM.fromJSON(data, { clock })`,
`saveFile(path)` and `HMEM.loadFile(path, { clock })`.

## Checks

```bash
npm run conformance   # official Meterless H-MEM conformance suite, must print 13/13
npm test              # unit tests for NavigatorMemory (node:test)
npm run typecheck
```

From the repo root, `npm run conformance -w engines/hmem` does the same. The last
scorecard is in `CONFORMANCE.txt`. The suite in `conformance/` is Apache-2.0 licensed
by Meterless; see `conformance/NOTICE.md`.
