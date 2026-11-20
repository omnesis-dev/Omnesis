---
"@omnesis/platform": patch
---

Give Windows native worker owner verification and compilation one shared initialization deadline capped at 30 seconds and the caller's remaining time. Keep general process-ownership probes capped at ten seconds, preserve exact process identity checks, and deduct initialization and framing time before starting the requested operation.
