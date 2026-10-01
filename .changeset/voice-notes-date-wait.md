---
"omnesis": patch
---

Date extraction waits for a voice note's gateway transcript — up to `enrichment.dates.pendingContentWaitMs` (1 hour) — so the dates a Tell Omnesis voice note mentions are read from the gateway's words rather than the phone's interim transcript.
