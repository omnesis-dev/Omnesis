---
"omnesis": patch
---

`omnesis sources sync --wait` no longer times out on a sync that finished before it looked. A small sync can complete between two of its once-a-second checks, and a source that was already syncing (`Sync skipped; … was already syncing`) can finish before the first one. Either way the wait never saw the source syncing, ignored the finished run, waited out its whole timeout and failed. It now also accepts a run the gateway records as finished, or failed, after the command was given.
