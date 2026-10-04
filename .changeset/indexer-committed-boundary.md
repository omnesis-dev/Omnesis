---
"omnesis": patch
---

Keep documents searchable when ingestion commits while the indexer is paging through the corpus. The indexer retains an inclusive checkpoint from committed document timestamps, and ingestion timestamps each transaction separately.
