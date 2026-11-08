---
"omnesis": patch
---

Notion databases with a text property named like a date property's derived column ("Date Start" beside "Date") sync again instead of failing on a duplicate `date_start` column; databases without a collision keep their column names. A nested block Notion will not read renders without its children instead of stopping the sync, and a page deleted between search and fetch is skipped for the run. The gateway now refuses an analytics schema that declares a column twice, and a collector discards a stored page the gateway refuses as invalid while its cursor is uncommitted, so such a page no longer keeps a source failing forever.
