---
"omnesis": patch
---

Search under load no longer answers from a stale index. When more searches arrive than the search workers admit, the overflow runs on the gateway's main thread, which read a snapshot refreshed only every ten minutes, so documents indexed since the last refresh were missing from those answers and the same query could return different results depending on load. The main thread now reads the current index whenever search workers are on; `search.snapshot` applies only when they are disabled.
