---
"omnesis": patch
---

`omnesis update` on a machine without a gateway, such as a collector-only host, no longer warns about the gateway's schema migrations or tells you to back up first: those migrations run, and are backed up, on the gateway's host. A source install's update keeps npm's audit, funding and deprecation notices out of its output; npm's errors still print.
