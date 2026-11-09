---
"omnesis": patch
---

`omnesis update` on a source install now refuses before it changes anything when `npm` does not run. Before, an update that a collector or gateway service ran with no `npm` on its `PATH` moved the checkout and failed at `npm ci`. The rollback then failed the same way, and the service did not start again until someone ran `omnesis update` by hand.
