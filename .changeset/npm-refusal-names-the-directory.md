---
"omnesis": patch
---

When a source update refuses because `npm` does not run, the message now ends with the directory of the Node running the update and the `PATH` that was searched, so a fleet update's result on the gateway says where to put `npm` on the other machine.
