---
"omnesis": patch
---

The gateway, collector, CLI and their workers no longer trust root certificates that Mozilla has removed but Node.js still bundles, starting with the emSign roots NSS 3.131.1 dropped. The npm runs started by the installer, `omnesis update` and the Codex runtime install do not trust them either, and an OpenClaw connection that verifies the gateway by name leaves them out.
