---
"omnesis": patch
---

`omnesis connect hermes` accepts Hermes's default background process notification mode, `concise`, which Hermes's installer writes since v0.21. It reports every finished background process, so a completed approval still wakes the agent; only `error` and `off` are still refused.
