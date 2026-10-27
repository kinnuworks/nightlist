# Sample inputs

Three requests for `POST /run`. Each one re-runs the overnight screen in sample mode and returns the worklist entry for one patient. The matching responses in `output_examples/` were saved from real runs of this endpoint, not written by hand.

| File | Patient | What to look for |
|---|---|---|
| `example_1.json` | P10003 Gloria Haynes | NGS results arrived overnight (EGFR L858R). Her matches changed, and the coordinator's earlier decision to order the test is in memory. |
| `example_2.json` | P10005 Earline Pruitt | Active brain metastases block 35 trials. A remembered 100-mile travel limit sets 27 more aside, with the reason. |
| `example_3.json` | P10006 James Tolliver | A neutrophil count of 1.1 blocks the 10 trials that need at least 1.5. |

To reproduce:

```bash
npm run demo          # rebuilds the two demo nights from scratch
npm start             # serves on http://localhost:8787
```

```bash
curl -s -X POST http://localhost:8787/run -H "Content-Type: application/json" -d @input_examples/example_1.json
```

The example files send `"rerun": false`, so they read the latest run; set it to `true` to screen the clinic again first. The trace for each run is in `logs/<trace_id>.jsonl`. Counts can move slightly if you re-fetch trials from ClinicalTrials.gov; the committed snapshot gives the numbers shown here.
