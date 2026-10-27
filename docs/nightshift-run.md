# Nightshift run

Runs: `night-20261027-181516` (2394 model requests), `night-20261027-190029` (502 model requests). Every model call goes to Meterless Nightshift at `http://127.0.0.1:8088/v1` with the `meterless-app: nightlist` header. The Compiler asks for the `meterless/deep` route and the Checker for `meterless/fast`; Nightshift picks the model and reports which one served each request, and that is what the trace records.

NVIDIA models Nightshift offered: `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-embed-1b`, `nvidia/nemotron-3.5-bolt-e4b`, `nvidia/nemotron-3.5-embed-1b`.

| Agent | Model that served the request (as reported by Nightshift) | Requests | Mean latency (ms) |
|---|---|---:|---:|
| Compiler | nvidia/nemotron-3.5-bolt-e4b | 1556 | 4518 |
| Checker | nvidia/nemotron-3.5-bolt-e4b | 1333 | 0 |
| Checker | nvidia/nemotron-3-ultra-550b-a55b | 4 | 0 |
| Compiler | nvidia/nemotron-3-ultra-550b-a55b | 3 | 30751 |

Requests served by a model other than NVIDIA Nemotron: 0.

Compiler: 1559 criteria compiled by the model, 340 retries and 320 failures (a failure sends the criterion to human review). Checker: 1337 back-translations, 563 agreed and 774 disagreed, which at the time of these runs sent the criterion to human review. The pipeline now keeps a disputed model draft in review and flags a disputed rule instead; see the README's NVIDIA section for why.

- `night-20261027-181516`: 2427 criteria: {"rule":485,"model":804,"cached":0,"screening":503,"review":511,"structured":105,"blocked":0,"agree":528,"disagree":715,"retries":380}
- `night-20261027-190029`: 2427 criteria: {"rule":25,"model":73,"cached":1249,"screening":503,"review":455,"structured":105,"blocked":0,"agree":35,"disagree":59,"retries":280}

## Sample requests

| Time (UTC) | Agent | Status | Model | ms | Result |
|---|---|---|---|---:|---|
| 2026-10-27 18:15:20 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 3213 | NCT05967689-I06: ECOG <= 1 |
| 2026-10-27 18:15:23 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 3523 | NCT05967689-I10: histology in {adenocarcinoma} |
| 2026-10-27 18:15:33 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 11494 | NCT05967689-I11: review |
| 2026-10-27 18:15:35 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 2699 | NCT05967689-I12: has brain metastases |
| 2026-10-27 18:15:38 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 1433 | NCT05967689-I13: ECOG <= 1 |
| 2026-10-27 18:15:42 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 2248 | NCT05967689-I14: histology in {adenocarcinoma} |
| 2026-10-27 18:16:02 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 42676 | NCT05967689-I07: review |
| 2026-10-27 18:16:07 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 5269 | NCT05967689-E02: (has had EGFR_TKI OR has active brain metastases) |
| 2026-10-27 18:16:09 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 9021 | NCT05967689-I19: review |
| 2026-10-27 18:16:12 | Compiler | ok | nvidia/nemotron-3.5-bolt-e4b | 3538 | NCT05967689-E03: NOT (has active brain metastases) AND NOT (has brain metastases) |
| 2026-10-27 18:15:43 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-I14: rule "histology in {adenocarcinoma}" does not match the sentence (The sentence does not mention histology.); sent to human review |
| 2026-10-27 18:16:09 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-E02: rule "(has had EGFR_TKI OR has active brain metastases)" does not match the sentence (The sentence mentions prior treatment with an EGFR exon20 |
| 2026-10-27 18:16:11 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-I10: rule "histology in {adenocarcinoma}" does not match the sentence (The sentence describes NSCLC with specific EGFRmt statuses, not just histolog |
| 2026-10-27 18:16:13 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-E03: rule "NOT (has active brain metastases) AND NOT (has brain metastases)" does not match the sentence (The sentence discusses unresolved toxicity |
| 2026-10-27 18:16:14 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-E06: rule "(has ild OR has had ANY_SYSTEMIC)" does not match the sentence (The sentence mentions specific GI issues (IBD, malabsorption, resection)  |
| 2026-10-27 18:16:18 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-E07: rule "NOT (has had ANY_SYSTEMIC)" does not match the sentence (The sentence discusses prior malignancy history, not prior systemic therapy.); s |
| 2026-10-27 18:16:21 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-E09: rule "has hbv" does not match the sentence (The sentence discusses COVID-19 infection, not HBV.); sent to human review |
| 2026-10-27 18:16:22 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-E10: rule "PLT < 50" does not match the sentence (The sentence describes a condition ('Active bleeding disorders') not a specific lab value threshol |
| 2026-10-27 18:16:24 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-E12: rule "sex is female" does not match the sentence (The sentence discusses pregnancy status, not sex.); sent to human review |
| 2026-10-27 18:16:35 | Checker | blocked | nvidia/nemotron-3.5-bolt-e4b |  | NCT05208762-I02: rule "histology in {adenocarcinoma, squamous, nos}" does not match the sentence (The sentence mentions HNSCC, NSCLC, SCC, and non-SCC histology |
| 2026-10-27 18:15:20 | Checker | ok | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-I04: agrees |
| 2026-10-27 18:15:20 | Checker | ok | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-I02: agrees |
| 2026-10-27 18:15:21 | Checker | ok | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-I06: agrees |
| 2026-10-27 18:15:37 | Checker | ok | nvidia/nemotron-3.5-bolt-e4b |  | NCT05967689-I12: agrees |

Full traces: `logs/night-20261027-181516.jsonl`, `logs/night-20261027-190029.jsonl`.
