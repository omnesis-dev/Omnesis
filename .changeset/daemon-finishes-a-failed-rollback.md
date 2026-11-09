---
"omnesis": patch
---

A source install whose update failed and could not roll back no longer stays down until someone runs `omnesis update` on it. When a service manager starts the gateway or collector over such an install and no update is running, the launcher restores the last completed release (its commit, dependencies and build) and the daemon starts on the release it ran before. A restore that fails is tried again no sooner than 15 minutes later. Other commands are still refused until the install is repaired, and the update itself is not applied again.
