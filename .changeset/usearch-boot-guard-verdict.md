---
"omnesis": patch
---

A gateway running from source could move a healthy vector index aside on every restart and rebuild it, because its validity check treated any failure to start the check as proof of a corrupt file, and each rebuild left another copy of the index on disk. The check now runs directly under Node instead of through `npx`, and only its explicit verdict or a native crash quarantines the file. At most one quarantined copy is kept and older ones are removed at boot, including on encrypted installs, whose cleanup previously missed them. The shutdown log no longer reports a persisted graph when none was held in memory, and index saves now survive a power loss.
