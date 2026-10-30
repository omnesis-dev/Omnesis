---
"omnesis": patch
---

`omnesis sources sync --wait` no longer gives up with "Cannot reach gateway" when one status check fails to connect, which a gateway busy indexing the very sync being waited on can cause. It checks again, and reports the gateway as unreachable only after five checks in a row fail to connect. Any other error still ends the wait at once.
