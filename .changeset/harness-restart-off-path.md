---
"omnesis": patch
---

`omnesis update` now restarts OpenClaw and Hermes when their command is installed outside the PATH the update runs with — as it is for a fleet update started from a background service or an update run over SSH. It looks for the harness where its installer puts it (npm's global prefix, `~/.local/bin`, Homebrew, `/usr/local`) the same way the harness plugin's own self-update does.
