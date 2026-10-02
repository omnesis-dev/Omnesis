---
"omnesis": patch
---

`omnesis connect openclaw` works with OpenClaw 2026.9.6 again. That release reports a missing legacy `omnesis-bridge` plugin in new words, which connect took for a real failure and stopped. When OpenClaw instead finds an `omnesis-bridge` copy it did not install and refuses to remove it, connect now says how to find and delete that copy before running it again.
