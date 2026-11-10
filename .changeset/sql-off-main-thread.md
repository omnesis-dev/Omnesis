---
"omnesis": patch
---

A query run with `omnesis sql`, or from the portal's SQL view, no longer freezes the gateway while it runs. The query ran on the thread every request, timer and task waits on, so a scan of a large store held up phones, collectors and the portal for seconds; it now runs on a background reader with a database connection of its own, and the gateway keeps answering in the meantime. Results, row limits and refusals are exactly what they were.
