---
"omnesis": patch
---

On macOS the gateway service now runs with the priority of an ordinary program instead of as a background job, so requests from the apps, the portal, search and agents no longer wait behind every other program while the Mac is busy. The collector stays a background job. `omnesis update` rewrites the gateway's LaunchAgent and restarts it under the new setting.
