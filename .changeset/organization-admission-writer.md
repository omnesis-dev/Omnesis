---
"omnesis": patch
---

With the experimental Brain on (`OMNESIS_EXPERIMENTAL=1`), starting an organization cohort no longer holds the gateway's writes for seconds on a large corpus. The check that a cohort's sources have no other maintenance in progress walked every maintenance record the Brain had ever made, inside the write that collector syncs, sign-ins and browser captures queue behind; it now looks up each of the cohort's few sources directly, and admission confirms only the retry it selected instead of reviewing every released one.
