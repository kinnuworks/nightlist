# How the USL helps, and where it does not

## Where it helped Nightlist

- **A stable target for generated SQL.** The compiler turns trial criteria into SQL. If that SQL had to know that the lab system keys patients as `MRN0001234` and the EHR as `0001234`, every compiled check would carry the join. With the USL, a check only says `biomarker.gene = 'EGFR' AND biomarker.status = 'detected'`, and the join is defined once.
- **The model never needs schema knowledge of patient systems.** The model writes predicates against ten named tables. That is what lets us keep it away from patient data entirely.
- **Data quality is part of the layer.** The six rules (lab rows that do not resolve to a patient, lab values without units, unresolved medication classes, and so on) run against the same tables the screener reads, so a rule's invalid rows are exactly the rows that would have produced a wrong verdict.
- **One definition for two engines.** Judges can run the whole system without credentials because the same activation SQL also runs in DuckDB. Without a declared semantic layer we would have had two implementations.

## Where it would help a hospital

A cancer center's research office faces the same problem at a larger scale: trial eligibility depends on data in the EHR, the pathology system, the molecular lab, pharmacy and outside records, and each new trial asks for a slightly different combination. A semantic layer that the research office owns, over sources they cannot copy (patient data usually cannot leave its system), lets them write eligibility logic once and run it everywhere.

A project we would expect to benefit: a cancer network with several community sites, each with its own EHR instance. One USL per site with the same table names would let a single set of compiled trial checks run at every site without moving patient data between them. Our estimate is that adding a site would drop from weeks of interface work to days of activation queries, because the trial logic would not change.

## Where it did not help

- Free-text normalisation (report wording, order strings) is awkward in SQL.
- Re-running activation after a model change is manual; we would like the USL to tell us which activated tables are stale.
- Three-valued answers (met, not met, unknown) are the core of our problem, and SQL's NULL handling made us write `CASE` expressions by hand for every check.
