---
"omnesis": patch
---

A collector syncing right after the gateway restarts no longer fails with "Storage capacity cannot be verified". The gateway now opens for requests only once it has measured its storage capacity, and a capacity measurement that fails is retried a second later instead of pausing sync until the next scheduled measurement.
