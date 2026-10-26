# Compiler evaluation

Sample: 160 real eligibility criteria drawn at random from the screened trials (half from criteria the rules compiled, half from the rest). Gold labels were written blind, without seeing compiler output.

A compiled criterion counts as **exact** when it gives the same verdict as the gold label for all 240 patients, **partial** when the only differences are unknown vs known, and **wrong** when at least one patient's met / not met verdict flips.

| Metric | Value |
|---|---|
| Compiled to a check | 61 |
| Exact | 57 |
| Partial (unknown differences only) | 1 |
| Wrong (a verdict flips) | 2 |
| Compiled but gold says review or screening | 1 |
| Gold says checkable but left for review | 16 |
| Precision, exact | 0.934 |
| Precision, no verdict flip | 0.951 |
| Coverage of checkable criteria | 0.789 |
| Patient-level verdict flips | 5 of 14400 |

## Every wrong or overreaching criterion

- S025 (exclusion, rule): "Previous systemic anti-tumor therapy including:; Prior systemic therapy, including anti-PD-(L)1 therapy, for locally advanced, unresectable, or metastatic NSCLC"
  - ours: has had PD1_PDL1
  - gold: review
- S072 (exclusion, rule): "History of another primary malignancy except for malignancy treated with curative intent with no known active disease ≥ 2 years before the first dose of study i"
  - ours: (has other malignancy active OR has other malignancy history)
  - gold: has other malignancy history
  - flips 2 patients
- S127 (inclusion, rule): "Histologically or cytologically confirmed diagnosis of locally advanced, or metastatic solid tumor (including primary CNS tumors) (Stage IV, American Joint Comm"
  - ours: (ALK fusion detected OR ROS1 fusion detected OR NTRK fusion detected)
  - gold: stage group in {III, IV} AND (ALK fusion detected OR ROS1 fusion detected OR NTRK fusion detected)
  - flips 3 patients
