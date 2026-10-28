---
"omnesis": patch
---

Mixed versions with 0.6.0: a 0.7.0 gateway keeps serving 0.6.0 iOS and Android apps, the 0.6.0 Chrome extension, 0.6.0 OpenClaw and Hermes plugins and MCP clients, and 0.7.0 clients keep working against a 0.6.0 gateway, without the features new in 0.7.0. A 0.6.0 app shows the new agent tools as generic tool cards. A 0.6.0 plugin trusts the gateway's exact certificate, so it must be reconnected with `omnesis connect <harness> --refresh` after the gateway renews it; the portal and `omnesis doctor` name it before the renewal. A 0.6.0 configuration still boots: a `brain.workerConcurrency` above 32 runs as 32, and an HTTP backend named `claude-code` keeps serving its assignments.
