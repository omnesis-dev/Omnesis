---
"omnesis": patch
---

The gateway keeps within a memory budget instead of being killed when memory runs out. The budget is `gateway.memoryLimitMb` (or `OMNESIS_MEMORY_LIMIT_MB`) when set, otherwise the container's memory limit, otherwise the host's memory; the analytics engine's default memory ceiling now follows it. The semantic search index stays in memory only while it fits: otherwise search answers from keywords alone, and `omnesis status`, `omnesis doctor` and the gateway log say semantic search is degraded and why. The index is saved as it is built and as it changes, on encrypted installs too, so a gateway that is stopped or killed continues from its last save on the next start instead of building the index again.
