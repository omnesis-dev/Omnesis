---
"omnesis": patch
---

Keyword search ranks before reading rows and, once the gateway has built an in-memory copy of the full-text index, ranks in milliseconds. Searches that took seconds for queries with common words now answer in tens of milliseconds, with the same results. The in-memory index uses memory in proportion to the corpus and is rebuilt in the background as it changes; set `search.bm25.memoryIndex` to `false` to rank from disk only. Type-ahead suggestions complete a half-typed last word correctly, and the browser extension's omnibox shows six suggestions.
