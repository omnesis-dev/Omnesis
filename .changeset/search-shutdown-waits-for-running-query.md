---
"omnesis": patch
---

A gateway stopped while a search was still running no longer aborts with `terminate called after throwing an instance of 'Napi::Error'`. Shutdown now waits for the running search to finish instead of stopping its thread mid-call, drops the searches queued behind it, and finishes the rest of its cleanup meanwhile.
