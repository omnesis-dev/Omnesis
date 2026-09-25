---
"omnesis": patch
---

`omnesis update` now refreshes the OpenClaw and Hermes plugins when `omnesis` is not on the PATH the update runs with — as it is not for an installer-managed install updated over SSH, from a background service, or by the portal's fleet update. The refresh runs the CLI the update just installed by its path, so the harness restart that follows it is no longer skipped.
