---
"omnesis": patch
---

A voice note whose audio cannot be decoded is no longer sent to the transcriber on every sync. Its placeholder reads "audio could not be decoded", it is counted apart from the notes waiting for a transcriber, and resyncing the source tries it again. Transcriber outages and other transient failures are still retried as before.
