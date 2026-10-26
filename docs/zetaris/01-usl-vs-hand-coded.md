# Did the USL save time compared with hand coding?

Yes, mostly in maintenance more than in first-day typing. This note compares one table both ways and then gives our estimate for the whole layer.

## One table both ways

The `biomarker` table joins the lab system's molecular reports to EHR patients and turns report wording into alterations the screener can compare ("EGFR c.2235_2249del p.E746_A750del (exon 19 deletion)" becomes `exon19del`).

| | USL | Hand coded ([handcoded-biomarker.ts](handcoded-biomarker.ts)) |
|---|---|---|
| Lines | 12 lines of DDL, 23 lines of activation SQL | 56 lines of TypeScript |
| Output on the demo data | 1,637 rows | 1,637 rows, identical keys |
| Schema enforced | Yes, declared types and keys | No, unless we write it |
| Data-quality rules | `REGISTER DQ` on the table, invalid rows listed by `SHOW DQ INVALID RECORD` | Not written; would be another script |
| Where the MRN fix lives | One `REPLACE(m.patient_mrn, 'MRN', '')` in the join, visible to anyone who loads the USL | Inside a map built in application code |
| Who else can query it | Any SQL client on the instance | Only this program |

The line count is the smaller part of the difference. The hand-coded version also needs a CSV parser, and every other consumer of biomarker data (the screener, the verifier, the evidence view, the evaluation harness) would need to import it or repeat it.

## The whole layer

Nightlist's USL has ten tables over six sources. Our estimate for doing the same by hand, based on the comparison above and the time we spent on the USL version:

| Task | USL | Hand coded (estimate) |
|---|---|---|
| Ten table definitions and joins | About 3 hours | About 7 hours |
| Six data-quality rules with invalid-record views | About 30 minutes | About 3 hours |
| Keeping the sample engine and the live engine identical | Generated from one schema file | Two code paths to keep in sync |
| Adding a seventh source | One `CREATE` and one changed activation query | New loader, parser and join code |

These are estimates from one build, not measurements across teams. The clearest saving came from the fact that the screener's generated SQL only ever names USL tables, so changing how a source is joined never touched the screener.

## Where hand coding was still easier

Normalising free-text report wording is easier to read in code than as nested `CASE ... LIKE` expressions. We kept it in SQL so the logic stays in the data layer and every tool sees the same answer, but a user-defined function or a mapping table in the USL would read better (see [03-a-requirement-for-zetaris.md](03-a-requirement-for-zetaris.md)).
