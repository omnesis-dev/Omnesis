# @omnesis/platform

## 0.8.1

No changes in this release.

## 0.8.0

### Patch Changes

- a4fa7e8: Give Windows native worker owner verification and compilation one shared initialization deadline capped at 30 seconds and the caller's remaining time. Keep general process-ownership probes capped at ten seconds, preserve exact process identity checks, and deduct initialization and framing time before starting the requested operation.
- 62de3a7: Load Windows PowerShell for native worker owner verification under its own 30-second allowance before an operation starts its deadline, so a slow first load on a freshly started computer no longer refuses the operation. Initialization failures that still exhaust the shared deadline now state how long the owner check and bootstrap took.
- f4950f6: On Windows, stopping a helper process and its children no longer fails with access denied when the helper was given a process ID that a system process records as its long-gone creator.
