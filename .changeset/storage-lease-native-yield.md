---
"@omnesis/gateway": patch
---

Keep semantic search startup from repeatedly pausing after a long native graph check. Completed graph checks now process queued capacity updates before checking the storage lease; blocked or unverified capacity continues to pause growth.
