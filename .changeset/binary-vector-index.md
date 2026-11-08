---
"omnesis": minor
---

The semantic search index keeps one bit per dimension of each passage's vector and ranks by Hamming distance, then re-ranks what it finds with the full vectors stored in the index database. A graph that held floats took about 3 KB a passage in memory; it now takes about 250 bytes, so a corpus of millions of passages fits a few gigabytes instead of tens, and semantic search comes back on installs where it had degraded to keywords. The graph is rebuilt once from the stored embeddings on the first start after the update; nothing is embedded again.
