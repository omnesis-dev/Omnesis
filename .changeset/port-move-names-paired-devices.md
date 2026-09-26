---
"omnesis": patch
---

Re-running the installer with `--port` on an installed gateway now names every device paired from another machine before it moves the port, since each one still dials the old port, and the closing banner prints what points each at the new one: for a collector, a repair code and the installer line that registers its service on the new address. `omnesis devices list --json` prints the device list for scripts, and `omnesis devices repair` on a collector says how to redeem the code when the gateway has moved.
