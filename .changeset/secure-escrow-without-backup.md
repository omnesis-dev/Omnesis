---
"omnesis": patch
---

`omnesis secure` on an install that is already encrypted but has no recovery code yet, such as a Docker install armed with a passphrase file you supplied, now only writes the recovery escrow and prints the code: it no longer takes a pre-migration backup (or restarts the services) for a step that changes no data.
