# Compiler evaluation

Sample: 160 real eligibility criteria drawn at random from the screened trials (half from criteria the rules compiled, half from the rest). Gold labels were written blind, without seeing compiler output.

A compiled criterion counts as **exact** when it gives the same verdict as the gold label for all 240 patients, **partial** when the only differences are unknown vs known, and **wrong** when at least one patient's met / not met verdict flips.

| Metric | Value |
|---|---|
| Compiled to a check | 80 |
| Exact | 67 |
| Partial (unknown differences only) | 1 |
| Wrong (a verdict flips) | 4 |
| Compiled but gold says review or screening | 8 |
| Gold says checkable but left for review | 13 |
| Precision, exact | 0.838 |
| Precision, no verdict flip | 0.85 |
| Coverage of checkable criteria | 0.847 |
| Patient-level verdict flips | 246 of 17280 |

## Every wrong or overreaching criterion

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
