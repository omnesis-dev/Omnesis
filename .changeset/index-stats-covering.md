---
"@omnesis/gateway": patch
---

The per-source index stats the status page shows are computed from a covering index on `chunks` instead of a scan of every chunk row, so refreshing them after an indexing cycle no longer holds the indexer worker (and the query embeds it answers) for minutes on a large index. The index is built once when an existing index database is opened; the gateway logs the build.
