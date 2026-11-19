---
"omnesis": patch
---

The gateway prepares its database far faster on every start. Each start rebuilt the index that finds the same attachment saved in two places, which reads every document in full, and re-checked every recorded Brain decision against the source it read. The index is now rebuilt only when it is missing or out of date, and the database records each decision's source as the decision is saved, so the history is checked once, on the first start after the update.
