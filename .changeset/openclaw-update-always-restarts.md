---
"omnesis": patch
"@omnesis/agent-integration": patch
---

A fleet update of an OpenClaw machine now ends with OpenClaw running the new plugin. Before, OpenClaw's attempt to load the new plugin while it ran could time out waiting for the old plugin to stop, leave OpenClaw unable to serve, and leave the device without an update result until OpenClaw was restarted by hand. `omnesis connect openclaw --refresh` also no longer reports a failed refresh when OpenClaw saved the plugin but could not load it while running; it says the restart loads it.
