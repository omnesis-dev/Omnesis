---
"omnesis": patch
---

On macOS the gateway service now runs as a standard service instead of a background job, which macOS gives the lowest CPU priority and throttled disk access. Requests from the apps, the portal, search and agents are answered in milliseconds rather than seconds. The collector stays a background job, so its syncing still gives way to the programs you are using. `omnesis update` rewrites the gateway's LaunchAgent and restarts it under the new setting.
