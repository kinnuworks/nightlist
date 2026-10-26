# Compiler evaluation

Sample: 160 real eligibility criteria drawn at random from the screened trials (half from criteria the rules compiled, half from the rest). Gold labels were written blind, without seeing compiler output.

A compiled criterion counts as **exact** when it gives the same verdict as the gold label for all 240 patients, **partial** when the only differences are unknown vs known, and **wrong** when at least one patient's met / not met verdict flips.

| Metric | Value |
|---|---|
| Compiled to a check | 51 |
| Exact | 48 |
| Partial (unknown differences only) | 1 |
| Wrong (a verdict flips) | 2 |
| Compiled but gold says review or screening | 0 |
| Gold says checkable but left for review | 20 |
| Precision, exact | 0.941 |
| Precision, no verdict flip | 0.961 |
| Coverage of checkable criteria | 0.718 |
| Patient-level verdict flips | 4 of 12240 |

## Every wrong or overreaching criterion

- S030 (exclusion, rule): "History of another primary malignancy."
  - ours: (has other malignancy active OR has other malignancy history)
  - gold: has other malignancy history
  - flips 2 patients
- S108 (exclusion, rule): "History of another primary malignancy within 3 years"
  - ours: (has other malignancy active OR has other malignancy history)
  - gold: has other malignancy history
  - flips 2 patients
