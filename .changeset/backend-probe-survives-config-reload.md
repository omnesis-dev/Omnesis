---
"omnesis": patch
---

A model backend no longer stays "probing" until the gateway restarts when the configuration changes while the gateway is still checking that backend, for example when a device registers its sources just after startup. The roles assigned to that backend become available once the check succeeds.
