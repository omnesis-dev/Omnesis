---
"@omnesis/gateway": patch
---

A source's stats (count, size, units, date range on the sources page) are refreshed by a scan of all its documents. A source that is always ingesting was scanned on every refresh tick and the result discarded each time because the source had changed meanwhile, so a large busy source held a read worker for minutes out of every few minutes and never got fresh numbers. A raced scan is now committed with the count reconciled from the writes that landed during it, and a source waits out a cooldown proportional to its last scan before it is scanned again.
