---
"omnesis": patch
---

On a Docker host that only collects, `omnesis update` now records the update as finished once the collector restarts on the new image. Before, every later `omnesis update` warned that the previous update did not finish and pulled and recreated the collector again.
