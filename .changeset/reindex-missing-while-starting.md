---
"omnesis": patch
---

`omnesis sources reindex-missing` run while the indexer is still starting, or restarting after an embedding model change, now says to try again in a moment instead of failing with an internal server error. When the indexer failed to start or is switched off, it names the reason.
