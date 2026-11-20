---
"@omnesis/platform": patch
---

On Windows, stopping a helper process and its children no longer fails with access denied when the helper was given a process ID that a system process records as its long-gone creator.
