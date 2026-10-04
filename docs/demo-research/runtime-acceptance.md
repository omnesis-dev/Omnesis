# Runtime rehearsal acceptance

These results describe live rehearsals against the invented Sacha Bellamy
universe, using the configured Luna agent and real product tools. They are
feasibility evidence, not a claim that every scene is ready to record. The
reference corpus day was 3 October 2026; some replies ran after midnight and
correctly used 4 October as the current day.

Acceptance checks inspect returned SQL rows and successful citation records,
not just the final prose. Rehearsal transcripts are kept outside the repository;
this report intentionally excludes runtime identifiers, credentials and host
locations. No expected-answer ledger was supplied to the model.

| Scene                     | Observed result                                                                                                                                                                                                                         | Status and remaining requirement                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 — residence history   | Four occupancy intervals recovered; actual move on 22 April 2023 distinguished from 1 March lease commencement. Successful evidence annotations include the scanned oldest tenancy and move confirmations.                              | Factual response validated after retry. An external coding host filled the blank DOCX: four residence rows populated, six left blank. ZIP/XML structure checked, opened through LibreOffice and visually inspected after PDF rendering. This is external document writing, not an Omnesis-native DOCX writer.                                                                                 |
| F02 — birthday experience | Small practical darkroom workshop selected from a longstanding wish and later preference. Completed pottery/theatre outings and rejected heights gifts distinguished.                                                                   | Factual response validated. No indexed completion is weaker than proof it never happened. Current availability and booking remain external research.                                                                                                                                                                                                                                          |
| F03 — France location     | Saint-Malo visit recovered for 3 May 2025, 11:10–16:20 local; 1–8 May trip distinguished from exactly four days of car rental. Four annotations succeeded.                                                                              | Factual response validated on warm retry. Eight calendar days/seven nights is a different counting convention from elapsed rental days. Physical Watch/iPhone interaction was not rehearsed here.                                                                                                                                                                                             |
| F04 — sleep change        | Correct SQL groups morning stages back to London bedtime date, excludes awake/in-bed, and returns 14 nights at 450 minutes before versus 14 at 360 after. Change evidence annotations succeeded.                                        | Factual response validated after method correction. Earlier calendar-date grouping was inadequate even though the same means resulted. Association does not establish causality.                                                                                                                                                                                                              |
| F05 — spoken promise      | Actual audio attachment evidence and supporting task/chat annotations yield Tuesday 6 October, 17:30 London, Willow Kiln Studio, paper lantern lights and blue canvas bag.                                                              | Factual response validated after retry. The WAV attachment is genuinely transcribed; source-native transcript fixtures alone would not establish transcription. Audio playback remains a recording check.                                                                                                                                                                                     |
| F06 — warranty            | Purchase date, serial, receipt reference, £249 payment and two-year warranty recovered from scanned receipt, native warranty PDF, order and bank evidence.                                                                              | Factual response and actual receipt OCR validated. An external host assembled and verified a ZIP containing the original receipt/warranty PDFs and the retrieved order/payment evidence. Fault coverage remains subject to the recorded terms.                                                                                                                                                |
| F07 — trip cost           | Correct ledger reconciliation: £1,220 charges − £90 refund − £565 reimbursement = £565. Eight transaction keys receive successful record citations; coverage and cancellation annotations succeed.                                      | Factual response validated after citation correction. Uses booked GBP values; untracked cash and unclassified incidental purchases prevent an all-in spending claim.                                                                                                                                                                                                                          |
| F08 — absent refund       | Correct GBP ledger queried; £84 debit found, no matching credit through 27 September, unrelated £18 refund identified. Five annotations include promise, coverage and control.                                                          | Factual response validated after retry. Conclusion is bounded to the covered account/window, not later settlement or other accounts.                                                                                                                                                                                                                                                          |
| F09 — weekend promise     | Saturday 10 October setup promise at 10:00 recovered despite calendar gap; latest venue/time correction cited.                                                                                                                          | Factual response validated. Calendar silence does not establish complete availability or Maya's availability.                                                                                                                                                                                                                                                                                 |
| F10 — external disclosure | External Answer workflow released useful party logistics with citation; protected household/health/banking follow-up in the same workflow returned a privacy-policy denial.                                                             | Allowed/denied workflow behavior validated. Owner audit inspection confirms the actual Luna reviewer allowed party logistics and denied home address, health measurements, financial information and protected record existence; audit statuses match the external responses. The recorded presentation remains a separate check. A model's refusal alone would not prove policy enforcement. |
| A11 — party departure     | Latest organiser message supersedes stale calendar: 18:15 guest arrival at the revised venue. Both evidence annotations succeed.                                                                                                        | Logistics validated. An external, visibly disclosed route fixture assumes 35 minutes of travel plus 10 minutes of buffer, giving 17:30 departure for 18:15 arrival. Durations are invented; no live Maps, traffic or journey estimate is claimed.                                                                                                                                             |
| A12 — GP page             | Successful source annotations and bedtime-grouped SQL support the symptom/voice timeline, appointment, 14-night 7.5h/6h comparison and final covered bedtime night.                                                                     | Factual response validated after grouping correction. An external host created a printable A4 PDF from the actual answer; one page verified and visually inspected. Earlier awake-inclusive and partial-day totals are rejected.                                                                                                                                                              |
| A13 — next week's tasks   | Correct 5–11 October window, lantern pickup, GP preparation/appointment and message-only setup promise; completed wrapping-paper task omitted. Eight annotations succeed.                                                               | Factual response validated. Completeness is limited to indexed dated commitments.                                                                                                                                                                                                                                                                                                             |
| A14 — loans               | Explicit camera ownership/lending and recent possession acknowledgement recovered; later book and bag returns remove those loans. Maya's negatives excluded because possession does not establish a loan.                               | Factual response validated after ownership correction. Planned return is not a confirmed return; current status remains last explicitly acknowledged possession.                                                                                                                                                                                                                              |
| A15 — absence worksheet   | All six trip windows corroborated by actual arrival/home-return messages. The accepted turn records 21 successful annotations across its initial answer and boundary follow-up; both cancelled reservation distractors remain excluded. | Factual response and revised portable Markdown worksheet validated after follow-up. Previously missing 2019/2022/2024/2025 return evidence is now successfully cited. Refreshed source ingestion confirms the Stockholm reservation was voided before any charge. Exact travel/border-crossing times remain unknown; no official border record or eligibility conclusion.                     |

## Reproducibility and scope

Cold attempts were incomplete for some scenes. Subsequent prompts clarified
the requested method or evidence scope, and warm runs could encounter earlier
rehearsal conversations in the index. Those conversations are labelled generated
context; accepted claims above were checked against source evidence and actual
SQL/citation results. The successful retries demonstrate feasibility, not
independent cold-run reliability. A clean recording rehearsal should verify the
same evidence without relying on prior answers.

After the scenario rehearsals, the task's 26 generated conversations were removed while
preserving all 27,948 original corpus documents. No durable memories remained.
The external disclosure governance audit was retained. This cleanup removes
rehearsal-answer contamination from the delivered corpus; it does not turn the
already observed warm retries into independent cold-run successes.

The corpus is synthetic source-native history. Photo text/tag fixtures supply
analysis fragments and do not demonstrate real image analysis. The image-only
receipt/tenancy PDFs and audio attachments exercise actual extraction paths;
their successful rehearsal evidence is a separate, narrower claim.

Live model rehearsals are not automated correctness tests. Automated tests must
continue to substitute models at production seams and must never invoke chat
inference. Source/fixture tests and artifact structure checks complement these
rehearsals but cannot prove answer quality.

A subsequent clean-index Luna turn called `trace_connections` on the receipt and
warranty PDFs. The production trail returned their original parent emails and
the similar Drive warranty copy; four evidence annotations succeeded. That
additional rehearsal conversation was also removed after verification. The
source-only corpus contains 27,948 indexed documents, 17,209 extracted date
mentions and no documents awaiting date extraction or graph-link extraction.
The authoritative graph backlog observation reports zero with fresh ground truth.
The agent's actual `temporal_query` rehearsal and the production pipeline E2E
check establish both source projections and parsed date-mention retrieval.

Luna establishes factual feasibility. Cerebras has not been rehearsed, and no
recording-model latency guarantee follows from these runs. Final validation
outcome is recorded separately at handoff. Physical recording interactions remain outside
these retrieval and artifact checks.
