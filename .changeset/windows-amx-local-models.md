---
"@omnesis/gateway": patch
---

On Windows with an Intel CPU that has AMX, the gateway no longer crashes with a heap corruption error (0xC0000374) when it unloads a local model: after the local decision or completion model's idle timeout, or when swapping or rebuilding with another local embedding model. llama.cpp cannot free a model on such a host, so the gateway keeps each local model it has loaded until it restarts, reuses that copy when the same model is loaded again, and logs this once. Shutting down now completes, closing every store first, but the process can still end with that status as it exits, because Node frees the local embedding model when it ends the thread that holds it.
