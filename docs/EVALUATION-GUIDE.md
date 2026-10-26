# Labeling guide used for the gold sets

Annotators saw only the sample file (criterion text and whether it is an inclusion or exclusion criterion). They never saw compiler output, run data or source code.

For each criterion they chose one category:

- **check**: the main requirement can be written in the predicate language (see `server/src/dsl.ts`). Minor qualifiers the language cannot express (time windows, documentation or assay requirements, liver-metastasis exceptions) are allowed and listed as omitted.
- **screening**: confirmed at the screening visit rather than from records (consent, contraception, pregnancy tests, washouts before first dose, ability to swallow, tissue submission, willingness, other trial participation).
- **review**: needs information the language cannot express, applies only to a specific cohort, part or arm, or concerns a different cancer.

Rules applied throughout: an exclusion predicate describes the excluding condition (it is not negated); "no known X" is written as NOT(X detected) so untested patients are not ruled out; when torn between a loose predicate and review, choose review.

The final-test annotator received the same guide with three clarifications written before labeling began: "advanced or metastatic" means stage III or IV, eGFR is kidney function (creatinine clearance), and "no known X" uses NOT(detected). The development and second samples were labeled before these clarifications.
