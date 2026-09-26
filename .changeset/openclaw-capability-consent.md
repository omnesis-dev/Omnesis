---
"omnesis": patch
---

`omnesis connect openclaw` works again on OpenClaw 2026.8.1 and later, which refuse to install a plugin that declares capabilities until the installer accepts them. Connecting OpenClaw is the request to install the Omnesis plugin, so `connect` now accepts that plugin's declared capabilities and prints a line saying so; `connect --refresh`, `omnesis update` and a fleet update of the agent machine do the same. OpenClaw releases before 2026.8.1 are detected and installed as before. The OpenClaw release the integration is checked against is now 2026.9.2, which also drops the outdated HTTP-server libraries the previous one carried.
