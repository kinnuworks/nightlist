# Evaluation

## What is measured

The compiler turns each eligibility sentence into a check. We measure whether those checks give the right answer, by behaviour:

1. Draw a random sample of real criteria from the 106 screened trials: half from criteria the rules compiled, half from the rest.
2. A separate annotator labels each criterion blind (without seeing compiler output): the predicate it should compile to, or "screening", or "needs a human read". Labeling guidelines: [docs/EVALUATION-GUIDE.md](EVALUATION-GUIDE.md).
3. For every criterion where both sides produced a check, run both against all 240 patients. The compiled check is **exact** when every patient gets the same verdict as the gold label, and **wrong** when at least one patient's met / not met verdict flips.
4. **Overreach** counts criteria we compiled that the gold label says need a human or the screening visit. **Coverage** is the share of gold-checkable criteria we compiled.

## Results (rule compiler only, no model)

| Sample | Compiled | Exact | Wrong | Overreach | Precision (exact) | Precision (no flip) | Coverage | Patient-level flips |
|---|---|---|---|---|---|---|---|---|
| Development (rules tuned on it) | 51 | 48 | 2 | 0 | 94.1% | 96.1% | 71.8% | 4 of 12240 |
| Second sample (rules tuned on it) | 61 | 57 | 2 | 1 | 93.4% | 95.1% | 78.9% | 5 of 14400 |
| **Final test (untouched)** | 80 | 67 | 4 | 8 | 83.8% | 85.0% | 84.7% | 246 of 17280 |

The final test sample shares no criteria with the first two. It was drawn and labeled after the last rule change, and no rule was changed between labeling and scoring. **The final-test row is the number to quote**: on criteria it has never seen, the rule compiler's checks give the gold verdict for every patient 84% of the time, and it compiles 85% of the criteria that can be compiled.

The gap between the first two rows and the final row is the overfitting we expected from tuning rules by hand. It is why every compiled criterion also goes through the Checker (a second model back-translates it and sends disagreements to human review) when Nightshift is online. That second layer is not included in these numbers, because the test was run without the model.

## Every error on the final test

- S003 (exclusion, rule): "Participants with acute, chronic or symptomatic infections including participants positive for active HIV, hepatitis B virus (HBV), or Hepatitis C virus (HCV)."
  - ours: (has hiv OR has hbv OR has hcv)
  - gold: review
- S004 (exclusion, rule): "Participants with any of the following respiratory conditions:; Evidence of noninfectious or drug-induced ILD or pneumonitis; Known DLCO (adjusted for hemoglobi"
  - ours: (has ild OR has pneumonitis)
  - gold: review
- S008 (exclusion, rule): "History of another primary malignancy except for malignancy treated with curative intent with no known active disease ≥ 2 years before the first dose of study i"
  - ours: (has other malignancy active OR has other malignancy history)
  - gold: review
- S009 (exclusion, rule): "Individual with known or suspected uncontrolled central nervous system (CNS) metastases"
  - ours: has brain metastases
  - gold: has active brain metastases
  - flips 18 patients
- S013 (inclusion, rule): "A known epidermal growth factor receptor (EGFR) activating mutation status. \-- Participants with EGFR activating mutations are not eligible"
  - ours: EGFR exon19del/L858R detected
  - gold: EGFR not detected
  - flips 195 patients
- S015 (inclusion, rule): "Received at least 1 and no more than 2 prior systemic lines of therapy for advanced (in the unresectable locally advanced or metastatic setting) NSCLC. Patients"
  - ours: prior metastatic lines >= 1 and <= 2
  - gold: review
- S082 (inclusion, rule): "Pathologic (post-operative) Stage IB, IIA, IIB, or IIIA according to the AJCC 9th tumor nodes metastasis (TNM) staging system for lung cancer. In addition, part"
  - ours: stage group in {III}
  - gold: review
- S087 (inclusion, rule): "Confirmation that the tumor harbors an uncommon epidermal growth factor receptor (EGFR) mutation (tumor tissue biopsy)"
  - ours: EGFR exon19del/L858R detected
  - gold: EGFR other detected
  - flips 10 patients
- S098 (inclusion, rule): "One to two prior lines of therapy including an anti-PD-1/anti-PD(L)-1 agent and platinum-based chemotherapy."
  - ours: prior metastatic lines >= 1 and <= 2
  - gold: prior metastatic lines >= 1 and <= 2 AND has had PD1_PDL1 AND has had PLATINUM
  - flips 23 patients
- S112 (inclusion, rule): "If participants are positive for actionable genomic alteration (AGA), defined as a genomic alteration which has at least 1 regional Health Authority-approved ta"
  - ours: has had PD1_PDL1
  - gold: review
- S118 (exclusion, rule): "Active autoimmune or lung disease requiring systemic therapy"
  - ours: has autoimmune
  - gold: review
- S129 (inclusion, rule): "Histopathological and/or cytopathological confirmation of locally advanced or metastatic NSCLC patients with ≤ 1 prior line of chemotherapy."
  - ours: prior metastatic lines <= 1
  - gold: review

## Fixed after the final test

These were fixed after scoring; the fixes are not reflected in the numbers above.

- "Uncommon EGFR mutation" was read as a common sensitising mutation (the pattern for "common" matched inside "uncommon"). It now compiles to EGFR other.
- An inclusion sentence that says a group is "not eligible" is now left for review instead of compiled as written.

## Reproduce

```bash
npm run eval
```

Files: `data/eval/final-sample.json`, `data/eval/final-gold.json`, `data/eval/final-report.json` (every criterion with both predicates and the number of patients that differ).
