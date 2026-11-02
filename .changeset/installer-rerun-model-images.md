---
"omnesis": patch
---

An installer re-run over an existing install keeps the embedding model it already downloaded: it no longer asks again on a terminal, or reports "Model download failed" for a model it already has. And a Docker re-run after one that stopped part way now also removes the release images the containers were still running.
