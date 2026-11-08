---
"@omnesis/gateway": patch
---

Keyword search with a source, type or date filter is ranked by the in-memory index with the filter applied while scoring, instead of ranking unfiltered, joining ever wider windows to `chunks` and finally scoring every match in SQLite. Results are unchanged; a filtered search on a large index takes milliseconds in the keyword stage instead of seconds to minutes. A change to a chunk's source, type or date now reaches the in-memory index.
