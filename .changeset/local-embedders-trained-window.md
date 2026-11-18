---
"omnesis": patch
---

Every local embedding model offered for install now works on long documents. BGE Small, BGE Large, mxbai Embed Large and Multilingual E5 no longer crash the gateway on a chunk longer than 512 tokens: the model reads its first 512 tokens instead. Nomic Embed embeds chunks longer than 512 tokens correctly; until a rebuild, those chunks keep their earlier, less accurate vectors, and every other chunk's vector is unchanged. Switching the embedding model, or stopping the gateway, while the local embedder is busy no longer crashes the gateway.
