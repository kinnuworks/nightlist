# Demo video script (3 minutes)

Record at 1600×1000 or larger, browser zoom 110%, terminal font 18px or larger. Start the app first with `npm run demo` and `npm start`. Hide `.env` and any tokens before recording.

| Time | Screen | Narration |
|---|---|---|
| 0:00 to 0:15 | Worklist home | "Community cancer clinics enroll about four percent of adult patients in treatment trials. Checking one patient against one trial by hand takes most of an hour. Nightlist does it every night, for every patient and every recruiting lung cancer trial nearby. This is Track 1, Solving Fragmented Intelligence." |
| 0:15 to 0:35 | Worklist: the four numbers, then "What changed overnight" | "This is the coordinator's morning. Overnight, two trials opened and a patient's genetic test came back. Nightlist found 205 new matches, flagged patients who are one data item away from several trials, and set aside 15 lab rows: six filed under a mistyped record number and nine with no unit." |
| 0:35 to 1:05 | Click Gloria Haynes, then her new top trial | "Gloria Haynes had no molecular testing yesterday. Her plasma NGS result arrived last night: EGFR L858R. This morning an EGFR-mutant trial is at the top of her list, marked new." |
| 1:05 to 1:40 | Match page for Dolores Whitfield and NCT07100080; expand the EGFR row | "Every verdict opens to its evidence. This criterion, 'documented EGFR mutation, exon 19 deletion or L858R', was compiled into a check. Here is the SQL the data layer ran, and here is the source row: a report in the lab system, filed under its own MRN format, linked to the EHR patient by the Zetaris semantic layer. The model never saw this row. It only read the trial." |
| 1:40 to 2:05 | Terminal: `npm run night` scrolling the trace | "One overnight run is eight agents. The Guard runs Meterless Scout Intent on the trial text. The Compiler uses rules first, then Nemotron through Nightshift. The Checker back-translates each rule and sends disagreements to a person. The Verifier re-reads the source rows behind every clean match. Every line names the agent and the model that served it." |
| 2:05 to 2:30 | Run page: Systems panel, then data-quality rules, then semantic layer tables | "Zetaris is the data layer: six sources with no shared identifiers, one semantic layer of ten tables, and six data-quality rules that run every night. Meterless World Model is the log behind 'what changed overnight', and H-MEM remembers the coordinator's decisions. All three engines pass the official Meterless test suites." |
| 2:30 to 2:45 | Patient Earline Pruitt: memory panel and set-aside list | "Yesterday the coordinator noted that Earline will not travel more than 100 miles. H-MEM kept that, so tonight 28 distant trials were set aside, with the note and who wrote it." |
| 2:45 to 3:00 | docs/EVALUATION.md, the final-test row | "We measured the compiler on real criteria it had never seen, labeled blind: 84 percent of compiled checks give the right answer for every one of 240 patients. Nightlist never says eligible. It tells the coordinator what was checked, what was not, and what to do next." |

If Nightshift is connected when recording, replace the 1:40 segment with a run where the Compiler and Checker lines show Nemotron model names, and show one Checker "disagree" sending a criterion to review.

Checks before uploading: under 4 minutes, readable text, no keys on screen, link viewable without sign-in.
