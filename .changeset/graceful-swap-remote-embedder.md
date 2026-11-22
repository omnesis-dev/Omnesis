---
"omnesis": patch
---

Switching the embedder to a model served by another machine on the network, with `inference.allowRemoteInference` on, now re-embeds the corpus in the background as intended. The re-embed was refused as if remote inference were off, and search stayed on the previous model.
