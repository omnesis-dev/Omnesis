---
"omnesis": patch
---

The Brain's daily re-check no longer times out its own verifier calls. A background re-check waits for a free verifier before its 45-second limit starts, a check that gets no answer keeps an unchanged note's verdict, and a note the sweep has queued waits behind the rest of the backlog. A verifier call cancelled before its Codex turn starts no longer runs anyway.
