---
"omnesis": patch
---

Index documents for keyword search when no embedding model is installed or assigned. Enabling an embedding model backfills vectors, including after text changes or deletions while semantic search was disabled, without dropping keyword results.

Keep the search response's embedding model identity current when a model is enabled, replaced, or disabled without restarting the gateway.
