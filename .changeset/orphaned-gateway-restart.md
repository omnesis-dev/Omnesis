---
"omnesis": patch
---

On macOS, a source-installed gateway whose launcher died no longer holds its configuration directory against the service. launchd runs the gateway under `tsx`; when `tsx` went away and the gateway did not, launchd started a replacement that waited on the old gateway's lock, gave up and was restarted, over and over, while every `omnesis service restart` and the restart in `omnesis update` reached only the replacement — an update then timed out waiting for the new version and rolled back. The gateway now stops when its launcher is gone so the service's replacement takes over, and restarting, stopping or reinstalling the gateway service first stops a gateway the service left behind this way.
