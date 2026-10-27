# Requirement: unknown-aware checks in the USL

## Problem

Agents that make decisions from enterprise data need to distinguish "false" from "we do not have the data". In Nightlist, "no EGFR result on file" and "EGFR tested negative" lead to opposite actions: one means order a test, the other means look elsewhere. Today every team writes this logic by hand as nested `CASE` expressions over `EXISTS` subqueries, and every team gets the edge cases slightly differently (stale results, results that failed a data-quality rule, values without units).

## Requirement

Let a USL owner declare named checks on USL tables that return one of `TRUE`, `FALSE` or `UNKNOWN` per entity, with the reasons for `UNKNOWN` built in:

1. **Declared checks.** `REGISTER CHECK <name> ON <usl>.<entity> AS <boolean expression>` where missing rows, NULL values and stale rows evaluate to `UNKNOWN` instead of `FALSE`.
2. **Freshness.** A per-table `VALID FOR <interval>` so a lab value older than 30 days counts as unknown automatically.
3. **Data quality feeds unknowns.** Rows that fail a registered DQ rule are excluded from checks and reported as the reason for `UNKNOWN` ("value without unit"), instead of silently counting.
4. **Evidence.** `EXPLAIN CHECK <name> FOR <key>` returns the rows that decided the answer, with their source and lineage.

Agents then call checks by name, and the governance team owns their definitions.

## Mock of the proposed feature

```sql
REGISTER CHECK egfr_sensitizing ON lightning.metastore.rrcc.trialmatch.patient
  AS EXISTS biomarker (gene = 'EGFR' AND status = 'detected' AND alteration IN ('exon19del', 'L858R'))
  UNKNOWN WHEN NOT EXISTS biomarker (gene = 'EGFR' AND status IN ('detected', 'not_detected'));

ALTER USL TABLE lightning.metastore.rrcc.trialmatch.lab VALID FOR INTERVAL 30 DAYS ON collected_date;

SELECT patient_id, CHECK(egfr_sensitizing) AS egfr, CHECK(anc_at_least_1_5) AS anc
FROM lightning.metastore.rrcc.trialmatch.patient;
-- patient_id | egfr    | anc
-- P10001     | TRUE    | TRUE
-- P10003     | UNKNOWN | TRUE      (no EGFR result on file)
-- P10006     | FALSE   | FALSE

EXPLAIN CHECK anc_at_least_1_5 FOR 'P10006';
-- lab.accession L26-000071 | ANC 1.1 10*3/uL | collected 2026-10-24 | source labsys.results | DQ: pass
```

What the USL JSON would gain:

```json
{
  "checks": [
    {
      "name": "egfr_sensitizing",
      "entity": "patient",
      "expression": "EXISTS biomarker (gene = 'EGFR' AND status = 'detected' AND alteration IN ('exon19del','L858R'))",
      "unknownWhen": "NOT EXISTS biomarker (gene = 'EGFR' AND status IN ('detected','not_detected'))",
      "dependsOn": ["biomarker"],
      "dqExclusions": ["biomarker_resolves_to_patient", "biomarker_has_assay_and_date"]
    }
  ],
  "freshness": [{ "table": "lab", "column": "collected_date", "validFor": "30 days" }]
}
```

## Why it matters for Zetaris

Every agent built on a data harness will hit this. Making "unknown, and here is why" a property of the governed layer instead of application code would make agent decisions auditable in the place where data owners already work, and it is the step from "agents can read the data safely" to "agents can decide from the data safely".

Nightlist implements this pattern in application code today (`server/src/evaluator/sqlgen.ts`); it is the code we would most like to delete.
