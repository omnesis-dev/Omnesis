---
"omnesis": patch
---

The installer passes `pair --name` only to a CLI that accepts it. The installer at omnesis.dev is always the newest, while the collector it installs is the newest release, so a collector install could fail at pairing with "Unknown option: --name".
