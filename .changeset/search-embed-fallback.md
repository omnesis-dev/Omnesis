---
"@omnesis/gateway": patch
---

A search whose query embedding fails (for example, an embed that times out while the indexer worker is busy) now answers off keywords alone and names the failure as the vector stage's skip reason, instead of failing with an internal error. The next search embeds again.
