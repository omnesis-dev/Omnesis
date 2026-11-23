---
"omnesis": minor
---

Keyword search now finds Chinese, Japanese, Korean, Russian and other non-Latin words. The first start after this update rebuilds the keyword index in the background, in small batches that give way to your requests; search keeps answering from the existing index until the new one is complete, the keyword index takes up to twice its usual disk space meanwhile, and a restart resumes the rebuild. Once this release has started, an older release cannot write to that index: if an update rolls back, or you move back to an earlier release, deleting a document fails and new documents are not indexed there until you update again or remove `index.db` and `index.usearch` so it rebuilds the search index.
