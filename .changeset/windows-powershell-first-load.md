---
"@omnesis/platform": patch
---

Load Windows PowerShell for native worker owner verification under its own 30-second allowance before an operation starts its deadline, so a slow first load on a freshly started computer no longer refuses the operation. Initialization failures that still exhaust the shared deadline now state how long the owner check and bootstrap took.
