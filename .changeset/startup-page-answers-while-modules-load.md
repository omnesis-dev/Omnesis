---
"omnesis": patch
---

The startup page answers sooner on a gateway's first start after an update from source. Loading the gateway's code held every request for several seconds while its TypeScript was converted; that conversion now happens on a separate thread while the page answers.
