---
"omnesis": patch
---

Deleting a document, or excluding a domain in the browser extension and removing its captured pages, no longer fails now and then with an internal server error while the gateway is indexing new documents. The deletion now waits for the indexer's write to finish. Indexing no longer fails on a document when a deletion lands at the same moment.
