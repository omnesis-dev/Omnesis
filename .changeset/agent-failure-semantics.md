---
"omnesis": patch
---

Background agent work now waits out problems you fix on the gateway host instead of giving it up: a signed-out, missing or outdated Claude Code, a model the backend does not offer, invalid reasoning controls, or a model server whose context length cut the prompt short. The Brain pauses with the reason shown until you fix it, then carries on with nothing lost. An answer an OpenAI-compatible server stops early, for example on a content filter or an aborted generation, now fails the turn instead of being kept as complete, and Claude Code reports a too-long prompt and a reached output limit the same way the other backends do.
